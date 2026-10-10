/**
 * Auth Command E2E Tests
 *
 * Tests for sentry auth login, logout, and status commands.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { Database } from "../../src/lib/db/sqlite.js";
import { EXIT } from "../../src/lib/errors.js";
import { createE2EContext, type E2EContext, runCli } from "../fixture.js";
import { cleanupTestDir, createTestConfigDir } from "../helpers.js";
import { createSentryMockServer, TEST_TOKEN } from "../mocks/routes.js";
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
  testConfigDir = await createTestConfigDir("e2e-auth-");
  ctx = createE2EContext(testConfigDir, mockServer.url);
});

afterEach(async () => {
  await cleanupTestDir(testConfigDir);
});

describe("sentry auth status", () => {
  test("shows not authenticated when no token", async () => {
    const result = await ctx.run(["auth", "status"]);

    // Error message may be in stdout or stderr depending on CLI framework
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/not authenticated/i);
    expect(result.exitCode).toBe(EXIT.AUTH_NOT_AUTHENTICATED);
  });

  test("shows authenticated with valid token", async () => {
    // Set up auth token in config
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["auth", "status"]);

    // Status messages go to stderr via consola
    const output = result.stdout + result.stderr;
    expect(output).toContain("Authenticated");
    expect(result.exitCode).toBe(0);
  });

  test("verifies credentials with valid token", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["auth", "status"]);

    expect(result.exitCode).toBe(0);
    // Status messages go to stderr via consola
    const output = result.stdout + result.stderr;
    expect(output).toContain("Authenticated");
    expect(output).toContain("Access verified");
  });
});

describe("sentry auth login --token", () => {
  test("stores valid API token", { timeout: 10_000 }, async () => {
    const result = await ctx.run([
      "auth",
      "login",
      "--token",
      TEST_TOKEN,
      "--url",
      ctx.serverUrl,
    ]);

    // Login messages go to stderr via consola
    const output = result.stdout + result.stderr;
    expect(output).toContain("Authenticated");
    expect(result.exitCode).toBe(0);

    // Verify token was stored
    const statusResult = await ctx.run(["auth", "status"]);
    const statusOutput = statusResult.stdout + statusResult.stderr;
    expect(statusOutput).toContain("Authenticated");
  });

  test("rejects invalid token", async () => {
    const result = await ctx.run([
      "auth",
      "login",
      "--token",
      "invalid-token-12345",
    ]);

    expect(result.exitCode).toBe(EXIT.AUTH_HOST_SCOPE);
    expect(result.stderr + result.stdout).toMatch(
      /invalid|unauthorized|error/i,
    );
  });
});

describe("sentry auth whoami", () => {
  test("rejects a split stored token without exposing it in JSON mode", async () => {
    const token = "sntryu_SYNTHETIC-PREFIX\nSYNTHETIC-SECRET-TAIL";
    await ctx.setAuthToken(TEST_TOKEN);
    // Model a pre-validation credential; the setter now rejects this input.
    const db = new Database(join(ctx.configDir, "cli.db"));
    try {
      db.query("UPDATE auth SET token = ? WHERE id = 1").run(token);
    } finally {
      db.close();
    }

    const result = await ctx.run(["auth", "whoami", "--json"]);
    const output = result.stdout + result.stderr;

    expect(result.exitCode).toBe(EXIT.AUTH_INVALID);
    expect(output).toContain("single line");
    expect(output).not.toContain("SYNTHETIC-PREFIX");
    expect(output).not.toContain("SYNTHETIC-SECRET-TAIL");
    expect(output).not.toContain("Headers.set");
  });

  test("requires authentication", async () => {
    const result = await ctx.run(["auth", "whoami"]);

    const output = result.stdout + result.stderr;
    expect(output).toMatch(/not authenticated/i);
    expect(result.exitCode).toBe(EXIT.AUTH_NOT_AUTHENTICATED);
  });

  test("shows current user identity", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["auth", "whoami"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test@example.com");
  });

  test("supports --json output", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["auth", "whoami", "--json"]);

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.id).toBe("12345");
    expect(json.email).toBe("test@example.com");
    expect(json.username).toBe("testuser");
  });

  test("sentry whoami top-level alias works", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["whoami"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test@example.com");
  });
});

describe("auth formatting recovery", () => {
  test("forced login rejects a split token without losing the previous login", async () => {
    await ctx.setAuthToken(TEST_TOKEN);
    const result = await ctx.run([
      "auth",
      "login",
      "--force",
      "--token",
      "synthetic-secret-prefix\nsynthetic-secret-tail",
      "--url",
      "https://different.example.com",
    ]);
    expect(result.exitCode).toBe(EXIT.AUTH_INVALID);
    expect(result.stdout + result.stderr).toContain("single line");
    expect(result.stdout + result.stderr).not.toContain("synthetic-secret");

    const stored = await ctx.run(["auth", "token"]);
    expect(stored.exitCode).toBe(0);
    expect(stored.stdout.trim()).toBe(TEST_TOKEN);
    // The previous credential must still work against its original host.
    expect((await ctx.run(["auth", "whoami"])).exitCode).toBe(0);
  });

  test("malformed legacy JSON does not prevent help or logout", async () => {
    const path = join(ctx.configDir, "config.json");
    const contents = JSON.stringify({
      auth: { token: "synthetic-secret-prefix\0synthetic-secret-tail" },
    });
    await writeFile(path, contents);

    for (const args of [["--help"], ["auth", "logout"]]) {
      const result = await ctx.run(args);
      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).not.toContain("synthetic-secret");
      expect(await readFile(path, "utf8")).toBe(contents);
    }
  });
});

describe("sentry auth logout", () => {
  test("clears stored auth", { timeout: 15_000 }, async () => {
    // First login (--url required for non-SaaS mock server)
    const loginResult = await ctx.run([
      "auth",
      "login",
      "--token",
      TEST_TOKEN,
      "--url",
      ctx.serverUrl,
    ]);
    expect(loginResult.exitCode).toBe(0);

    // Then logout
    const result = await ctx.run(["auth", "logout"]);

    expect(result.exitCode).toBe(0);
    // Logout messages go to stderr via consola
    const logoutOutput = result.stdout + result.stderr;
    expect(logoutOutput).toMatch(/logged out/i);

    // Verify we're logged out
    const statusResult = await ctx.run(["auth", "status"]);
    const output = statusResult.stdout + statusResult.stderr;
    expect(output).toMatch(/not authenticated/i);
  });

  test("succeeds even when not authenticated", async () => {
    const result = await ctx.run(["auth", "logout"]);

    // Should not error, just inform user
    expect(result.exitCode).toBe(0);
  });
});

describe("command error redaction", () => {
  test("redacts unexpected command errors handled inside Stricli", async () => {
    const result = await runCli(["auth", "whoami", "--json"], {
      env: {
        SENTRY_CONFIG_DIR: testConfigDir,
        SENTRY_URL: mockServer.url,
        SENTRY_AUTH_TOKEN: TEST_TOKEN,
        SENTRY_FORCE_ENV_TOKEN: "1",
        SENTRY_CUSTOM_HEADERS:
          "X-Proxy: Bearer SYNTHETIC-PREFIX\rSYNTHETIC-SECRET-TAIL",
        SENTRY_CLI_NO_TELEMETRY: "1",
      },
    });
    const output = result.stdout + result.stderr;

    expect(result.exitCode).toBe(EXIT.GENERAL);
    expect(output).toContain("Unexpected error: TypeError:");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("SYNTHETIC-PREFIX");
    expect(output).not.toContain("SYNTHETIC-SECRET-TAIL");
  });
});
