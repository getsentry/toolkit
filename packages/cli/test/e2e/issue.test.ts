/**
 * Issue Command E2E Tests
 *
 * Tests for sentry issue list and get commands.
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
  testConfigDir = await createTestConfigDir("e2e-issue-");
  ctx = createE2EContext(testConfigDir, mockServer.url);
});

afterEach(async () => {
  await cleanupTestDir(testConfigDir);
});

describe("sentry issue list", () => {
  test("requires authentication", async () => {
    const result = await ctx.run([
      "issue",
      "list",
      `${TEST_ORG}/${TEST_PROJECT}`,
    ]);

    expect(result.exitCode).toBe(EXIT.AUTH_NOT_AUTHENTICATED);
    expect(result.stderr + result.stdout).toMatch(/not authenticated|login/i);
  });

  test("lists issues with valid auth using positional arg", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "issue",
      "list",
      `${TEST_ORG}/${TEST_PROJECT}`,
    ]);

    // Should succeed (may have 0 issues, that's fine)
    expect(result.exitCode).toBe(0);
  });

  test("supports --json output", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "issue",
      "list",
      `${TEST_ORG}/${TEST_PROJECT}`,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    // Multi-target mode wraps output in {data, hasMore} object
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty("data");
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed).toHaveProperty("hasMore");
  });

  test("lists all projects in org with trailing slash", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["issue", "list", `${TEST_ORG}/`, "--json"]);

    expect(result.exitCode).toBe(0);
    // Org-all mode returns paginated JSON object with data array and hasMore flag
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty("data");
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed).toHaveProperty("hasMore");
  });

  test("searches for project across orgs with project-only arg", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["issue", "list", TEST_PROJECT, "--json"]);

    // Should succeed if project exists in any accessible org
    // or fail with a "not found" error if not
    if (result.exitCode === 0) {
      // Multi-target mode wraps output in {data, hasMore} object
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toHaveProperty("data");
      expect(Array.isArray(parsed.data)).toBe(true);
    } else {
      expect(result.stderr + result.stdout).toMatch(/not found|no project/i);
    }
  });
});

describe("sentry issue view", () => {
  test("requires authentication", async () => {
    const result = await ctx.run(["issue", "view", "12345"]);

    expect(result.exitCode).toBe(EXIT.AUTH_NOT_AUTHENTICATED);
    expect(result.stderr + result.stdout).toMatch(/not authenticated|login/i);
  });

  test("handles non-existent issue", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["issue", "view", "99999999999"]);

    expect(result.exitCode).toBe(EXIT.RESOLUTION);
    expect(result.stderr + result.stdout).toMatch(/not found|error/i);
  });
});
