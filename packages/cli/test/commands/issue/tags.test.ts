/**
 * Issue tag distribution command integration tests.
 *
 * Exercise routing, issue resolution, the HTTP client, and output together.
 * Only the external HTTP boundary is mocked.
 */

import type { GetOrganizationIssueTagResponse } from "@sentry/api";
import { run } from "@stricli/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { app } from "../../../src/app.js";
import { tagsCommand } from "../../../src/commands/issue/tags.js";
import type { SentryContext } from "../../../src/context.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { ApiError } from "../../../src/lib/errors.js";
import { mockFetch, useEnvSandbox, useTestConfigDir } from "../../helpers.js";

const getConfigDir = useTestConfigDir("issue-tags-", {
  isolateProjectRoot: true,
});
useEnvSandbox(["SENTRY_AUTH_TOKEN", "SENTRY_TOKEN", "SENTRY_PLAIN_OUTPUT"]);

const REGION_URL = "https://de.sentry.io";
const ISSUE_PATH = "/api/0/organizations/test-org/issues/12345/";
const ISSUE = {
  id: "12345",
  shortId: "FRONT-ABC",
  title: "Example application error",
  count: "1000",
  userCount: 20,
  status: "unresolved",
  project: { id: "42", slug: "frontend", name: "Frontend" },
  permalink: "https://test-org.sentry.io/issues/12345/",
};

// The detail endpoint returns a denominator for retained issue events, while
// topValues contains only a subset. It is deliberately smaller than count on
// the issue above, which is not a valid denominator for this distribution.
const TAG: GetOrganizationIssueTagResponse = {
  key: "release",
  name: "Release",
  totalValues: 100,
  uniqueValues: 4,
  topValues: [
    {
      key: "release",
      name: "app@1.2.3",
      value: "app@1.2.3",
      count: 70,
      firstSeen: "2026-10-20T00:00:00Z",
      lastSeen: "2026-10-21T12:00:00Z",
      query: 'release:"app@1.2.3"',
    },
    {
      key: "release",
      name: "app@1.2.2",
      value: "app@1.2.2",
      count: 20,
      firstSeen: "2026-10-19T00:00:00Z",
      lastSeen: "2026-10-20T12:00:00Z",
      query: 'release:"app@1.2.2"',
    },
  ],
};

let originalFetch: typeof globalThis.fetch;
let requests: Request[];
let tagResponse: GetOrganizationIssueTagResponse;
let tagStatus: number;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  requests = [];
  tagResponse = TAG;
  tagStatus = 200;
  setAuthToken("test-token");
  setOrgRegion("test-org", REGION_URL);
  globalThis.fetch = mockFetch(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const { pathname } = new URL(request.url);
    if (pathname === ISSUE_PATH) {
      return Response.json(ISSUE);
    }
    if (pathname === "/api/0/organizations/test-org/shortids/FRONT-ABC/") {
      return Response.json({ group: ISSUE });
    }
    if (pathname.startsWith(`${ISSUE_PATH}tags/`)) {
      return tagStatus === 200
        ? Response.json(tagResponse)
        : Response.json({ detail: "Tag access denied" }, { status: tagStatus });
    }
    throw new Error(`Unexpected request: ${request.url}`);
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureContext() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutWriter = {
    write(value: string | Uint8Array) {
      stdout.push(String(value));
      return true;
    },
  };
  const stderrWriter = {
    write(value: string | Uint8Array) {
      stderr.push(String(value));
      return true;
    },
  };
  const context: SentryContext = {
    process: {
      ...process,
      stdout: stdoutWriter,
      stderr: stderrWriter,
      exitCode: undefined,
    } as unknown as typeof process,
    env: process.env,
    cwd: getConfigDir(),
    homeDir: getConfigDir(),
    configDir: getConfigDir(),
    stdin: process.stdin,
    stdout: stdoutWriter,
    stderr: stderrWriter,
  };
  return { context, stdout, stderr };
}

async function runCli(args: string[]) {
  const { context, stdout, stderr } = captureContext();
  await run(app, args, context);
  return {
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    exitCode: context.process.exitCode ?? 0,
  };
}

describe("sentry issue tags", () => {
  test.each(["test-org/12345", "test-org/FRONT-ABC"])(
    "resolves %s and preserves the full tag detail in JSON",
    async (issue) => {
      const result = await runCli([
        "issue",
        "tags",
        issue,
        "release",
        "--json",
        "-e",
        "production",
      ]);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(TAG);
      expect(requests).toHaveLength(2);
      expect(
        requests.every((request) => new URL(request.url).origin === REGION_URL),
      ).toBe(true);
      const tagRequest = requests[1];
      expect(tagRequest?.headers.get("Authorization")).toBe(
        "Bearer test-token",
      );
      expect(tagRequest?.url).toBe(
        `${REGION_URL}${ISSUE_PATH}tags/release/?environment=production`,
      );
    },
  );

  test("projects JSON fields without flattening the top values", async () => {
    const result = await runCli([
      "issue",
      "tags",
      "test-org/12345",
      "release",
      "--json",
      "--fields",
      "key,totalValues,topValues",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      key: TAG.key,
      totalValues: TAG.totalValues,
      topValues: TAG.topValues,
    });
    expect(new URL(requests[1]?.url ?? "").search).toBe("");
  });

  test("shows shares of retained events and the undisplayed remainder", async () => {
    const result = await runCli(["issue", "tags", "test-org/12345", "release"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("FRONT-ABC");
    expect(result.stdout).toContain("app@1.2.3");
    expect(result.stdout).toMatch(/70(?:\.0)?%/);
    expect(result.stdout).toMatch(/20(?:\.0)?%/);
    expect(result.stdout).toMatch(/10(?:\.0)?%/);
    expect(result.stdout).not.toMatch(/77\.8%|22\.2%/);
  });

  test("removes terminal controls from human output while preserving JSON values", async () => {
    process.env.SENTRY_PLAIN_OUTPUT = "0";
    const value = "\u001b]52;c;dGVzdA==\u0007\u001b[2J1.2.3\u0008\u202e";
    tagResponse = {
      ...TAG,
      key: "\u001b[2Jrelease\u202e",
      topValues: [{ ...TAG.topValues![0]!, value }],
    };
    const args = ["issue", "tags", "test-org/12345", "release"];
    const human = await runCli(args);

    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("1.2.3");
    expect(human.stdout).not.toContain("\u001b]52;");
    expect(human.stdout).not.toContain("dGVzdA==");
    expect(human.stdout).not.toContain("\u001b[2J");
    expect(human.stdout).not.toContain("\u0008");
    expect(human.stdout).not.toContain("\u202e");

    const json = await runCli([...args, "--json"]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(tagResponse);
  });

  test("handles a tag without values without inventing percentages", async () => {
    tagResponse = {
      key: "release",
      name: "Release",
      totalValues: 0,
      uniqueValues: 0,
      topValues: [],
    };
    const result = await runCli(["issue", "tags", "test-org/12345", "release"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no .*values/i);
    expect(result.stdout).not.toMatch(/NaN|Infinity/);
  });

  test("propagates API failures instead of returning an empty distribution", async () => {
    tagStatus = 403;
    const { context, stdout } = captureContext();
    const func = await tagsCommand.loader();

    await expect(
      func.call(
        context,
        { json: true, fresh: false },
        "test-org/12345",
        "release",
      ),
    ).rejects.toMatchObject({
      status: 403,
      name: ApiError.name,
    });
    expect(stdout).toEqual([]);
  });

  test("documents the response and supported filters in structured help", async () => {
    const result = await runCli(["help", "issue", "tags", "--json"]);
    const help = JSON.parse(result.stdout);

    expect(help.path).toBe("sentry issue tags");
    const flagNames = help.flags.map((flag: { name: string }) => flag.name);
    expect(flagNames).toEqual(
      expect.arrayContaining(["environment", "json", "fields", "fresh"]),
    );
    for (const unsupported of ["period", "query", "cursor", "limit"]) {
      expect(flagNames).not.toContain(unsupported);
    }
    expect(
      help.jsonFields.map((field: { name: string }) => field.name),
    ).toEqual(
      expect.arrayContaining([
        "key",
        "totalValues",
        "uniqueValues",
        "topValues",
      ]),
    );
    expect(requests).toEqual([]);
  });

  test.each([
    ["test-org/ABC", "test-org/<project>-ABC"],
    ["@latest", "<org>/@latest"],
  ])(
    "keeps the tag and environment in recovery commands for %s",
    async (issue, correctedIssue) => {
      const result = await runCli([
        "issue",
        "tags",
        issue,
        "release",
        "--environment",
        "team's production",
        "--json",
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        `sentry issue tags ${correctedIssue} 'release' '--environment' 'team'"'"'s production'`,
      );
      expect(requests).toEqual([]);
    },
  );

  test.each([
    ["test-org/12345"],
    ["test-org/12345", "release", "--period", "7d"],
    ["test-org/12345", "release", "-e", "production", "-e", "staging"],
  ])(
    "rejects unsupported arguments before requesting data: %j",
    async (...args) => {
      const result = await runCli(["issue", "tags", ...args]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toBe("");
      expect(requests).toEqual([]);
    },
  );
});
