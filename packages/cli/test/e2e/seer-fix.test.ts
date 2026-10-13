/**
 * Subprocess coverage for resumable Seer fixes. The local API fixtures follow
 * Sentry's interactive explorer chat/update endpoint contracts.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ExplorerFilePatch } from "../../src/types/seer-fix.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createE2EContext,
  type E2EContext,
  getCliCommand,
  type CliResult,
} from "../fixture.js";
import issueFixture from "../fixtures/issue.json";
import { useTestConfigDir } from "../helpers.js";
import {
  apiRoutes,
  TEST_ISSUE_ID,
  TEST_ORG,
  TEST_TOKEN,
} from "../mocks/routes.js";
import {
  createMockServer,
  type MockResponse,
  type MockRoute,
  type MockServer,
  type RouteHandler,
} from "../mocks/server.js";

const RUN_ID = "b8781a24-930f-4d50-b9cb-ef460b471cef";
const OTHER_RUN_ID = "5a1e12bc-027d-4c92-8345-03e7dfd2a0ba";
const ISSUE = `${TEST_ORG}/${TEST_ISSUE_ID}`;
const AUTOFIX = `/api/0/organizations/${TEST_ORG}/issues/${TEST_ISSUE_ID}/autofix/`;
const CHAT = `/api/0/organizations/${TEST_ORG}/seer/explorer-chat/:runId/`;
const START = `/api/0/organizations/${TEST_ORG}/seer/explorer-chat/`;
const UPDATE = `/api/0/organizations/${TEST_ORG}/seer/explorer-update/:runId/`;
const QUESTION = {
  id: "question-1",
  input_type: "ask_user_question",
  data: {
    questions: [
      {
        question: "How should missing users be handled?",
        options: [
          { label: "Return null", description: "Preserve the existing API" },
        ],
      },
    ],
  },
};
const PATCH: ExplorerFilePatch = {
  repo_name: "example/backend",
  code_url: null,
  diff: "--- a/users.ts\n+++ b/users.ts\n@@ -1 +1 @@\n-return user.name;\n+return user?.name;\n",
  patch: {
    added: 1,
    removed: 1,
    hunks: [
      {
        source_start: 1,
        source_length: 1,
        target_start: 1,
        target_length: 1,
        section_header: "",
        lines: [
          {
            line_type: "-",
            value: "return user.name;",
            source_line_no: 1,
            target_line_no: null,
            diff_line_no: 1,
          },
          {
            line_type: "+",
            value: "return user?.name;",
            source_line_no: null,
            target_line_no: 1,
            diff_line_no: 2,
          },
        ],
      },
    ],
    path: "users.ts",
    source_file: "users.ts",
    target_file: "users.ts",
    type: "M",
  },
};

type RecordedRequest = { method: string; path: string; body: unknown };
type Session = {
  status: string;
  updated_at: string;
  pending_user_input:
    | typeof QUESTION
    | { id: string; input_type: string; data: Record<string, unknown> }
    | null;
  blocks: unknown[];
  repo_pr_states: Record<string, unknown>;
};

/** Produce a complete explorer session envelope using the backend's wire names. */
function session(
  status: string,
  pending: Session["pending_user_input"] = null,
): Session {
  return {
    status,
    updated_at: "2026-10-13T12:00:00Z",
    pending_user_input: pending,
    blocks: [],
    repo_pr_states: {},
  };
}

const getConfigDir = useTestConfigDir("e2e-seer-fix-");
let mockServer: MockServer;
let ctx: E2EContext;
let requests: RecordedRequest[];
let currentAutofix: unknown;
let activeSession: Session;
let chatHandler: RouteHandler;
let startResponse: MockResponse;
let updateResponse: MockResponse;

/** Record both custom Seer routes and shared auth/issue fixture requests. */
function recordRoute(route: MockRoute): MockRoute {
  return {
    ...route,
    response: async (
      req: Request,
      params: Record<string, string>,
      serverUrl: string,
    ) => {
      const url = new URL(req.url);
      requests.push({
        method: req.method,
        path: url.pathname,
        body: req.method === "GET" ? null : await req.clone().json(),
      });
      return typeof route.response === "function"
        ? (route.response as RouteHandler)(req, params, serverUrl)
        : { status: route.status, body: route.response };
    },
  };
}

beforeEach(async () => {
  requests = [];
  currentAutofix = null;
  activeSession = session("awaiting_user_input", QUESTION);
  startResponse = { status: 202, body: { run_id: 72, sentry_run_id: RUN_ID } };
  updateResponse = { status: 202, body: { success: true } };
  chatHandler = () => ({
    body: { session: activeSession, sentry_run_id: RUN_ID },
  });
  const routes: MockRoute[] = [
    {
      method: "GET",
      path: `/api/0/organizations/${TEST_ORG}/issues/${TEST_ISSUE_ID}/`,
      response: issueFixture,
    },
    {
      method: "GET",
      path: AUTOFIX,
      response: () => ({ body: { autofix: currentAutofix } }),
    },
    { method: "POST", path: START, response: () => startResponse },
    {
      method: "GET",
      path: CHAT,
      response: (req, params, url) => chatHandler(req, params, url),
    },
    { method: "POST", path: UPDATE, response: () => updateResponse },
    ...apiRoutes,
  ];
  mockServer = createMockServer(routes.map(recordRoute), {
    validTokens: [TEST_TOKEN],
  });
  await mockServer.start();
  ctx = createE2EContext(getConfigDir(), mockServer.url);
  await ctx.setAuthToken(TEST_TOKEN);
});

afterEach(() => mockServer.stop());

/** Return only mutations so the tests enforce no unintended or duplicate POST. */
function mutations(): RecordedRequest[] {
  return requests.filter((req) => req.method === "POST");
}

/** Write a response file inside the test's automatically cleaned config directory. */
async function responseFile(value: unknown): Promise<string> {
  const path = join(getConfigDir(), "response.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

/** Run source or bundled CLI from a real checkout rather than the CLI package. */
async function runInCheckout(cwd: string, args: string[]): Promise<CliResult> {
  const cliDir = join(import.meta.dirname, "../..");
  const [bin, ...commandArgs] = getCliCommand();
  const require = createRequire(import.meta.url);
  const resolvedArgs = process.env.SENTRY_CLI_BINARY
    ? commandArgs
    : commandArgs.map((arg) => {
        if (arg === "tsx") {
          return require.resolve("tsx");
        }
        return arg.startsWith("./") || arg === "src/bin.ts"
          ? join(cliDir, arg)
          : arg;
      });
  const proc = spawn(bin, [...resolvedArgs, ...args], {
    cwd,
    env: {
      ...process.env,
      SENTRY_AUTH_TOKEN: "",
      SENTRY_TOKEN: "",
      SENTRY_CONFIG_DIR: getConfigDir(),
      SENTRY_URL: mockServer.url,
      SENTRY_CLI_NO_TELEMETRY: "1",
      SENTRY_CLI_NO_UPDATE_CHECK: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code) => resolve(code ?? 1));
  });
  return { stdout, stderr, exitCode };
}

/** Create an isolated matching Git repo; useTestConfigDir removes it after the test. */
async function checkout(
  remote = "https://github.com/example/backend.git",
): Promise<string> {
  const cwd = join(getConfigDir(), "checkout");
  await mkdir(cwd);
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  git(["init"]);
  git(["config", "core.autocrlf", "false"]);
  git(["remote", "add", "origin", remote]);
  await writeFile(join(cwd, "users.ts"), "return user.name;\n", "utf8");
  await writeFile(join(cwd, "remove.txt"), "remove\n", "utf8");
  await writeFile(join(cwd, "unrelated.txt"), "baseline\n", "utf8");
  git(["add", "."]);
  git([
    "-c",
    "user.name=Seer E2E",
    "-c",
    "user.email=seer-e2e@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=",
    "commit",
    "-m",
    "fixture baseline",
  ]);
  return cwd;
}

/** Use real backend-shaped patches in completed explorer blocks. */
function completed(patches: ExplorerFilePatch[] = [PATCH]): Session {
  return {
    ...session("completed"),
    blocks: [
      {
        id: "delivery-patches",
        message: { role: "assistant", content: "Fix ready" },
        merged_file_patches: patches,
      },
    ],
  };
}

const ADDED_PATCH: ExplorerFilePatch = {
  repo_name: "example/backend",
  code_url: null,
  diff: "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n",
  patch: {
    added: 1,
    removed: 0,
    path: "new.txt",
    source_file: "/dev/null",
    target_file: "b/new.txt",
    type: "A",
    hunks: [
      {
        source_start: 0,
        source_length: 0,
        target_start: 1,
        target_length: 1,
        section_header: "",
        lines: [
          {
            line_type: "+",
            value: "new",
            source_line_no: null,
            target_line_no: 1,
            diff_line_no: 1,
          },
        ],
      },
    ],
  },
};
const DELETED_PATCH: ExplorerFilePatch = {
  repo_name: "example/backend",
  code_url: null,
  diff: "diff --git a/remove.txt b/remove.txt\ndeleted file mode 100644\n--- a/remove.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-remove\n",
  patch: {
    added: 0,
    removed: 1,
    path: "remove.txt",
    source_file: "a/remove.txt",
    target_file: "/dev/null",
    type: "D",
    hunks: [
      {
        source_start: 1,
        source_length: 1,
        target_start: 0,
        target_length: 0,
        section_header: "",
        lines: [
          {
            line_type: "-",
            value: "remove",
            source_line_no: 1,
            target_line_no: null,
            diff_line_no: 1,
          },
        ],
      },
    ],
  },
};

describe("sentry issue fix", () => {
  test("starts coding and returns one JSON question result pinned to the UUID", async () => {
    const result = await ctx.run([
      "issue",
      "fix",
      ISSUE,
      "--json",
      "--instruction",
      "Keep the API compatible",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      run_id: RUN_ID,
      status: "WAITING_FOR_USER_RESPONSE",
      pending_user_input: QUESTION,
      patches: [],
      pr_urls: [],
    });
    expect(JSON.parse(result.stdout).next_action).toContain(RUN_ID);
    expect(JSON.parse(result.stdout).next_action).toContain("--response");
    expect(mutations()).toEqual([
      {
        method: "POST",
        path: START,
        body: {
          query: expect.stringContaining("Keep the API compatible"),
          on_page_context: expect.stringContaining(`Sentry issue: ${ISSUE}`),
        },
      },
    ]);
    expect(mutations()[0]?.body).toMatchObject({
      query: expect.stringContaining(ISSUE),
    });
    expect(mutations()[0]?.body).toMatchObject({
      query: expect.stringMatching(/do not create pull requests/i),
    });
    expect(requests.filter((req) => req.path === AUTOFIX)).toEqual([]);
    expect(
      requests.some((req) => req.path.endsWith(`/explorer-chat/${RUN_ID}/`)),
    ).toBe(true);
    expect(result.stdout).not.toContain(TEST_TOKEN);
  });

  test("resumes the requested run, submits a wrapped response once and returns completed diffs", async () => {
    const path = await responseFile({
      input_id: QUESTION.id,
      response_data: { answers: ["Return null"] },
    });
    chatHandler = () => ({
      body: {
        session: mutations().length
          ? {
              ...session("completed"),
              blocks: [
                {
                  id: "patch-1",
                  timestamp: "2026-10-13T12:00:00Z",
                  message: { role: "assistant", content: "Fix ready" },
                  merged_file_patches: [PATCH],
                },
              ],
              repo_pr_states: {
                "example/backend": {
                  repo_name: "example/backend",
                  pr_url: "https://github.com/example/backend/pull/42",
                  pr_creation_status: "completed",
                },
              },
            }
          : activeSession,
        sentry_run_id: RUN_ID,
      },
    });

    const result = await ctx.run([
      "issue",
      "fix",
      ISSUE,
      "--run-id",
      RUN_ID,
      "--response",
      path,
      "--json",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      run_id: RUN_ID,
      status: "COMPLETED",
      pending_user_input: null,
      patches: [PATCH],
      pr_urls: ["https://github.com/example/backend/pull/42"],
    });
    expect(mutations()).toEqual([
      {
        method: "POST",
        path: UPDATE.replace(":runId", RUN_ID),
        body: {
          payload: {
            type: "user_input_response",
            input_id: QUESTION.id,
            response_data: { answers: ["Return null"] },
          },
        },
      },
    ]);
    expect(requests.filter((req) => req.path === AUTOFIX)).toEqual([]);
    expect(
      requests
        .filter((req) => req.path.includes("explorer-chat/"))
        .every((req) => req.path.endsWith(`/${RUN_ID}/`)),
    ).toBe(true);
  });

  test("resumes an explicitly selected completed run without starting a new one", async () => {
    activeSession = {
      ...session("completed"),
      blocks: [
        {
          id: "existing-patch",
          message: { role: "assistant", content: "Existing fix" },
          file_patches: [PATCH],
        },
      ],
    };
    chatHandler = () => ({
      body: { session: activeSession, sentry_run_id: OTHER_RUN_ID },
    });

    const result = await ctx.run([
      "issue",
      "fix",
      ISSUE,
      "--run-id",
      OTHER_RUN_ID,
      "--json",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).run_id).toBe(OTHER_RUN_ID);
    expect(JSON.parse(result.stdout).patches).toEqual([PATCH]);
    expect(mutations()).toEqual([]);
    expect(requests.filter((req) => req.path === AUTOFIX)).toEqual([]);
  });

  test("starts a new interactive fix without consulting the issue's earlier autofix run", async () => {
    currentAutofix = {
      run_id: 73,
      sentry_run_id: OTHER_RUN_ID,
      status: "completed",
      blocks: [],
    };
    const result = await ctx.run(["issue", "fix", ISSUE, "--json"]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).run_id).toBe(RUN_ID);
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0]?.path).toBe(START);
    expect(requests.filter((req) => req.path === AUTOFIX)).toEqual([]);
  });

  test("does not replay a submitted answer when the same pending input is still visible", async () => {
    const path = await responseFile({
      input_id: QUESTION.id,
      response_data: { answers: ["Return null"] },
    });
    const result = await ctx.run([
      "issue",
      "fix",
      ISSUE,
      "--run-id",
      RUN_ID,
      "--response",
      path,
      "--timeout",
      "1",
      "--json",
    ]);

    expect(JSON.parse(result.stdout)).toMatchObject({
      run_id: RUN_ID,
      pending_user_input: QUESTION,
    });
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0]?.path).toBe(UPDATE.replace(":runId", RUN_ID));
  });

  test.each([
    { input_id: "stale-question", response_data: { answers: ["Return null"] } },
    { input_id: QUESTION.id, response_data: { decisions: [true] } },
  ])(
    "rejects stale or wrong-kind answers before any mutation: %j",
    async (answer) => {
      const path = await responseFile(answer);
      const result = await ctx.run([
        "issue",
        "fix",
        ISSUE,
        "--run-id",
        RUN_ID,
        "--response",
        path,
        "--json",
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr + result.stdout).toMatch(
        /pending|response|input|answer/i,
      );
      expect(mutations()).toEqual([]);
    },
  );

  test("rejects malformed response files and response without run ID", async () => {
    const path = join(getConfigDir(), "malformed.json");
    await writeFile(path, "{not json", "utf8");
    const malformed = await ctx.run([
      "issue",
      "fix",
      ISSUE,
      "--run-id",
      RUN_ID,
      "--response",
      path,
      "--json",
    ]);
    const noRun = await ctx.run([
      "issue",
      "fix",
      ISSUE,
      "--response",
      path,
      "--json",
    ]);

    expect(malformed.exitCode).not.toBe(0);
    expect(noRun.exitCode).not.toBe(0);
    expect(noRun.stderr + noRun.stdout).toMatch(/run-id/i);
    expect(mutations()).toEqual([]);
  });

  test("pauses unknown approvals without submitting an automatic approval", async () => {
    activeSession = session("awaiting_user_input", {
      id: "approval-1",
      input_type: "future_approval",
      data: { action: "write" },
    });
    const result = await ctx.run([
      "issue",
      "fix",
      ISSUE,
      "--run-id",
      RUN_ID,
      "--json",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      run_id: RUN_ID,
      status: "WAITING_FOR_USER_RESPONSE",
      pending_user_input: activeSession.pending_user_input,
    });
    expect(mutations()).toEqual([]);
  });

  test("non-TTY human output pauses with the run ID and previews completed diffs", async () => {
    const paused = await ctx.run(["issue", "fix", ISSUE, "--run-id", RUN_ID]);
    expect(paused.exitCode, paused.stderr).toBe(0);
    expect(paused.stdout + paused.stderr).toContain(RUN_ID);
    expect(mutations()).toEqual([]);

    activeSession = {
      ...session("completed"),
      blocks: [
        {
          id: "patch-1",
          timestamp: "2026-10-13T12:00:00Z",
          message: { role: "assistant", content: "Fix ready" },
          file_patches: [PATCH],
        },
      ],
    };
    const completed = await ctx.run([
      "issue",
      "fix",
      ISSUE,
      "--run-id",
      RUN_ID,
      "--fresh",
    ]);
    expect(completed.exitCode, completed.stderr).toBe(0);
    expect(completed.stdout).toContain("users.ts");
    expect(completed.stdout).toContain("return user?.name;");
    expect(mutations()).toEqual([]);
  });

  test("bounds processing timeout and keeps the run ID available for resumption", async () => {
    activeSession = session("processing");
    const started = Date.now();
    const result = await ctx.run([
      "issue",
      "fix",
      ISSUE,
      "--run-id",
      RUN_ID,
      "--timeout",
      "1",
      "--json",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      run_id: RUN_ID,
      status: "TIMEOUT",
      patches: [],
      pr_urls: [],
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(mutations()).toEqual([]);
  });

  test("surfaces coding access errors without retrying the start mutation", async () => {
    startResponse = {
      status: 403,
      body: { detail: "Code generation is disabled for this organization" },
    };
    const result = await ctx.run(["issue", "fix", ISSUE, "--json"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(
      /disabled|permission|access/i,
    );
    expect(mutations()).toHaveLength(1);
  });

  test("does not retry an answer mutation after a service error", async () => {
    updateResponse = {
      status: 503,
      body: { detail: "Seer temporarily unavailable" },
    };
    const path = await responseFile({
      input_id: QUESTION.id,
      response_data: { answers: ["Return null"] },
    });
    const result = await ctx.run([
      "issue",
      "fix",
      ISSUE,
      "--run-id",
      RUN_ID,
      "--response",
      path,
      "--json",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(RUN_ID);
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0]?.path).toBe(UPDATE.replace(":runId", RUN_ID));
  });
});

describe("sentry issue fix delivery", () => {
  test("JSON preview leaves the checkout unchanged until delivery is requested", async () => {
    const cwd = await checkout();
    activeSession = completed();
    const result = await runInCheckout(cwd, [
      "issue",
      "fix",
      ISSUE,
      "--run-id",
      RUN_ID,
      "--json",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "COMPLETED",
      patches: [PATCH],
      pr_urls: [],
    });
    expect(await readFile(join(cwd, "users.ts"), "utf8")).toBe(
      "return user.name;\n",
    );
    expect(mutations()).toEqual([]);
  });
  test("applies an entire add/modify/delete batch from a nested checkout and preserves unrelated work", async () => {
    const cwd = await checkout();
    await writeFile(join(cwd, "unrelated.txt"), "my local work\n", "utf8");
    const nested = join(cwd, "nested");
    await mkdir(nested);
    activeSession = completed([PATCH, ADDED_PATCH, DELETED_PATCH]);

    const result = await runInCheckout(nested, [
      "issue",
      "fix",
      ISSUE,
      "--run-id",
      RUN_ID,
      "--apply",
      "--json",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      run_id: RUN_ID,
      status: "COMPLETED",
      patches: [PATCH, ADDED_PATCH, DELETED_PATCH],
      applied_files: ["users.ts", "new.txt", "remove.txt"],
    });
    expect(await readFile(join(cwd, "users.ts"), "utf8")).toBe(
      "return user?.name;\n",
    );
    expect(await readFile(join(cwd, "new.txt"), "utf8")).toBe("new\n");
    await expect(readFile(join(cwd, "remove.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(cwd, "unrelated.txt"), "utf8")).toBe(
      "my local work\n",
    );
    expect(mutations()).toEqual([]);
  });

  test.each(["dirty", "mismatch", "unsafe"] as const)(
    "refuses %s local application, preserves the fix and does not create a PR",
    async (kind) => {
      const cwd = await checkout(
        kind === "mismatch"
          ? "https://github.com/example/other.git"
          : undefined,
      );
      const before =
        kind === "dirty" ? "my local changes\n" : "return user.name;\n";
      await writeFile(join(cwd, "users.ts"), before, "utf8");
      const outside = join(getConfigDir(), "outside.txt");
      await writeFile(outside, "keep outside\n", "utf8");
      const patch =
        kind === "unsafe"
          ? { ...PATCH, patch: { ...PATCH.patch, path: "../outside.txt" } }
          : PATCH;
      activeSession = completed([patch]);

      const result = await runInCheckout(cwd, [
        "issue",
        "fix",
        ISSUE,
        "--run-id",
        RUN_ID,
        "--apply",
        "--pr",
        "--json",
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        run_id: RUN_ID,
        status: "ERROR",
        patches: [patch],
        delivery_errors: [expect.any(String)],
      });
      expect(await readFile(join(cwd, "users.ts"), "utf8")).toBe(before);
      expect(await readFile(outside, "utf8")).toBe("keep outside\n");
      expect(mutations()).toEqual([]);
    },
  );

  test("creates one wrapped PR request and polls repository state even when the run is completed", async () => {
    let reads = 0;
    chatHandler = () => {
      reads += 1;
      const state = completed();
      if (mutations().length) {
        state.repo_pr_states = {
          "example/backend": {
            repo_name: "example/backend",
            pr_creation_status: reads < 4 ? "creating" : "completed",
            pr_url:
              reads < 4 ? null : "https://github.com/example/backend/pull/42",
          },
        };
      }
      return { body: { session: state, sentry_run_id: RUN_ID } };
    };
    const result = await ctx.run([
      "issue",
      "fix",
      ISSUE,
      "--run-id",
      RUN_ID,
      "--pr",
      "--json",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "COMPLETED",
      patches: [PATCH],
      pr_urls: ["https://github.com/example/backend/pull/42"],
    });
    expect(mutations()).toEqual([
      {
        method: "POST",
        path: UPDATE.replace(":runId", RUN_ID),
        body: { payload: { type: "create_pr", repo_name: "example/backend" } },
      },
    ]);
    expect(reads).toBeGreaterThanOrEqual(4);
  });

  test("waits for an existing in-flight PR without creating another one", async () => {
    let reads = 0;
    chatHandler = () => {
      reads += 1;
      return {
        body: {
          sentry_run_id: RUN_ID,
          session: {
            ...completed(),
            repo_pr_states: {
              "example/backend": {
                repo_name: "example/backend",
                pr_creation_status: reads < 3 ? "creating" : "completed",
                pr_url:
                  reads < 3
                    ? null
                    : "https://github.com/example/backend/pull/42",
              },
            },
          },
        },
      };
    };
    const result = await ctx.run([
      "issue",
      "fix",
      ISSUE,
      "--run-id",
      RUN_ID,
      "--pr",
      "--json",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).pr_urls).toEqual([
      "https://github.com/example/backend/pull/42",
    ]);
    expect(mutations()).toEqual([]);
  });

  test("retains generated diffs and returns a nonzero aggregate when PR creation fails", async () => {
    chatHandler = () => ({
      body: {
        sentry_run_id: RUN_ID,
        session: {
          ...completed(),
          repo_pr_states: mutations().length
            ? {
                "example/backend": {
                  repo_name: "example/backend",
                  pr_creation_status: "error",
                  pr_creation_error: "GitHub denied repository access",
                },
              }
            : {},
        },
      },
    });
    const result = await ctx.run([
      "issue",
      "fix",
      ISSUE,
      "--run-id",
      RUN_ID,
      "--pr",
      "--json",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      run_id: RUN_ID,
      status: "ERROR",
      patches: [PATCH],
      delivery_errors: [expect.stringMatching(/GitHub denied/i)],
    });
    expect(mutations()).toHaveLength(1);
  });

  test("does not replay an uncertain create-PR POST after a service error", async () => {
    activeSession = completed();
    updateResponse = {
      status: 503,
      body: { detail: "Seer temporarily unavailable" },
    };
    const result = await ctx.run([
      "issue",
      "fix",
      ISSUE,
      "--run-id",
      RUN_ID,
      "--pr",
      "--json",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      run_id: RUN_ID,
      status: "ERROR",
      patches: [PATCH],
      delivery_errors: [expect.any(String)],
    });
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0]?.body).toEqual({
      payload: { type: "create_pr", repo_name: "example/backend" },
    });
  });

  test("does not apply files or create a PR when fresh preflight discovers a pending approval", async () => {
    const cwd = await checkout();
    let reads = 0;
    chatHandler = () => {
      reads += 1;
      return {
        body: {
          sentry_run_id: RUN_ID,
          session:
            reads === 1
              ? completed()
              : {
                  ...completed(),
                  status: "awaiting_user_input",
                  pending_user_input: QUESTION,
                },
        },
      };
    };
    const result = await runInCheckout(cwd, [
      "issue",
      "fix",
      ISSUE,
      "--run-id",
      RUN_ID,
      "--apply",
      "--pr",
      "--json",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      run_id: RUN_ID,
      status: "ERROR",
      patches: [PATCH],
      pending_user_input: QUESTION,
    });
    expect(mutations()).toEqual([]);
    expect(await readFile(join(cwd, "users.ts"), "utf8")).toBe(
      "return user.name;\n",
    );
  });
});
