/**
 * Feedback command E2E tests.
 *
 * Exercises the real command router and generated API client against a mock
 * Sentry API, including the mandatory issue-category and status filters.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { EXIT } from "../../src/lib/errors.js";
import { createE2EContext, type E2EContext } from "../fixture.js";
import feedbackFixture from "../fixtures/feedback.json";
import { cleanupTestDir, createTestConfigDir } from "../helpers.js";
import {
  createSentryMockServer,
  TEST_FEEDBACK_ID,
  TEST_FEEDBACK_LATEST_ORG,
  TEST_FEEDBACK_SHORT_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_TOKEN,
} from "../mocks/routes.js";
import { createMockServer, type MockServer } from "../mocks/server.js";

let testConfigDir: string;
let mockServer: MockServer;
let ctx: E2EContext;

beforeAll(async () => {
  mockServer = createSentryMockServer();
  await mockServer.start();
});

afterAll(() => {
  mockServer.stop();
});

beforeEach(async () => {
  testConfigDir = await createTestConfigDir("e2e-feedback-");
  ctx = createE2EContext(testConfigDir, mockServer.url);
});

afterEach(async () => {
  await cleanupTestDir(testConfigDir);
});

describe("sentry feedback routes", () => {
  test(
    "documents list, status mutations, view, and the default view route",
    { timeout: 30_000 },
    async () => {
      const routeHelp = await ctx.run(["feedback", "--help"]);
      const listHelp = await ctx.run(["feedback", "list", "--help"]);
      const viewHelp = await ctx.run(["feedback", "view", "--help"]);
      const resolveHelp = await ctx.run(["feedback", "resolve", "--help"]);
      const unresolveHelp = await ctx.run(["feedback", "unresolve", "--help"]);
      const spamHelp = await ctx.run(["feedback", "spam", "--help"]);

      expect(routeHelp.exitCode, routeHelp.stderr).toBe(0);
      expect(routeHelp.stdout).toContain("list");
      expect(routeHelp.stdout).toContain("view");
      expect(routeHelp.stdout).toContain("resolve");
      expect(routeHelp.stdout).toContain("unresolve");
      expect(routeHelp.stdout).toContain("reopen");
      expect(routeHelp.stdout).toContain("spam");
      expect(listHelp.exitCode, listHelp.stderr).toBe(0);
      expect(listHelp.stdout).toContain("--status");
      expect(listHelp.stdout).toContain("--period");
      expect(viewHelp.exitCode, viewHelp.stderr).toBe(0);
      expect(viewHelp.stdout).toContain("--web");
      expect(resolveHelp.exitCode, resolveHelp.stderr).toBe(0);
      expect(resolveHelp.stdout).toContain("--json");
      expect(unresolveHelp.exitCode, unresolveHelp.stderr).toBe(0);
      expect(unresolveHelp.stdout).toContain("--json");
      expect(spamHelp.exitCode, spamHelp.stderr).toBe(0);
      expect(spamHelp.stdout).toContain("--json");
    }
  );
});

describe.each([
  { command: "resolve", status: "resolved" },
  { command: "unresolve", status: "unresolved" },
  { command: "spam", status: "ignored" },
])("sentry feedback $command", ({ command, status }) => {
  test("requires authentication", async () => {
    const result = await ctx.run([
      "feedback",
      command,
      `${TEST_ORG}/${TEST_FEEDBACK_SHORT_ID}`,
    ]);

    expect(result.exitCode).toBe(EXIT.AUTH_NOT_AUTHENTICATED);
  });

  test("updates a numeric ID through its organization and emits the updated Feedback", async () => {
    await ctx.setAuthToken(TEST_TOKEN);
    const result = await ctx.run([
      "feedback",
      command,
      TEST_FEEDBACK_ID,
      "--json",
    ]);

    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: TEST_FEEDBACK_ID,
      shortId: TEST_FEEDBACK_SHORT_ID,
      issueCategory: "feedback",
      status,
    });
  });

  test("updates @latest within the unresolved Feedback category", async () => {
    await ctx.setAuthToken(TEST_TOKEN);
    const result = await ctx.run([
      "feedback",
      command,
      `${TEST_FEEDBACK_LATEST_ORG}/@latest`,
      "--json",
      "--fields",
      "id,status",
    ]);

    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      id: TEST_FEEDBACK_ID,
      status,
    });
  });

  test("refreshes @latest before updating instead of mutating a cached selection", async () => {
    const newestId = "5146636314";
    let reads = 0;
    let mutatedId: string | undefined;
    const selectionServer = createMockServer(
      [
        {
          method: "GET",
          path: "/api/0/organizations/:orgSlug/issues/",
          response: () => {
            reads += 1;
            return {
              body: [
                {
                  ...feedbackFixture,
                  id: reads === 1 ? TEST_FEEDBACK_ID : newestId,
                },
              ],
              headers: { "Cache-Control": "private, max-age=3600" },
            };
          },
        },
        {
          method: "PUT",
          path: "/api/0/organizations/:orgSlug/issues/:issueId/",
          response: (_req, params) => {
            mutatedId = params.issueId;
            return {
              body: {
                ...feedbackFixture,
                id: params.issueId,
                status,
              },
            };
          },
        },
      ],
      { validTokens: [TEST_TOKEN] }
    );
    await selectionServer.start();
    try {
      const selectionContext = createE2EContext(
        testConfigDir,
        selectionServer.url
      );
      await selectionContext.setAuthToken(TEST_TOKEN);
      const args = [`${TEST_ORG}/@latest`, "--json", "--fields", "id"];
      const viewed = await selectionContext.run(["feedback", "view", ...args]);
      expect(viewed.exitCode, viewed.stderr + viewed.stdout).toBe(0);
      expect(JSON.parse(viewed.stdout)).toEqual({ id: TEST_FEEDBACK_ID });

      const cachedView = await selectionContext.run([
        "feedback",
        "view",
        ...args,
      ]);
      expect(cachedView.exitCode, cachedView.stderr + cachedView.stdout).toBe(
        0
      );
      expect(JSON.parse(cachedView.stdout)).toEqual({ id: TEST_FEEDBACK_ID });
      expect(reads).toBe(1);

      const updated = await selectionContext.run([
        "feedback",
        command,
        ...args,
      ]);
      expect(updated.exitCode, updated.stderr + updated.stdout).toBe(0);
      expect(JSON.parse(updated.stdout)).toEqual({ id: newestId });
      expect(mutatedId).toBe(newestId);
    } finally {
      selectionServer.stop();
    }
  });
});

describe("sentry feedback reopen", () => {
  test("aliases unresolve and supports field selection", async () => {
    await ctx.setAuthToken(TEST_TOKEN);
    const result = await ctx.run([
      "feedback",
      "reopen",
      `${TEST_ORG}/${TEST_FEEDBACK_SHORT_ID}`,
      "--json",
      "--fields",
      "id,status",
    ]);

    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      id: TEST_FEEDBACK_ID,
      status: "unresolved",
    });
  });
});

describe("sentry feedback list", () => {
  test("requires authentication", async () => {
    const result = await ctx.run([
      "feedback",
      "list",
      `${TEST_ORG}/${TEST_PROJECT}`,
    ]);

    expect(result.exitCode).toBe(EXIT.AUTH_NOT_AUTHENTICATED);
  });

  test("queries modern unresolved Feedback and returns the JSON envelope", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "feedback",
      "list",
      `${TEST_ORG}/${TEST_PROJECT}`,
      "--query",
      "e2e-status-check",
      "--json",
    ]);

    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: [
        {
          id: TEST_FEEDBACK_ID,
          shortId: TEST_FEEDBACK_SHORT_ID,
          issueCategory: "feedback",
          status: "unresolved",
        },
      ],
      hasMore: false,
      hasPrev: false,
    });
  });

  test("isolates stored cursors for different limits", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    for (const limit of [25, 50]) {
      const firstPage = await ctx.run([
        "feedback",
        "list",
        `${TEST_ORG}/${TEST_PROJECT}`,
        "--query",
        "e2e-limit-context",
        "--limit",
        String(limit),
        "--json",
      ]);
      expect(firstPage.exitCode, firstPage.stderr + firstPage.stdout).toBe(0);
      expect(JSON.parse(firstPage.stdout).nextCursor).toBe(
        `feedback-limit-${limit}-next`
      );
    }

    for (const limit of [25, 50]) {
      const nextPage = await ctx.run([
        "feedback",
        "list",
        `${TEST_ORG}/${TEST_PROJECT}`,
        "--query",
        "e2e-limit-context",
        "--limit",
        String(limit),
        "--cursor",
        "next",
        "--json",
      ]);
      expect(nextPage.exitCode, nextPage.stderr + nextPage.stdout).toBe(0);
    }
  });
});

describe("sentry feedback view", () => {
  test("resolves @latest with explicit and detected organization context", async () => {
    await ctx.setAuthToken(TEST_TOKEN);
    const defaultsResult = await ctx.run([
      "cli",
      "defaults",
      "org",
      TEST_FEEDBACK_LATEST_ORG,
    ]);
    expect(
      defaultsResult.exitCode,
      defaultsResult.stderr + defaultsResult.stdout
    ).toBe(0);

    for (const input of ["@latest", `${TEST_FEEDBACK_LATEST_ORG}/@latest`]) {
      const result = await ctx.run([
        "feedback",
        "view",
        input,
        "--json",
        "--fields",
        "id",
      ]);
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ id: TEST_FEEDBACK_ID });
    }
  });

  test("rejects @most_frequent with a Feedback-specific error", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "feedback",
      "view",
      `${TEST_ORG}/@most_frequent`,
    ]);

    expect(result.exitCode).toBe(EXIT.VALIDATION);
    expect(result.stderr + result.stdout).toContain("only supports @latest");
  });

  test("returns flattened event, replay, and attachment data", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "feedback",
      "view",
      `${TEST_ORG}/${TEST_FEEDBACK_SHORT_ID}`,
      "--json",
    ]);

    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: TEST_FEEDBACK_ID,
      org: TEST_ORG,
      issueCategory: "feedback",
      event: { groupID: TEST_FEEDBACK_ID },
      replayIds: [
        "346789a703f6454384f1de473b8b9fcc",
        "aaaaaaaa03f6454384f1de473b8b9fcc",
      ],
      attachments: [{ name: "screenshot.png", size: 2048 }],
    });
  });

  test("supports the default route and show alias", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const defaultResult = await ctx.run([
      "feedback",
      `${TEST_ORG}/${TEST_FEEDBACK_SHORT_ID}`,
      "--json",
      "--fields",
      "id",
    ]);
    const aliasResult = await ctx.run([
      "feedback",
      "show",
      `${TEST_ORG}/${TEST_FEEDBACK_SHORT_ID}`,
      "--json",
      "--fields",
      "id",
    ]);

    expect(
      defaultResult.exitCode,
      defaultResult.stderr + defaultResult.stdout
    ).toBe(0);
    expect(aliasResult.exitCode, aliasResult.stderr + aliasResult.stdout).toBe(
      0
    );
    expect(JSON.parse(defaultResult.stdout)).toEqual({ id: TEST_FEEDBACK_ID });
    expect(JSON.parse(aliasResult.stdout)).toEqual({ id: TEST_FEEDBACK_ID });
  });

  test("accepts issue-style identifiers and modern Feedback URLs", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const inputs = [
      TEST_FEEDBACK_ID,
      TEST_FEEDBACK_SHORT_ID,
      `${TEST_ORG}/${TEST_PROJECT}/2SDJ`,
      `https://${TEST_ORG}.sentry.io/feedback/?feedbackSlug=${TEST_PROJECT}%3A${TEST_FEEDBACK_ID}`,
    ];
    for (const input of inputs) {
      const result = await ctx.run([
        "feedback",
        "view",
        input,
        "--json",
        "--fields",
        "id",
      ]);
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ id: TEST_FEEDBACK_ID });
    }
  });

  test("recovers organization context from a bare numeric Feedback ID", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "feedback",
      "view",
      TEST_FEEDBACK_ID,
      "--json",
    ]);

    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: TEST_FEEDBACK_ID,
      org: TEST_ORG,
      event: { groupID: TEST_FEEDBACK_ID },
      attachments: [{ name: "screenshot.png" }],
    });
  });

  test("rejects ordinary issues with an issue-view hint", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "feedback",
      "view",
      `${TEST_ORG}/TEST-PROJECT-1A`,
    ]);

    expect(result.exitCode, result.stderr + result.stdout).toBe(
      EXIT.RESOLUTION
    );
    expect(result.stderr + result.stdout).toContain("is not User Feedback");
    expect(result.stderr + result.stdout).toContain("sentry issue view");
  });
});
