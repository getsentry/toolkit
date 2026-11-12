/**
 * Event Command E2E Tests
 *
 * Tests event lookup and the list-to-view flow through the real CLI.
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
import eventFixture from "../fixtures/event.json";
import { cleanupTestDir, createTestConfigDir } from "../helpers.js";
import {
  apiRoutes,
  TEST_ISSUE_ID,
  TEST_ISSUE_SHORT_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_TOKEN,
} from "../mocks/routes.js";
import { createMockServer, type MockServer } from "../mocks/server.js";

const EVENT_ID = "abcd1234abcd5678abcd1234abcd5678";
const event = { ...eventFixture, id: EVENT_ID, eventID: EVENT_ID };
const LATEST_EVENT_ID = "fedc1234fedc5678fedc1234fedc5678";
const latestEvent = {
  ...event,
  id: LATEST_EVENT_ID,
  eventID: LATEST_EVENT_ID,
  dateCreated: "2024-01-16T09:45:00.000000Z",
};

let testConfigDir: string;
let mockServer: MockServer;
let ctx: E2EContext;

beforeAll(async () => {
  mockServer = createMockServer(
    [
      {
        method: "GET",
        path: `/api/0/organizations/${TEST_ORG}/issues/${TEST_ISSUE_ID}/events/`,
        response: [latestEvent, event],
      },
      {
        method: "GET",
        path: `/api/0/projects/${TEST_ORG}/${TEST_PROJECT}/events/${EVENT_ID}/`,
        response: event,
      },
      {
        method: "GET",
        path: `/api/0/projects/${TEST_ORG}/${TEST_PROJECT}/events/${EVENT_ID}/attachments/`,
        response: [],
      },
      {
        method: "GET",
        path: `/api/0/organizations/${TEST_ORG}/issues/${TEST_ISSUE_ID}/events/latest/`,
        response: latestEvent,
      },
      {
        method: "GET",
        path: `/api/0/projects/${TEST_ORG}/${TEST_PROJECT}/events/${LATEST_EVENT_ID}/attachments/`,
        response: [],
      },
      ...apiRoutes,
    ],
    { validTokens: [TEST_TOKEN] },
  );
  await mockServer.start();
});

afterAll(() => {
  mockServer.stop();
});

beforeEach(async () => {
  testConfigDir = await createTestConfigDir("e2e-event-");
  ctx = createE2EContext(testConfigDir, mockServer.url);
});

afterEach(async () => {
  await cleanupTestDir(testConfigDir);
});

describe("sentry event view", () => {
  test.each([TEST_ISSUE_SHORT_ID, `${TEST_ORG}/${TEST_ISSUE_SHORT_ID}`])(
    "opens the listed event instead of the latest for %s <ID>",
    async (issueArg) => {
      await ctx.setAuthToken(TEST_TOKEN);
      const defaults = await ctx.run(["cli", "defaults", "org", TEST_ORG]);
      expect(defaults.exitCode, defaults.stderr).toBe(0);

      const latest = await ctx.run([
        "event",
        "view",
        issueArg,
        "--json",
        "--spans",
        "0",
      ]);
      expect(latest.exitCode, latest.stderr).toBe(0);
      expect(JSON.parse(latest.stdout)).toMatchObject({
        eventID: LATEST_EVENT_ID,
      });

      const listed = await ctx.run([
        "issue",
        "events",
        issueArg,
        "--limit",
        "2",
      ]);
      expect(listed.exitCode, listed.stderr).toBe(0);
      const copiedId = listed.stdout.match(/\b[0-9a-f]{32}\b/g)?.[1] ?? "";
      expect(copiedId, listed.stdout).toBe(EVENT_ID);

      const viewed = await ctx.run([
        "event",
        "view",
        issueArg,
        copiedId,
        "--json",
        "--spans",
        "0",
      ]);
      expect(viewed.exitCode, viewed.stderr).toBe(0);
      expect(JSON.parse(viewed.stdout)).toMatchObject({ eventID: copiedId });
    },
  );

  test.each([
    { id: "abcd1234abcd", error: /32-character hexadecimal/i },
    { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", error: /not found/i },
  ])(
    "fails instead of showing latest when the selected ID is $id",
    async ({ id, error }) => {
      await ctx.setAuthToken(TEST_TOKEN);
      const defaults = await ctx.run(["cli", "defaults", "org", TEST_ORG]);
      expect(defaults.exitCode, defaults.stderr).toBe(0);

      const result = await ctx.run([
        "event",
        "view",
        TEST_ISSUE_SHORT_ID,
        id,
        "--json",
        "--spans",
        "0",
      ]);
      expect(result.exitCode, result.stderr).not.toBe(0);
      expect(result.stderr).toMatch(error);
      expect(result.stdout).not.toContain(LATEST_EVENT_ID);
    },
  );

  test("requires authentication", async () => {
    // Use positional arg format: <org>/<project> <event-id>
    const result = await ctx.run([
      "event",
      "view",
      `${TEST_ORG}/${TEST_PROJECT}`,
      "abc123def456abc123def456abc123de",
    ]);

    expect(result.exitCode).toBe(EXIT.AUTH_NOT_AUTHENTICATED);
    expect(result.stderr + result.stdout).toMatch(/not authenticated|login/i);
  });

  test("requires org and project without DSN", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "event",
      "view",
      "abc123def456abc123def456abc123de",
    ]);

    expect(result.exitCode).toBe(EXIT.CONTEXT_MISSING);
    expect(result.stderr + result.stdout).toMatch(/organization|project/i);
  });

  test("rejects invalid event ID format", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["event", "view", "abc123"]);

    expect(result.exitCode).toBe(EXIT.VALIDATION);
    expect(result.stderr + result.stdout).toMatch(
      /invalid event id|32-character hexadecimal/i,
    );
  });

  test("handles non-existent event", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    // Use positional arg format: <org>/<project> <event-id>
    const result = await ctx.run([
      "event",
      "view",
      `${TEST_ORG}/${TEST_PROJECT}`,
      "abc123def456abc123def456abc123de",
    ]);

    expect(result.exitCode).toBe(EXIT.RESOLUTION);
    expect(result.stderr + result.stdout).toMatch(/not found|error|404/i);
  });
});
