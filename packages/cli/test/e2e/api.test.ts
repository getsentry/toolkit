/**
 * API Command E2E Tests
 *
 * Tests for sentry api command - raw authenticated API requests.
 */

import { writeFile } from "node:fs/promises";
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
  testConfigDir = await createTestConfigDir("e2e-api-");
  ctx = createE2EContext(testConfigDir, mockServer.url);
});

afterEach(async () => {
  await cleanupTestDir(testConfigDir);
});

describe("sentry api", () => {
  // Note: The API client's base URL already includes /api/0/, so endpoints
  // should NOT include that prefix (e.g., use "organizations/" not "/api/0/organizations/")

  test("requires authentication", async () => {
    const result = await ctx.run(["api", "organizations/"]);

    expect(result.exitCode).toBe(EXIT.AUTH_NOT_AUTHENTICATED);
    expect(result.stderr + result.stdout).toMatch(/not authenticated|login/i);
  });

  test("GET request works with valid auth", { timeout: 15_000 }, async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["api", "organizations/"]);

    expect(result.exitCode).toBe(0);
    // Should return JSON array of organizations
    const data = JSON.parse(result.stdout);
    expect(Array.isArray(data)).toBe(true);
  });

  test("GET request accepts an absolute Sentry API URL", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "api",
      `${mockServer.url}/api/0/organizations/`,
    ]);

    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expect.any(Array));
  });
  test("--json includes the HTTP response envelope", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["api", "organizations/", "--json"]);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data).toMatchObject({
      status: 200,
      statusText: "OK",
      body: expect.any(Array),
    });
  });

  test("--json applies --fields to the API body inside the envelope", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "api",
      "organizations/",
      "--json",
      "--fields",
      "name",
    ]);

    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: 200,
      statusText: "OK",
      body: [{ name: "Test Organization" }, { name: "Test Organization 2" }],
    });
  });

  test("--dry-run --json applies --fields to the request preview", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "api",
      "organizations/",
      "--dry-run",
      "--json",
      "--fields",
      "method",
    ]);

    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ method: "GET" });
  });

  test("empty error bodies report the HTTP status and request", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["api", "empty-error/"]);

    expect(result.exitCode).toBe(EXIT.OUTPUT_ERROR);
    expect(result.stdout).toContain(
      "HTTP 404 Not Found — GET /api/0/empty-error/"
    );
  });

  test("--json preserves empty error bodies in the response envelope", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["api", "empty-error/", "--json"]);

    expect(result.exitCode).toBe(EXIT.OUTPUT_ERROR);
    expect(JSON.parse(result.stdout)).toEqual({
      status: 404,
      statusText: "Not Found",
      body: "",
    });
  });

  test(
    "invalid endpoint returns non-zero exit code",
    { timeout: 15_000 },
    async () => {
      await ctx.setAuthToken(TEST_TOKEN);

      const result = await ctx.run(["api", "nonexistent-endpoint-12345/"]);

      expect(result.exitCode).toBe(EXIT.OUTPUT_ERROR);
    }
  );

  test("--silent flag suppresses output", { timeout: 15_000 }, async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["api", "organizations/", "--silent"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test(
    "--silent with error sets exit code but no output",
    { timeout: 15_000 },
    async () => {
      await ctx.setAuthToken(TEST_TOKEN);

      const result = await ctx.run([
        "api",
        "nonexistent-endpoint-12345/",
        "--silent",
      ]);

      expect(result.exitCode).toBe(EXIT.OUTPUT_ERROR);
      expect(result.stdout).toBe("");
    }
  );

  test("supports custom HTTP method", { timeout: 15_000 }, async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    // DELETE on organizations list should return 405 Method Not Allowed
    const result = await ctx.run([
      "api",
      "organizations/",
      "--method",
      "DELETE",
    ]);

    // Method not allowed or similar error - just checking it processes the flag
    expect(result.exitCode).toBe(EXIT.OUTPUT_ERROR);
  });

  test("rejects invalid HTTP method", { timeout: 15_000 }, async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run([
      "api",
      "organizations/",
      "--method",
      "INVALID",
    ]);

    // Exit code 252 is stricli's parse error code, 1 is a general error
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr + result.stdout).toMatch(/invalid method/i);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Alias Tests (curl/gh api compatibility)
  // ─────────────────────────────────────────────────────────────────────────────

  test("-X alias for --method works", { timeout: 15_000 }, async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    // Use -X POST on organizations list (should fail with 405)
    const result = await ctx.run(["api", "organizations/", "-X", "POST"]);

    // POST on list endpoint typically returns 405 or similar error
    expect(result.exitCode).toBe(EXIT.OUTPUT_ERROR);
  });

  test("-H alias for --header works", { timeout: 15_000 }, async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    // Add a custom header - the request should still succeed
    const result = await ctx.run([
      "api",
      "organizations/",
      "-H",
      "X-Custom-Header: test-value",
    ]);

    expect(result.exitCode).toBe(0);
    // Should return valid JSON
    const data = JSON.parse(result.stdout);
    expect(Array.isArray(data)).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Verbose Mode Tests
  // ─────────────────────────────────────────────────────────────────────────────

  test(
    "--verbose flag shows request and response details",
    { timeout: 15_000 },
    async () => {
      await ctx.setAuthToken(TEST_TOKEN);

      const result = await ctx.run(["api", "organizations/", "--verbose"]);

      expect(result.exitCode).toBe(0);
      // Verbose output goes to stderr via logger.debug()
      // consola formats as: [debug] [api] > GET /api/0/organizations/
      expect(result.stderr).toMatch(/> GET \/api\/0\/organizations\//);
      expect(result.stderr).toMatch(/< HTTP 200 OK/);
      expect(result.stderr).toMatch(/< content-type:/i);
      // stdout should still contain the response body
      const data = JSON.parse(result.stdout);
      expect(Array.isArray(data)).toBe(true);
    }
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Input From File Tests
  // ─────────────────────────────────────────────────────────────────────────────

  test("--input reads body from file", { timeout: 15_000 }, async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    // Create a temp file with JSON body
    const tempFile = `${testConfigDir}/input.json`;
    await writeFile(tempFile, JSON.stringify({ status: "resolved" }));

    // Try to update a non-existent issue - this will fail but tests the flow
    const result = await ctx.run([
      "api",
      "issues/999999999/",
      "-X",
      "PUT",
      "--input",
      tempFile,
    ]);

    // Will fail with 404 or similar, but the flag should be processed
    expect(result.exitCode).toBe(EXIT.OUTPUT_ERROR);
  });

  test(
    "--input with non-existent file throws error",
    { timeout: 15_000 },
    async () => {
      await ctx.setAuthToken(TEST_TOKEN);

      const result = await ctx.run([
        "api",
        "organizations/",
        "--input",
        "/nonexistent/file.json",
      ]);

      expect(result.exitCode).toBe(EXIT.VALIDATION);
      expect(result.stderr + result.stdout).toMatch(/file not found/i);
    }
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // GET/POST Field Routing Tests
  // ─────────────────────────────────────────────────────────────────────────────

  test(
    "GET request with --field uses query parameters (not body)",
    { timeout: 15_000 },
    async () => {
      await ctx.setAuthToken(TEST_TOKEN);

      // Use issues endpoint with query parameter - this tests that --field
      // with GET request properly converts fields to query params instead of body
      // (GET requests cannot have a body, so this would fail if fields went to body)
      const result = await ctx.run([
        "api",
        "projects/",
        "--field",
        "query=platform:javascript",
      ]);

      // Should succeed (not throw "GET/HEAD method cannot have body" error)
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(Array.isArray(data)).toBe(true);
    }
  );

  test(
    "POST request with --field uses request body",
    { timeout: 15_000 },
    async () => {
      await ctx.setAuthToken(TEST_TOKEN);

      // POST to a read-only endpoint will return 405, but the important thing
      // is that it doesn't fail with a client-side error about body/params
      const result = await ctx.run([
        "api",
        "organizations/",
        "--method",
        "POST",
        "--field",
        "name=test",
      ]);

      // Should get a server error (405 Method Not Allowed or 400 Bad Request),
      // not a client-side error about body handling
      expect(result.exitCode).toBe(EXIT.OUTPUT_ERROR);
      // The error should be from the API, not a TypeError about body
      expect(result.stdout + result.stderr).not.toMatch(/cannot have body/i);
    }
  );

  test(
    "--data and --input are mutually exclusive",
    { timeout: 15_000 },
    async () => {
      await ctx.setAuthToken(TEST_TOKEN);

      const result = await ctx.run([
        "api",
        "organizations/",
        "--method",
        "PUT",
        "--data",
        '{"name":"test"}',
        "--input",
        "-",
      ]);

      expect(result.exitCode).toBe(EXIT.VALIDATION);
      expect(result.stderr + result.stdout).toMatch(
        /--data.*--input|--input.*--data/i
      );
    }
  );

  test(
    "--data and --field are mutually exclusive",
    { timeout: 15_000 },
    async () => {
      await ctx.setAuthToken(TEST_TOKEN);

      const result = await ctx.run([
        "api",
        "organizations/",
        "--method",
        "PUT",
        "--data",
        '{"name":"test"}',
        "--field",
        "slug=my-org",
      ]);

      expect(result.exitCode).toBe(EXIT.VALIDATION);
      expect(result.stderr + result.stdout).toMatch(
        /--data.*--field|--field.*--data/i
      );
    }
  );

  test(
    "--data and --raw-field are mutually exclusive",
    { timeout: 15_000 },
    async () => {
      await ctx.setAuthToken(TEST_TOKEN);

      const result = await ctx.run([
        "api",
        "organizations/",
        "--method",
        "PUT",
        "-d",
        '{"name":"test"}',
        "-f",
        "slug=my-org",
      ]);

      expect(result.exitCode).toBe(EXIT.VALIDATION);
      expect(result.stderr + result.stdout).toMatch(
        /--data.*--field|--field.*--data/i
      );
    }
  );
});
