/**
 * Log Command E2E Tests
 *
 * Tests for sentry log list command.
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
  TEST_LOG_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_TOKEN,
  TEST_TRACE_ID,
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
  testConfigDir = await createTestConfigDir("e2e-log-");
  ctx = createE2EContext(testConfigDir, mockServer.url);
});

afterEach(async () => {
  await cleanupTestDir(testConfigDir);
});

describe("sentry log list", () => {
  test("requires authentication", async () => {
    const result = await ctx.run([
      "log",
      "list",
      `${TEST_ORG}/${TEST_PROJECT}`,
    ]);

    expect(result.exitCode).toBe(EXIT.AUTH_NOT_AUTHENTICATED);
    expect(result.stderr + result.stdout).toMatch(/not authenticated|login/i);
  });

  test("lists logs with valid auth using positional arg", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "log",
      "list",
      `${TEST_ORG}/${TEST_PROJECT}`,
    ]);

    expect(result.exitCode).toBe(0);
  });

  test("supports --json output", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "log",
      "list",
      `${TEST_ORG}/${TEST_PROJECT}`,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    // Should be valid JSON envelope with data array and hasMore boolean
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty("data");
    expect(parsed).toHaveProperty("hasMore");
    expect(Array.isArray(parsed.data)).toBe(true);
  });

  test("supports --limit flag", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "log",
      "list",
      `${TEST_ORG}/${TEST_PROJECT}`,
      "--limit",
      "5",
    ]);

    expect(result.exitCode).toBe(0);
  });

  test("supports -n alias for --limit", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "log",
      "list",
      `${TEST_ORG}/${TEST_PROJECT}`,
      "-n",
      "5",
    ]);

    expect(result.exitCode).toBe(0);
  });

  test("validates --limit range", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "log",
      "list",
      `${TEST_ORG}/${TEST_PROJECT}`,
      "--limit",
      "9999",
    ]);

    // Stricli uses exit code 252 for parse errors
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/must be between|1.*1000/i);
  });

  test("supports -f flag for follow mode", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    // We can't actually test follow mode in e2e since it runs forever,
    // but we can verify the flag is accepted by checking --help
    const result = await ctx.run(["log", "list", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/-f.*--follow/);
    expect(result.stdout).toMatch(/poll interval/i);
  });
});

describe("sentry log list (trace mode)", () => {
  test("filters logs by trace ID (positional)", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "log",
      "list",
      `${TEST_ORG}/${TEST_TRACE_ID}`,
    ]);

    expect(result.exitCode).toBe(0);
    // Should show trace log messages (from mock)
    expect(result.stdout).toContain("Trace log message");
  });

  test("supports --json with trace ID positional", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "log",
      "list",
      `${TEST_ORG}/${TEST_TRACE_ID}`,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty("data");
    expect(parsed).toHaveProperty("hasMore");
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data.length).toBe(2);
  });

  test("shows empty state for unknown trace", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "log",
      "list",
      `${TEST_ORG}/00000000000000000000000000000000`,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no logs found/i);
  });

  test("help shows trace-id as positional argument", async () => {
    const result = await ctx.run(["log", "list", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/trace-id/i);
    expect(result.stdout).toMatch(/trace filtering/i);
  });
});

describe("sentry log view", () => {
  test("requires authentication", async () => {
    const result = await ctx.run([
      "log",
      "view",
      `${TEST_ORG}/${TEST_PROJECT}`,
      TEST_LOG_ID,
    ]);

    expect(result.exitCode).toBe(EXIT.AUTH_NOT_AUTHENTICATED);
    expect(result.stderr + result.stdout).toMatch(/not authenticated|login/i);
  });

  test("requires org and project without DSN", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["log", "view", TEST_LOG_ID]);

    expect(result.exitCode).toBe(EXIT.CONTEXT_MISSING);
    expect(result.stderr + result.stdout).toMatch(/organization|project/i);
  });

  test("fetches log with valid auth", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "log",
      "view",
      `${TEST_ORG}/${TEST_PROJECT}`,
      TEST_LOG_ID,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Log");
    expect(result.stdout).toContain(TEST_LOG_ID);
  });

  test("supports --json output", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "log",
      "view",
      `${TEST_ORG}/${TEST_PROJECT}`,
      TEST_LOG_ID,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    // jsonTransform preserves the bare-array contract
    expect(data).toBeInstanceOf(Array);
    expect(data).toHaveLength(1);
    expect(data[0]["sentry.item_id"]).toBe(TEST_LOG_ID);
  });

  test("handles non-existent log", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    // Valid hex format but doesn't exist in the mock server
    const result = await ctx.run([
      "log",
      "view",
      `${TEST_ORG}/${TEST_PROJECT}`,
      "deadbeefdeadbeefdeadbeefdeadbeef",
    ]);

    expect(result.exitCode).toBe(EXIT.RESOLUTION);
    expect(result.stderr + result.stdout).toMatch(/not found|no log/i);
  });
});
