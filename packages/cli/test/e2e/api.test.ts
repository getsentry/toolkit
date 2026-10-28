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
import { paginate } from "../../src/lib/api/infrastructure.js";
import { EXIT } from "../../src/lib/errors.js";
import { createE2EContext, type E2EContext, runCli } from "../fixture.js";
import organizationsFixture from "../fixtures/organizations.json";
import transactionsFixture from "../fixtures/transactions.json";
import { cleanupTestDir, createTestConfigDir } from "../helpers.js";
import { apiRoutes, TEST_TOKEN } from "../mocks/routes.js";
import { createMockServer, type MockServer } from "../mocks/server.js";

let testConfigDir: string;
let mockServer: MockServer;
let ctx: E2EContext;
const paginationRequests: URL[] = [];
const preparedRequests: {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}[] = [];
const nextCursor = "2:1:0";
const prevCursor = "2:0:1";
const alternateToken = "test-api-other-identity";
const cursorOrganizations = Array.from({ length: 4 }, (_, index) => ({
  ...organizationsFixture[index % organizationsFixture.length],
  id: String(100_001 + index),
  slug: `test-org-${index + 1}`,
  name: `Test Organization ${index + 1}`,
}));
const cursorTransactions = Array.from({ length: 4 }, (_, index) => ({
  ...transactionsFixture.data[index % transactionsFixture.data.length],
  id: String(index + 1).padStart(16, "0"),
}));
let failNextPage = false;

beforeAll(async () => {
  mockServer = createMockServer(
    [
      ...apiRoutes,
      {
        method: "POST",
        path: "/api/0/api-prepared-request/",
        response: async (req) => {
          preparedRequests.push({
            url: req.url,
            method: req.method,
            headers: req.headers,
            body: await req.text(),
          });
          return {
            status: 422,
            body: { detail: "Unsupported request", meta: { field: "title" } },
          };
        },
      },
      {
        method: "GET",
        path: "/api/0/api-pagination/",
        response: (req, _params, serverUrl) => {
          const url = new URL(req.url);
          paginationRequests.push(url);
          if (url.searchParams.get("cursor") === nextCursor && failNextPage) {
            failNextPage = false;
            return { status: 403, body: { detail: "Access denied" } };
          }
          const perPage = Number(url.searchParams.get("per_page") ?? "2");
          const page = Number(
            url.searchParams.get("cursor")?.split(":")[1] ?? "0",
          );
          const start = page * perPage;
          const next = `${perPage}:${page + 1}:0`;
          const previous = `${perPage}:${page - 1}:1`;
          const envelope = url.searchParams.get("envelope") === "events";
          const rows = envelope ? cursorTransactions : cursorOrganizations;
          const data = rows.slice(start, start + perPage);
          return {
            body: envelope ? { ...transactionsFixture, data } : data,
            headers: {
              "Cache-Control": "no-store",
              Link:
                `<${serverUrl}/api/0/api-pagination/?cursor=${next}>; rel="next"; results="${start + perPage < rows.length}"; cursor="${next}", ` +
                `<${serverUrl}/api/0/api-pagination/?cursor=${previous}>; rel="previous"; results="${page > 0}"; cursor="${previous}"`,
            },
          };
        },
      },
    ],
    { validTokens: [TEST_TOKEN, alternateToken] },
  );
  await mockServer.start();
});

afterAll(() => {
  mockServer.stop();
});

beforeEach(async () => {
  paginationRequests.length = 0;
  preparedRequests.length = 0;
  failNextPage = false;
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

  test("previews and dispatches a raw input file with custom headers", async () => {
    await ctx.setAuthToken(TEST_TOKEN);
    const file = `${testConfigDir}/request.txt`;
    await writeFile(file, "raw payload");
    const args = [
      "api",
      "api-prepared-request/",
      "--method",
      "POST",
      "--input",
      file,
      "-H",
      "content-type: application/custom",
      "--json",
    ];

    const preview = await ctx.run([...args, "--dry-run"]);
    expect(preview.exitCode, preview.stderr + preview.stdout).toBe(0);
    expect(preparedRequests).toHaveLength(0);
    const request = JSON.parse(preview.stdout);
    const previewHeaders = new Headers(request.headers);
    expect(request.body).toBe("raw payload");
    expect(previewHeaders.get("Content-Type")).toBe("application/custom");
    expect(previewHeaders.has("Authorization")).toBe(false);

    const result = await ctx.run(args);
    expect(result.exitCode).toBe(EXIT.OUTPUT_ERROR);
    expect(preparedRequests).toHaveLength(1);
    const sent = preparedRequests[0];
    expect(sent.url).toBe(request.url);
    expect(sent.method).toBe(request.method);
    expect(sent.body).toBe("raw payload");
    for (const [name, value] of previewHeaders) {
      expect(sent.headers.get(name)).toBe(value);
    }
    expect(sent.headers.get("Authorization")).toBe(`Bearer ${TEST_TOKEN}`);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 422,
      body: { detail: "Unsupported request", meta: { field: "title" } },
    });
  });

  test("navigates without repeating the endpoint or query arguments", async () => {
    await ctx.setAuthToken(TEST_TOKEN);
    const args = [
      "api",
      "api-pagination/?project=1&project=2&query=foo%23bar&cursor=url-old&cursor=url-older#anchor",
      "-F",
      "cursor=typed-old",
      "-f",
      "cursor=raw-old",
      "-f",
      "per_page=2",
      "--json",
      "--fields",
      "name",
    ];

    for (const [index, [cursor, start, hasPrev]] of (
      [
        ["first", 0, false],
        ["next", 2, true],
        ["prev", 0, false],
        ["next", 2, true],
        ["first", 0, false],
      ] as const
    ).entries()) {
      const navigationArgs =
        index === 0 ? args : ["api", "--json", "--fields", "name"];
      const result = await ctx.run([...navigationArgs, "-c", cursor]);
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      const page = JSON.parse(result.stdout);
      expect(page).toEqual({
        status: 200,
        statusText: "OK",
        body: cursorOrganizations
          .slice(start, start + 2)
          .map(({ name }) => ({ name })),
        pagination: hasPrev ? { prevCursor, hasPrev } : { nextCursor, hasPrev },
      });
      if (index === 0) {
        const detail = await ctx.run([
          "api",
          "organizations/test-org/",
          "--json",
        ]);
        expect(detail.exitCode, detail.stderr + detail.stdout).toBe(0);
      }
    }
    expect(
      paginationRequests.map((url) => url.searchParams.getAll("cursor")),
    ).toEqual([[], [nextCursor], [], [nextCursor], []]);
    for (const url of paginationRequests) {
      expect(url.searchParams.get("query")).toBe("foo#bar");
      expect(url.searchParams.get("per_page")).toBe("2");
      expect(url.searchParams.getAll("project")).toEqual(["1", "2"]);
    }
  });

  test("restores query parameters supplied as GET data", async () => {
    await ctx.setAuthToken(TEST_TOKEN);
    const first = await ctx.run([
      "api",
      `${mockServer.url}/api/0/api-pagination/?project=1&project=2`,
      "-d",
      '{"query":"level:error","per_page":2}',
      "--json",
    ]);
    expect(first.exitCode, first.stderr + first.stdout).toBe(0);

    const second = await ctx.run(["api", "-c", "next", "--json"]);
    expect(second.exitCode, second.stderr + second.stdout).toBe(0);
    expect(JSON.parse(second.stdout).body).toEqual(
      cursorOrganizations.slice(2),
    );
    expect(paginationRequests).toHaveLength(2);
    for (const request of paginationRequests) {
      expect(request.searchParams.get("query")).toBe("level:error");
      expect(request.searchParams.get("per_page")).toBe("2");
      expect(request.searchParams.getAll("project")).toEqual(["1", "2"]);
    }
  });

  test("dry-runs and failed requests do not advance pagination history", async () => {
    await ctx.setAuthToken(TEST_TOKEN);
    const request = ["api", "api-pagination/", "-f", "per_page=2"];
    const args = [...request, "--json"];
    const nextArgs = ["api", "--cursor", "next", "--json"];
    const preview = await ctx.run([...args, "--dry-run"]);
    expect(preview.exitCode, preview.stderr + preview.stdout).toBe(0);
    const missing = await ctx.run(nextArgs);
    expect(missing.exitCode).toBe(EXIT.VALIDATION);
    expect(paginationRequests).toHaveLength(0);

    const first = await ctx.run([...request, "--silent"]);
    expect(first.exitCode, first.stderr + first.stdout).toBe(0);
    expect(first.stdout).toBe("");
    const nextPreview = await ctx.run([...nextArgs, "--dry-run"]);
    expect(nextPreview.exitCode, nextPreview.stderr + nextPreview.stdout).toBe(
      0,
    );
    expect(
      new URL(JSON.parse(nextPreview.stdout).url).searchParams.get("cursor"),
    ).toBe(nextCursor);
    expect(paginationRequests).toHaveLength(1);

    failNextPage = true;
    const failed = await ctx.run(nextArgs);
    expect(failed.exitCode).toBe(EXIT.OUTPUT_ERROR);
    expect(JSON.parse(failed.stdout).status).toBe(403);
    const retried = await ctx.run(nextArgs);
    expect(retried.exitCode, retried.stderr + retried.stdout).toBe(0);
    expect(JSON.parse(retried.stdout).body).toEqual(
      cursorOrganizations.slice(2),
    );
    expect(
      paginationRequests.map((url) => url.searchParams.get("cursor")),
    ).toEqual([null, nextCursor, nextCursor]);
    const exhausted = await ctx.run(nextArgs);
    expect(exhausted.exitCode).toBe(EXIT.VALIDATION);
    expect(paginationRequests).toHaveLength(3);
  });

  test.each(["query", "host", "identity", "headers"])(
    "does not reuse pagination history after changing the %s",
    async (change) => {
      const args = ["api", "api-pagination/", "-f", "per_page=2", "--json"];
      const env = {
        SENTRY_AUTH_TOKEN: TEST_TOKEN,
        SENTRY_TOKEN: "",
        SENTRY_CONFIG_DIR: testConfigDir,
        SENTRY_URL: mockServer.url,
        SENTRY_CLI_NO_TELEMETRY: "1",
        SENTRY_CUSTOM_HEADERS: "X-Test-Query: initial",
      };
      const first = await runCli(args, { env });
      expect(first.exitCode, first.stderr + first.stdout).toBe(0);
      const changed = await runCli(
        [
          ...(change === "query" ? args : ["api", "--json"]),
          "--cursor",
          change === "headers" ? "first" : "next",
          ...(change === "query" ? ["-f", "query=other"] : []),
        ],
        {
          env: {
            ...env,
            SENTRY_URL:
              change === "host"
                ? mockServer.url.replace("localhost", "127.0.0.1")
                : mockServer.url,
            SENTRY_AUTH_TOKEN:
              change === "identity" ? alternateToken : TEST_TOKEN,
            SENTRY_CUSTOM_HEADERS:
              change === "headers"
                ? "X-Test-Query: changed"
                : env.SENTRY_CUSTOM_HEADERS,
          },
        },
      );
      expect(changed.exitCode).toBe(EXIT.VALIDATION);
      expect(paginationRequests).toHaveLength(1);
      const resumed = await runCli(["api", "--cursor", "next", "--json"], {
        env,
      });
      expect(resumed.exitCode, resumed.stderr + resumed.stdout).toBe(0);
      expect(JSON.parse(resumed.stdout).body).toEqual(
        cursorOrganizations.slice(2),
      );
      expect(paginationRequests).toHaveLength(2);
    },
  );

  test("requires an explicit query when another saved query is exhausted", async () => {
    await ctx.setAuthToken(TEST_TOKEN);
    const firstArgs = ["api", "api-pagination/?query=first", "--json"];
    const first = await ctx.run(firstArgs);
    expect(first.exitCode, first.stderr + first.stdout).toBe(0);
    const exhausted = await ctx.run(["api", "-c", "next", "--json"]);
    expect(exhausted.exitCode, exhausted.stderr + exhausted.stdout).toBe(0);
    expect(JSON.parse(exhausted.stdout).pagination.nextCursor).toBeUndefined();

    const other = await ctx.run([
      "api",
      "api-pagination/?query=other",
      "--json",
    ]);
    expect(other.exitCode, other.stderr + other.stdout).toBe(0);
    const ambiguous = await ctx.run(["api", "-c", "next", "--json"]);
    expect(ambiguous.exitCode).toBe(EXIT.VALIDATION);
    expect(ambiguous.stderr + ambiguous.stdout).toMatch(
      /multiple|more than one|ambiguous/i,
    );
    expect(paginationRequests).toHaveLength(3);

    const previous = await ctx.run([...firstArgs, "-c", "prev"]);
    expect(previous.exitCode, previous.stderr + previous.stdout).toBe(0);
    expect(JSON.parse(previous.stdout).body).toEqual(
      cursorOrganizations.slice(0, 2),
    );
    expect(paginationRequests.at(-1)?.searchParams.get("query")).toBe("first");
  });

  test("does not resume past a saved request that used explicit headers", async () => {
    await ctx.setAuthToken(TEST_TOKEN);
    const protectedRequest = await ctx.run([
      "api",
      "api-pagination/?query=protected",
      "-H",
      "X-Test-Query: private-value",
      "--json",
    ]);
    expect(
      protectedRequest.exitCode,
      protectedRequest.stderr + protectedRequest.stdout,
    ).toBe(0);
    const unsupported = await ctx.run(["api", "-c", "next", "--json"]);
    expect(unsupported.exitCode).toBe(EXIT.VALIDATION);
    expect(unsupported.stderr + unsupported.stdout).toMatch(/endpoint|header/i);
    expect(paginationRequests).toHaveLength(1);

    const other = await ctx.run([
      "api",
      "api-pagination/?query=other",
      "--json",
    ]);
    expect(other.exitCode, other.stderr + other.stdout).toBe(0);
    const ambiguous = await ctx.run(["api", "-c", "next", "--json"]);
    expect(ambiguous.exitCode).toBe(EXIT.VALIDATION);
    expect(ambiguous.stderr + ambiguous.stdout).toMatch(
      /multiple|more than one|ambiguous/i,
    );
    expect(paginationRequests).toHaveLength(2);
  });

  test.each([
    { name: "no cursor", args: [] },
    { name: "a mutation without a cursor", args: ["-X", "POST"] },
    { name: "a raw cursor", args: ["-c", nextCursor] },
    { name: "GET data", args: ["-c", "next", "-d", "query=other"] },
    { name: "a typed field", args: ["-c", "next", "-F", "per_page=1"] },
    { name: "a raw field", args: ["-c", "next", "-f", "query=other"] },
    { name: "a header", args: ["-c", "next", "-H", "X-Test: value"] },
    { name: "stdin input", args: ["-c", "next", "--input", "-"] },
    { name: "a mutation", args: ["-c", "next", "-X", "POST"] },
  ])(
    "rejects $name without an endpoint before sending another request",
    async ({ args }) => {
      await ctx.setAuthToken(TEST_TOKEN);
      const first = await ctx.run(["api", "api-pagination/", "--json"]);
      expect(first.exitCode, first.stderr + first.stdout).toBe(0);
      const result = await ctx.run(["api", ...args, "--json"]);
      expect(result.exitCode).toBe(
        args.includes("-c") ? EXIT.VALIDATION : EXIT.CONTEXT_MISSING,
      );
      expect(result.stderr + result.stdout).toMatch(/endpoint|GET/i);
      expect(paginationRequests).toHaveLength(1);
    },
  );

  test.each([
    { format: "shared", envelope: false },
    { format: "legacy", envelope: true },
  ])(
    "resumes a $format bookmark across next and prev",
    async ({ format, envelope }) => {
      await ctx.setAuthToken(TEST_TOKEN);
      const rows = envelope ? cursorTransactions : cursorOrganizations;
      const nativePage = await paginate<{ id: string }>(
        { limit: 1, cursor: "2:0:0" },
        () => Promise.resolve({ data: rows.slice(0, 2), nextCursor }),
      );
      expect(nativePage.nextCursor).toBeDefined();
      const cursor =
        format === "legacy" ? "cli1~2~1~2:0:0" : String(nativePage.nextCursor);
      const args = [
        "api",
        `api-pagination/${envelope ? "?envelope=events" : ""}`,
        "-f",
        "per_page=9",
        "--json",
      ];
      const preview = await ctx.run([...args, "--cursor", cursor, "--dry-run"]);
      expect(preview.exitCode, preview.stderr + preview.stdout).toBe(0);
      const url = new URL(JSON.parse(preview.stdout).url);
      expect(url.searchParams.get("per_page")).toBe("2");
      expect(url.searchParams.get("cursor")).toBe("2:0:0");
      expect(paginationRequests).toHaveLength(0);

      for (const [pageCursor, data, hasPrev] of [
        [cursor, rows.slice(1, 2), false],
        ["next", rows.slice(2), true],
        ["prev", rows.slice(1, 2), false],
      ] as const) {
        const navigationArgs = pageCursor === cursor ? args : ["api", "--json"];
        const result = await ctx.run([
          ...navigationArgs,
          "--cursor",
          pageCursor,
        ]);
        expect(result.exitCode, result.stderr + result.stdout).toBe(0);
        const page = JSON.parse(result.stdout);
        expect(page.body).toEqual(
          envelope ? { ...transactionsFixture, data } : data,
        );
        expect(page.pagination.hasPrev).toBe(hasPrev);
        expect(page.pagination.nextCursor).toBe(
          hasPrev ? undefined : nextCursor,
        );
      }
      expect(paginationRequests[0].href).toBe(url.href);
      expect(
        paginationRequests.map((request) => request.searchParams.get("cursor")),
      ).toEqual(["2:0:0", nextCursor, "2:0:0"]);
      expect(
        paginationRequests.every(
          (request) => request.searchParams.get("per_page") === "2",
        ),
      ).toBe(true);
    },
  );

  test("rejects mid-page bookmarks on object responses without saving history", async () => {
    await ctx.setAuthToken(TEST_TOKEN);
    const args = ["api", "organizations/test-org/", "--json"];
    const result = await ctx.run([...args, "--cursor", "cli1~2~1~"]);
    expect(result.exitCode).toBe(EXIT.VALIDATION);
    expect(result.stderr + result.stdout).toContain("not an array");
    const next = await ctx.run([...args, "--cursor", "next"]);
    expect(next.exitCode).toBe(EXIT.VALIDATION);
    expect(next.stderr + next.stdout).toContain("No next page saved");
  });

  test("rejects --cursor for non-GET requests before sending them", async () => {
    await ctx.setAuthToken(TEST_TOKEN);
    const result = await ctx.run([
      "api",
      "api-prepared-request/",
      "--method",
      "POST",
      "--cursor",
      nextCursor,
    ]);

    expect(result.exitCode).toBe(EXIT.VALIDATION);
    expect(result.stdout + result.stderr).toMatch(/cursor.*GET|GET.*cursor/i);
    expect(preparedRequests).toHaveLength(0);
  });

  test("empty error bodies report the HTTP status and request", async () => {
    await ctx.setAuthToken(TEST_TOKEN);

    const result = await ctx.run(["api", "empty-error/"]);

    expect(result.exitCode).toBe(EXIT.OUTPUT_ERROR);
    expect(result.stdout).toContain(
      "HTTP 404 Not Found — GET /api/0/empty-error/",
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
    },
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
    },
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
      expect(result.stderr).toContain(
        `> GET ${mockServer.url}/api/0/organizations/`,
      );
      expect(result.stderr).toMatch(/< HTTP 200 OK/);
      expect(result.stderr).toMatch(/< content-type:/i);
      // stdout should still contain the response body
      const data = JSON.parse(result.stdout);
      expect(Array.isArray(data)).toBe(true);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Input From File Tests
  // ─────────────────────────────────────────────────────────────────────────────

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
    },
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
    },
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
    },
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
        /--data.*--input|--input.*--data/i,
      );
    },
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
        /--data.*--field|--field.*--data/i,
      );
    },
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
        /--data.*--field|--field.*--data/i,
      );
    },
  );
});
