/**
 * Project/Org Command E2E Tests
 *
 * Tests for sentry project and org commands (list, get).
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
  TEST_DSN,
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
  testConfigDir = await createTestConfigDir("e2e-project-");
  ctx = createE2EContext(testConfigDir, mockServer.url);
});

afterEach(async () => {
  await cleanupTestDir(testConfigDir);
});

describe("sentry org list", () => {
  test("requires authentication", async () => {
    const result = await ctx.run(["org", "list"]);

    expect(result.exitCode).toBe(EXIT.AUTH_NOT_AUTHENTICATED);
    expect(result.stderr + result.stdout).toMatch(/not authenticated|login/i);
  });

  test("lists organizations with valid auth", { timeout: 15_000 }, async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["org", "list"]);

    expect(result.exitCode).toBe(0);
    // Should contain header and at least one org
    expect(result.stdout).toContain("SLUG");
  });

  test("supports --json output", { timeout: 15_000 }, async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["org", "list", "--json"]);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });
});

describe("sentry project list", () => {
  test("requires authentication", async () => {
    const result = await ctx.run(["project", "list"]);

    expect(result.exitCode).toBe(EXIT.AUTH_NOT_AUTHENTICATED);
    expect(result.stderr + result.stdout).toMatch(/not authenticated|login/i);
  });

  test(
    "lists projects with valid auth using positional org arg",
    { timeout: 15_000 },
    async () => {
      await ctx.setAuthToken(TEST_TOKEN);

      // Use org/ syntax for org-scoped listing
      const result = await ctx.run([
        "project",
        "list",
        `${TEST_ORG}/`,
        "--limit",
        "5",
      ]);

      expect(result.exitCode).toBe(0);
    }
  );

  test("supports --json output", { timeout: 15_000 }, async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    // Use org/ syntax for org-scoped listing
    const result = await ctx.run([
      "project",
      "list",
      `${TEST_ORG}/`,
      "--json",
      "--limit",
      "5",
    ]);

    expect(result.exitCode).toBe(0);
    // JSON output in paginated mode wraps data in { data, hasMore }
    const parsed = JSON.parse(result.stdout);
    const data = Array.isArray(parsed) ? parsed : parsed.data;
    expect(Array.isArray(data)).toBe(true);
  });
});

describe("sentry org view", () => {
  test("requires authentication", async () => {
    const result = await ctx.run(["org", "view", TEST_ORG]);

    expect(result.exitCode).toBe(EXIT.AUTH_NOT_AUTHENTICATED);
    expect(result.stderr + result.stdout).toMatch(/not authenticated|login/i);
  });

  test("gets organization details", { timeout: 15_000 }, async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["org", "view", TEST_ORG]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(TEST_ORG);
    expect(result.stdout).toContain("Slug");
  });

  test("supports --json output", { timeout: 15_000 }, async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["org", "view", TEST_ORG, "--json"]);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.slug).toBe(TEST_ORG);
  });

  test("handles non-existent org", { timeout: 15_000 }, async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["org", "view", "nonexistent-org-12345"]);

    expect(result.exitCode).toBe(EXIT.API);
    expect(result.stderr + result.stdout).toMatch(/not found|error|404/i);
  });
});

describe("sentry project view", () => {
  test("requires authentication", async () => {
    const result = await ctx.run([
      "project",
      "view",
      `${TEST_ORG}/${TEST_PROJECT}`,
    ]);

    expect(result.exitCode).toBe(EXIT.AUTH_NOT_AUTHENTICATED);
    expect(result.stderr + result.stdout).toMatch(/not authenticated|login/i);
  });

  test("requires org and project", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["project", "view"]);

    expect(result.exitCode).toBe(EXIT.CONTEXT_MISSING);
    expect(result.stderr + result.stdout).toMatch(/organization|project/i);
  });

  test("rejects org-only target (org/)", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["project", "view", `${TEST_ORG}/`]);

    expect(result.exitCode).toBe(EXIT.CONTEXT_MISSING);
    // Should show error with usage hint
    const output = result.stderr + result.stdout;
    expect(output).toMatch(/specific project is required/i);
    expect(output).toContain(`sentry project view ${TEST_ORG}/<project>`);
  });

  test("gets project details", { timeout: 15_000 }, async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "project",
      "view",
      `${TEST_ORG}/${TEST_PROJECT}`,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(TEST_PROJECT);
    expect(result.stdout).toContain("Slug");
  });

  test(
    "displays DSN in human-readable output",
    { timeout: 15_000 },
    async () => {
      await ctx.setAuthToken(TEST_TOKEN);

      const result = await ctx.run([
        "project",
        "view",
        `${TEST_ORG}/${TEST_PROJECT}`,
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("DSN");
      expect(result.stdout).toContain(TEST_DSN);
    }
  );

  test("supports --json output", { timeout: 15_000 }, async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "project",
      "view",
      `${TEST_ORG}/${TEST_PROJECT}`,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(Array.isArray(data)).toBe(true);
    expect(data[0].slug).toBe(TEST_PROJECT);
  });

  test("includes DSN in JSON output", { timeout: 15_000 }, async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "project",
      "view",
      `${TEST_ORG}/${TEST_PROJECT}`,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(Array.isArray(data)).toBe(true);
    expect(data[0].dsn).toBe(TEST_DSN);
  });

  test("handles non-existent project", { timeout: 15_000 }, async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "project",
      "view",
      `${TEST_ORG}/nonexistent-project-12345`,
    ]);

    expect(result.exitCode).toBe(EXIT.API);
    expect(result.stderr + result.stdout).toMatch(/not found|error|404/i);
  });
});
