import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { planComment, upsertTokenCostComment } from "./token-cost-comment.mjs";

const TOKENS = { total_tokens: 100, tools: [{ name: "a", tokens: 100 }] };
const VIEWS = { view_count: 1, views: [{ uri: "ui://chart", raw_bytes: 10 }] };
const REPORT = "## 📊 MCP Server Token Cost Report\n";

test("skips when tools and views match main", () => {
  assert.equal(
    planComment({ current: [TOKENS, VIEWS], main: [TOKENS, VIEWS] }),
    "none",
  );
});

test("creates a comment when the tool definitions differ from main", () => {
  const changed = { total_tokens: 100, tools: [{ name: "b", tokens: 100 }] };
  assert.equal(
    planComment({ current: [changed, VIEWS], main: [TOKENS, VIEWS] }),
    "create",
  );
});

test("creates a comment when only a view differs from main", () => {
  const changed = { ...VIEWS, views: [{ uri: "ui://chart", raw_bytes: 11 }] };
  assert.equal(
    planComment({ current: [TOKENS, changed], main: [TOKENS, VIEWS] }),
    "create",
  );
});

test("skips without main's stats to compare against", () => {
  assert.equal(
    planComment({ current: [TOKENS, VIEWS], main: undefined }),
    "none",
  );
  assert.equal(
    planComment({ current: [TOKENS, VIEWS], main: [undefined, undefined] }),
    "none",
  );
});

test("updates an existing comment even when nothing differs", () => {
  assert.equal(
    planComment({
      current: [TOKENS, VIEWS],
      main: [TOKENS, VIEWS],
      existingCommentId: 7,
    }),
    "update",
  );
});

let workdir;
const startDir = process.cwd();

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "token-cost-comment-"));
  process.chdir(workdir);
  mkdirSync("packages/mcp-core", { recursive: true });
  writeFileSync("packages/mcp-core/token-report.md", REPORT);
});

afterEach(() => {
  process.chdir(startDir);
  rmSync(workdir, { recursive: true, force: true });
});

function writeStats(dir, tokens, views) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/token-stats.json`, JSON.stringify(tokens));
  writeFileSync(`${dir}/ui-stats.json`, JSON.stringify(views));
}

function fakeGithub(comments) {
  const calls = [];
  const record = (name) => async (args) => {
    calls.push([name, args]);
  };
  return {
    calls,
    paginate: async (method, args) => {
      calls.push(["listComments", args]);
      return comments;
    },
    rest: {
      issues: {
        listComments: () => {},
        createComment: record("createComment"),
        updateComment: record("updateComment"),
      },
    },
  };
}

const context = {
  repo: { owner: "getsentry", repo: "toolkit" },
  issue: { number: 5 },
};
const core = { info: () => {} };

test("posts nothing on a PR that does not change the MCP surface", async () => {
  writeStats("packages/mcp-core", TOKENS, VIEWS);
  writeStats("main-stats", TOKENS, VIEWS);
  const github = fakeGithub([]);

  await upsertTokenCostComment({ github, context, core });

  assert.deepEqual(
    github.calls.map(([name]) => name),
    ["listComments"],
  );
});

test("creates the comment when the MCP surface changed", async () => {
  writeStats("packages/mcp-core", { ...TOKENS, total_tokens: 120 }, VIEWS);
  writeStats("main-stats", TOKENS, VIEWS);
  const github = fakeGithub([{ id: 1, user: { type: "User" }, body: REPORT }]);

  await upsertTokenCostComment({ github, context, core });

  assert.deepEqual(github.calls.at(-1), [
    "createComment",
    { owner: "getsentry", repo: "toolkit", issue_number: 5, body: REPORT },
  ]);
});

test("updates the bot's existing comment", async () => {
  writeStats("packages/mcp-core", TOKENS, VIEWS);
  writeStats("main-stats", TOKENS, VIEWS);
  const github = fakeGithub([{ id: 9, user: { type: "Bot" }, body: REPORT }]);

  await upsertTokenCostComment({ github, context, core });

  assert.deepEqual(github.calls.at(-1), [
    "updateComment",
    { owner: "getsentry", repo: "toolkit", comment_id: 9, body: REPORT },
  ]);
});
