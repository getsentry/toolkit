/**
 * Event Command E2E Tests
 *
 * Tests for sentry event get command.
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
import { cleanupTestDir, createTestConfigDir } from "../helpers.js";
import {
  createSentryMockServer,
  TEST_ORG,
  TEST_PROJECT,
  TEST_TOKEN,
} from "../mocks/routes.js";
import type { MockServer } from "../mocks/server.js";

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
  testConfigDir = await createTestConfigDir("e2e-event-");
  ctx = createE2EContext(testConfigDir, mockServer.url);
});

afterEach(async () => {
  await cleanupTestDir(testConfigDir);
});

describe("sentry event view", () => {
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
      /invalid event id|32-character hexadecimal/i
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
