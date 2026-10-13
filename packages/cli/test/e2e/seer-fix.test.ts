/**
 * Subprocess coverage for resumable Seer fixes. The local API fixtures follow
 * Sentry's interactive explorer chat/update endpoint contracts.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createE2EContext, type E2EContext } from "../fixture.js";
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
const PATCH = {
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
