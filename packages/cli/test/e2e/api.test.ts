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
const nextCursor = "1:1:0";
const prevCursor = "1:0:1";
const alternateToken = "test-api-other-identity";
const cursorOrganizations = Array.from({ length: 6 }, (_, index) => ({
  ...organizationsFixture[index % organizationsFixture.length],
  id: String(100_001 + index),
  slug: `test-org-${index + 1}`,
  name: `Test Organization ${index + 1}`,
}));
const cursorTransactions = Array.from({ length: 6 }, (_, index) => ({
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
          const isSecondPage = url.searchParams.get("cursor") === nextCursor;
          if (isSecondPage && failNextPage) {
            failNextPage = false;
            return { status: 403, body: { detail: "Access denied" } };
          }
          return {
            body: [organizationsFixture[isSecondPage ? 1 : 0]],
            headers: {
              "Cache-Control": "no-store",
              Link:
                `<${serverUrl}/api/0/api-pagination/?cursor=${nextCursor}>; rel="next"; results="${!isSecondPage}"; cursor="${nextCursor}", ` +
                `<${serverUrl}/api/0/api-pagination/?cursor=${prevCursor}>; rel="previous"; results="${isSecondPage}"; cursor="${prevCursor}"`,
            },
          };
        },
      },
      {
        method: "GET",
        path: "/api/0/api-custom-cursor/",
        response: (req, _params, serverUrl) => {
          const url = new URL(req.url);
          paginationRequests.push(url);
          const perPage = Number(url.searchParams.get("per_page") ?? "2");
          const page = Number(
            url.searchParams.get("cursor")?.split(":")[1] ?? "0",
          );
          const start = page * perPage;
          const next = `${perPage}:${page + 1}:0`;
          const previous = `${perPage}:${page - 1}:1`;
          const isEventsEnvelope =
            url.searchParams.get("envelope") === "events";
          const rows = isEventsEnvelope
            ? cursorTransactions
            : cursorOrganizations;
          const data = rows.slice(start, start + perPage);
          return {
            body: isEventsEnvelope ? { ...transactionsFixture, data } : data,
            headers: {
              "Cache-Control": "no-store",
              Link:
                `<${serverUrl}/api/0/api-custom-cursor/?cursor=${next}>; rel="next"; results="${start + perPage < rows.length}"; cursor="${next}", ` +
                `<${serverUrl}/api/0/api-custom-cursor/?cursor=${previous}>; rel="previous"; results="${page > 0}"; cursor="${previous}"`,
            },
          };
        },
      },
      {
        method: "POST",
        path: "/api/0/api-pagination/",
        response: (req) => {
          paginationRequests.push(new URL(req.url));
          return { body: { accepted: true } };
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

  test.each([
    {
      name: "JSON data",
      input: '{"title":"Overview"}',
      body: { title: "Overview" },
      contentType: "application/json",
      fromFile: false,
      headers: [],
    },
    {
      name: "raw file",
      input: "raw payload",
      body: "raw payload",
      contentType: "text/plain;charset=UTF-8",
      fromFile: true,
      headers: [],
    },
    {
      name: "explicit Content-Type",
      input: '{"title":"Overview"}',
      body: { title: "Overview" },
      contentType: "application/custom",
      fromFile: false,
      headers: ["-H", "content-type: application/custom"],
    },
  ])(
    "dispatches the URL, headers and body shown by the $name preview",
    async ({ input, body, contentType, fromFile, headers }) => {
      await ctx.setAuthToken(TEST_TOKEN);
      let bodyFlags = ["--data", input];
      if (fromFile) {
        const file = `${testConfigDir}/request.txt`;
        await writeFile(file, input);
        bodyFlags = ["--input", file];
      }
      const args = [
        "api",
        "api-prepared-request/?field=id&field=title&query=a%20b",
        "--method",
        "POST",
        ...bodyFlags,
        "-H",
        "X-Example: custom-value",
        ...headers,
        "--json",
      ];

      const preview = await ctx.run([...args, "--dry-run"]);
      expect(preview.exitCode, preview.stderr + preview.stdout).toBe(0);
      expect(preparedRequests).toHaveLength(0);
      const request = JSON.parse(preview.stdout);
      const previewHeaders = new Headers(request.headers);
      expect(request.body).toEqual(body);
      expect(previewHeaders.get("Content-Type")).toBe(contentType);
      expect(previewHeaders.get("X-Example")).toBe("custom-value");
      expect(previewHeaders.has("Authorization")).toBe(false);

      const result = await ctx.run(args);
      expect(result.exitCode).toBe(EXIT.OUTPUT_ERROR);
      expect(preparedRequests).toHaveLength(1);
      const sent = preparedRequests[0];
      expect(sent.url).toBe(request.url);
      expect(sent.method).toBe(request.method);
      expect(sent.body).toBe(input);
      for (const [name, value] of previewHeaders) {
        expect(sent.headers.get(name)).toBe(value);
      }
      expect(sent.headers.get("Authorization")).toBe(`Bearer ${TEST_TOKEN}`);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: 422,
        body: { detail: "Unsupported request", meta: { field: "title" } },
      });
    },
  );

  test("navigates next, prev and first while preserving filters and --fields", async () => {
    await ctx.setAuthToken(TEST_TOKEN);
    const args = [
      "api",
      "api-pagination/?project=1&project=2",
      "-f",
      "query=level:error",
      "-f",
      "per_page=1",
      "--json",
      "--fields",
      "name",
    ];

    const first = await ctx.run(args);
    expect(first.exitCode, first.stderr + first.stdout).toBe(0);
    const firstPage = JSON.parse(first.stdout);
    expect(firstPage).toMatchObject({
      status: 200,
      statusText: "OK",
      pagination: { nextCursor, hasPrev: false },
    });
    expect(firstPage.body).toEqual([{ name: organizationsFixture[0].name }]);
    expect(paginationRequests).toHaveLength(1);

    const second = await ctx.run([...args, "--cursor", "next"]);
    expect(second.exitCode, second.stderr + second.stdout).toBe(0);
    const secondPage = JSON.parse(second.stdout);
    expect(secondPage).toMatchObject({
      status: 200,
      statusText: "OK",
      pagination: { prevCursor, hasPrev: true },
    });
    expect(secondPage.body).toEqual([{ name: organizationsFixture[1].name }]);
    expect(secondPage.pagination.nextCursor).toBeUndefined();
    expect(paginationRequests).toHaveLength(2);
    expect(paginationRequests[1].searchParams.getAll("cursor")).toEqual([
      nextCursor,
    ]);

    for (const [cursor, organization] of [
      ["prev", organizationsFixture[0]],
      ["next", organizationsFixture[1]],
      ["first", organizationsFixture[0]],
    ] as const) {
      const page = await ctx.run([
        ...args,
        ...(cursor === "first" ? ["-f", "cursor=stale"] : []),
        "-c",
        cursor,
      ]);
      expect(page.exitCode, page.stderr + page.stdout).toBe(0);
      expect(JSON.parse(page.stdout).body).toEqual([
        { name: organization.name },
      ]);
    }
    expect(paginationRequests).toHaveLength(5);
    expect(
      paginationRequests.map((url) => url.searchParams.get("cursor")),
    ).toEqual([null, nextCursor, null, nextCursor, null]);
    for (const url of paginationRequests) {
      expect(url.searchParams.get("query")).toBe("level:error");
      expect(url.searchParams.get("per_page")).toBe("1");
      expect(url.searchParams.getAll("project")).toEqual(["1", "2"]);
    }
  });

  test("dry-runs and failed requests do not advance pagination history", async () => {
    await ctx.setAuthToken(TEST_TOKEN);
    const args = ["api", "api-pagination/", "-f", "per_page=1", "--json"];
    const preview = await ctx.run([...args, "--dry-run"]);
    expect(preview.exitCode, preview.stderr + preview.stdout).toBe(0);
    const missing = await ctx.run([...args, "--cursor", "next"]);
    expect(missing.exitCode).toBe(EXIT.VALIDATION);
    expect(paginationRequests).toHaveLength(0);

    const first = await ctx.run(args);
    expect(first.exitCode, first.stderr + first.stdout).toBe(0);
    const nextPreview = await ctx.run([
      ...args,
      "--cursor",
      "next",
      "--dry-run",
    ]);
    expect(nextPreview.exitCode, nextPreview.stderr + nextPreview.stdout).toBe(
      0,
    );
    expect(
      new URL(JSON.parse(nextPreview.stdout).url).searchParams.get("cursor"),
    ).toBe(nextCursor);
    expect(paginationRequests).toHaveLength(1);

    failNextPage = true;
    const failed = await ctx.run([...args, "--cursor", "next"]);
    expect(failed.exitCode).toBe(EXIT.OUTPUT_ERROR);
    expect(JSON.parse(failed.stdout).status).toBe(403);
    const retried = await ctx.run([...args, "--cursor", "next"]);
    expect(retried.exitCode, retried.stderr + retried.stdout).toBe(0);
    expect(JSON.parse(retried.stdout).body).toEqual([organizationsFixture[1]]);
    expect(
      paginationRequests.map((url) => url.searchParams.get("cursor")),
    ).toEqual([null, nextCursor, nextCursor]);
    const exhausted = await ctx.run([...args, "--cursor", "next"]);
    expect(exhausted.exitCode).toBe(EXIT.VALIDATION);
    expect(paginationRequests).toHaveLength(3);
  });

  test.each(["human output", "silent output"])(
    "saves pagination history with %s",
    async (output) => {
      await ctx.setAuthToken(TEST_TOKEN);
      const args = ["api", "api-pagination/", "-f", "per_page=1"];
      const first = await ctx.run(
        output === "silent output" ? [...args, "--silent"] : args,
      );
      expect(first.exitCode, first.stderr + first.stdout).toBe(0);
      if (output === "silent output") {
        expect(first.stdout).toBe("");
      } else {
        expect(JSON.parse(first.stdout)).toEqual([organizationsFixture[0]]);
      }
      const second = await ctx.run([...args, "--cursor", "next", "--json"]);
      expect(second.exitCode, second.stderr + second.stdout).toBe(0);
      expect(JSON.parse(second.stdout).body).toEqual([organizationsFixture[1]]);
      expect(paginationRequests).toHaveLength(2);
    },
  );

  test.each(["query", "host", "identity"])(
    "does not reuse pagination history after changing the %s",
    async (change) => {
      const args = ["api", "api-pagination/", "-f", "per_page=1", "--json"];
      const env = {
        SENTRY_AUTH_TOKEN: TEST_TOKEN,
        SENTRY_TOKEN: "",
        SENTRY_CONFIG_DIR: testConfigDir,
        SENTRY_URL: mockServer.url,
        SENTRY_CLI_NO_TELEMETRY: "1",
      };
      const first = await runCli(args, { env });
      expect(first.exitCode, first.stderr + first.stdout).toBe(0);
      const changed = await runCli(
        [
          ...args,
          "--cursor",
          "next",
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
          },
        },
      );
      expect(changed.exitCode).toBe(EXIT.VALIDATION);
      expect(paginationRequests).toHaveLength(1);
      const resumed = await runCli([...args, "--cursor", "next"], { env });
      expect(resumed.exitCode, resumed.stderr + resumed.stdout).toBe(0);
      expect(JSON.parse(resumed.stdout).body).toEqual([
        organizationsFixture[1],
      ]);
      expect(paginationRequests).toHaveLength(2);
    },
  );

  test.each(["shared", "legacy"])(
    "resumes a %s mid-page cursor without repeating or skipping rows",
    async (format) => {
      await ctx.setAuthToken(TEST_TOKEN);
      const nativePage = await paginate({ limit: 1, cursor: "2:1:0" }, () =>
        Promise.resolve({
          data: cursorOrganizations.slice(2, 4),
          nextCursor: "2:2:0",
        }),
      );
      expect(nativePage.nextCursor).toBeDefined();
      const cursor =
        format === "legacy" ? "cli1~2~1~2:1:0" : String(nativePage.nextCursor);
      const args = ["api", "api-custom-cursor/", "-f", "per_page=9", "--json"];
      const preview = await ctx.run([...args, "--cursor", cursor, "--dry-run"]);
      expect(preview.exitCode, preview.stderr + preview.stdout).toBe(0);
      const url = new URL(JSON.parse(preview.stdout).url);
      expect(url.searchParams.get("per_page")).toBe("2");
      expect(url.searchParams.get("cursor")).toBe("2:1:0");
      expect(paginationRequests).toHaveLength(0);

      const resumed = await ctx.run([...args, "--cursor", cursor]);
      expect(resumed.exitCode, resumed.stderr + resumed.stdout).toBe(0);
      expect(paginationRequests.map((request) => request.href)).toEqual([
        url.href,
      ]);
      const resumedPage = JSON.parse(resumed.stdout);
      expect(resumedPage.body).toEqual(cursorOrganizations.slice(3, 4));
      expect(resumedPage.pagination.nextCursor).toBe("2:2:0");
      expect(resumedPage.pagination.hasPrev).toBe(false);
      const next = await ctx.run([...args, "--cursor", "next"]);
      expect(next.exitCode, next.stderr + next.stdout).toBe(0);
      const nextPage = JSON.parse(next.stdout);
      expect(nextPage.body).toEqual(cursorOrganizations.slice(4));
      expect(nextPage.pagination.hasPrev).toBe(true);
      expect([
        ...nativePage.data,
        ...resumedPage.body,
        ...nextPage.body,
      ]).toEqual(cursorOrganizations.slice(2));

      const previous = await ctx.run([...args, "--cursor", "prev"]);
      expect(previous.exitCode, previous.stderr + previous.stdout).toBe(0);
      const previousPage = JSON.parse(previous.stdout);
      expect(previousPage.body).toEqual(cursorOrganizations.slice(3, 4));
      expect(previousPage.pagination.hasPrev).toBe(false);
      expect(
        paginationRequests.map((request) => request.searchParams.get("cursor")),
      ).toEqual(["2:1:0", "2:2:0", "2:1:0"]);
      expect(
        paginationRequests.every(
          (request) => request.searchParams.get("per_page") === "2",
        ),
      ).toBe(true);
    },
  );

  test("resumes a shared cursor in an Events data envelope while preserving metadata", async () => {
    await ctx.setAuthToken(TEST_TOKEN);
    const nativePage = await paginate({ limit: 1, cursor: "2:1:0" }, () =>
      Promise.resolve({
        data: cursorTransactions.slice(2, 4),
        nextCursor: "2:2:0",
      }),
    );
    expect(nativePage.nextCursor).toBeDefined();
    const args = [
      "api",
      "api-custom-cursor/?envelope=events",
      "-f",
      "per_page=9",
      "--json",
    ];

    for (const [cursor, data, hasPrev] of [
      [String(nativePage.nextCursor), cursorTransactions.slice(3, 4), false],
      ["next", cursorTransactions.slice(4), true],
      ["prev", cursorTransactions.slice(3, 4), false],
    ] as const) {
      const result = await ctx.run([...args, "--cursor", cursor]);
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      const page = JSON.parse(result.stdout);
      expect(page.body).toEqual({ ...transactionsFixture, data });
      expect(page.pagination.hasPrev).toBe(hasPrev);
    }

    expect(
      paginationRequests.map((request) => request.searchParams.get("cursor")),
    ).toEqual(["2:1:0", "2:2:0", "2:1:0"]);
    expect(
      paginationRequests.every(
        (request) => request.searchParams.get("per_page") === "2",
      ),
    ).toBe(true);
  });

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

  test.each([
    {
      name: "typed and raw fields",
      flags: ["-F", "cursor=typed-old", "-f", "cursor=raw-old"],
    },
    { name: "JSON data", flags: ["-d", '{"cursor":"data-old"}'] },
    { name: "form data", flags: ["-d", "cursor=data-old"] },
  ])(
    "--cursor replaces $name and URL cursors in the preview and request",
    async ({ flags }) => {
      await ctx.setAuthToken(TEST_TOKEN);
      const args = [
        "api",
        `${mockServer.url}/api/0/api-pagination/?cursor=url-old&cursor=url-older&field=id&field=name&project=1&project=2`,
        ...flags,
        "--cursor",
        nextCursor,
        "--json",
      ];

      const preview = await ctx.run([...args, "--dry-run"]);
      expect(preview.exitCode, preview.stderr + preview.stdout).toBe(0);
      const request = JSON.parse(preview.stdout);
      const url = new URL(request.url);
      expect(url.searchParams.getAll("cursor")).toEqual([nextCursor]);
      expect(url.searchParams.getAll("field")).toEqual(["id", "name"]);
      expect(url.searchParams.getAll("project")).toEqual(["1", "2"]);
      expect(paginationRequests).toHaveLength(0);

      const result = await ctx.run(args);
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      expect(paginationRequests.map((sent) => sent.href)).toEqual([url.href]);
      expect(JSON.parse(result.stdout).body).toEqual([organizationsFixture[1]]);
    },
  );

  test("rejects --cursor for non-GET requests before sending them", async () => {
    await ctx.setAuthToken(TEST_TOKEN);
    const result = await ctx.run([
      "api",
      "api-pagination/",
      "--method",
      "POST",
      "--cursor",
      nextCursor,
    ]);

    expect(result.exitCode).toBe(EXIT.VALIDATION);
    expect(result.stdout + result.stderr).toMatch(/cursor.*GET|GET.*cursor/i);
    expect(paginationRequests).toHaveLength(0);
  });

  test.each([
    { endpoint: "api-pagination/?query=foo%23bar#anchor", query: "foo#bar" },
    { endpoint: "api-pagination/#anchor", query: null },
  ])(
    "--cursor ignores URL fragments in $endpoint",
    async ({ endpoint, query }) => {
      await ctx.setAuthToken(TEST_TOKEN);
      const args = ["api", endpoint, "--cursor", nextCursor, "--json"];

      const preview = await ctx.run([...args, "--dry-run"]);
      expect(preview.exitCode, preview.stderr + preview.stdout).toBe(0);
      const url = new URL(JSON.parse(preview.stdout).url);
      expect(url.hash).toBe("");
      expect(url.searchParams.get("query")).toBe(query);
      expect(url.searchParams.getAll("cursor")).toEqual([nextCursor]);
      expect(paginationRequests).toHaveLength(0);

      const result = await ctx.run(args);
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      expect(paginationRequests.map((sent) => sent.href)).toEqual([url.href]);
      expect(JSON.parse(result.stdout).body).toEqual([organizationsFixture[1]]);
    },
  );

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
