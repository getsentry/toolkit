/**
 * Tests for listLogs and getLogs — guards against non-object SDK responses.
 *
 * CLI-20C: self-hosted instances can return non-object data (plain text, HTML)
 * from the /events/?dataset=logs endpoint when the logs dataset is unsupported
 * or a reverse proxy intercepts the request. Previously this crashed with an
 * unhandled schema validation error; now it throws a descriptive ApiError.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getLogs, listLogs } from "../../../src/lib/api/logs.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { ApiError } from "../../../src/lib/errors.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("logs-api-test-");

let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  await setAuthToken("fake-token-for-test", 3600);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Mock fetch to return a fixed JSON body for all requests.
 * The SDK parses the response via response.json(), so wrapping in
 * JSON.stringify ensures the SDK receives the raw value as `data`.
 */
function mockOk(body: unknown) {
  globalThis.fetch = mockFetch(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
  );
}

/**
 * Mock fetch that captures the request URL of the last call and returns the
 * given body. Lets tests assert how a project was scoped (query vs. param).
 */
function captureRequest(body: unknown): { url: () => string } {
  let lastUrl = "";
  globalThis.fetch = mockFetch(async (input: RequestInfo | URL) => {
    if (typeof input === "string") {
      lastUrl = input;
    } else if (input instanceof URL) {
      lastUrl = input.toString();
    } else {
      lastUrl = input.url;
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { url: () => lastUrl };
}

const EMPTY_LOGS = { data: [], meta: { fields: {} } };

describe("listLogs", () => {
  test("returns logs when API returns a valid response", async () => {
    mockOk({
      data: [
        {
          "sentry.item_id": "log-001",
          timestamp: "2025-01-30T14:32:15+00:00",
          timestamp_precise: 1_770_060_419_044_800_300,
          message: "Test log message",
          severity: "info",
          trace: "abc123def456abc123def456abc12345",
        },
      ],
      meta: { fields: {} },
    });

    const logs = await listLogs("test-org", "test-project");
    expect(logs).toHaveLength(1);
    expect(logs[0]["sentry.item_id"]).toBe("log-001");
  });

  test("throws ApiError when API returns a string instead of object", async () => {
    mockOk("Proxy error: upstream not found");

    await expect(listLogs("test-org", "test-project")).rejects.toThrow(
      ApiError
    );

    try {
      await listLogs("test-org", "test-project");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.message).toContain("unexpected response format");
      expect(apiError.detail).toContain("received string");
    }
  });

  test("throws ApiError when API returns null", async () => {
    mockOk(null);

    await expect(listLogs("test-org", "test-project")).rejects.toThrow(
      ApiError
    );

    try {
      await listLogs("test-org", "test-project");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.message).toContain("unexpected response format");
      expect(apiError.detail).toContain("received null");
    }
  });

  test("throws ApiError when response has wrong shape", async () => {
    mockOk({ wrong: "shape" });

    await expect(listLogs("test-org", "test-project")).rejects.toThrow(
      ApiError
    );

    try {
      await listLogs("test-org", "test-project");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).message).toContain(
        "unexpected response format"
      );
    }
  });

  test("scopes via the project param when projectId is provided (#1317)", async () => {
    const captured = captureRequest(EMPTY_LOGS);

    await listLogs("test-org", "my-project", { projectId: 4242 });

    const url = captured.url();
    // Numeric ID goes to the `project` query param, not the search query.
    expect(url).toContain("project=4242");
    expect(url).not.toContain("project%3Amy-project");
  });

  test("falls back to project:<slug> query when no projectId is available", async () => {
    const captured = captureRequest(EMPTY_LOGS);

    await listLogs("test-org", "my-project");

    const url = captured.url();
    // Without an ID, scope via search syntax (`project:my-project`).
    expect(url).toContain("project%3Amy-project");
    expect(url).not.toMatch(/[?&]project=/);
  });

  test("treats an all-digits slug as a numeric project ID", async () => {
    const captured = captureRequest(EMPTY_LOGS);

    await listLogs("test-org", "12345");

    const url = captured.url();
    expect(url).toContain("project=12345");
    expect(url).not.toContain("project%3A12345");
  });

  test("caps per_page at API_MAX_PER_PAGE when limit exceeds the API max", async () => {
    const captured = captureRequest(EMPTY_LOGS);

    await listLogs("test-org", "my-project", { limit: 200 });

    expect(captured.url()).toContain("per_page=100");
  });

  test("sends the requested limit as per_page when below the API max", async () => {
    const captured = captureRequest(EMPTY_LOGS);

    await listLogs("test-org", "my-project", { limit: 50 });

    expect(captured.url()).toContain("per_page=50");
  });

  test("defaults per_page to API_MAX_PER_PAGE when no limit is given", async () => {
    const captured = captureRequest(EMPTY_LOGS);

    await listLogs("test-org", "my-project");

    expect(captured.url()).toContain("per_page=100");
  });

  test("auto-paginates to fill a limit above API_MAX_PER_PAGE", async () => {
    const makeRows = (n: number, offset: number) =>
      Array.from({ length: n }, (_, i) => ({
        "sentry.item_id": `log-${offset + i}`,
        timestamp: "2025-01-30T14:32:15+00:00",
        timestamp_precise: 1_770_060_419_044_800_300,
        message: `msg ${offset + i}`,
        severity: "info",
        trace: "abc123def456abc123def456abc12345",
      }));

    const responses = [
      {
        body: { data: makeRows(100, 0), meta: { fields: {} } },
        link: `<https://sentry.io/next/>; rel="next"; results="true"; cursor="0:100:0"`,
      },
      {
        body: { data: makeRows(50, 100), meta: { fields: {} } },
        link: `<https://sentry.io/next/>; rel="next"; results="false"; cursor=""`,
      },
    ];
    const urls: string[] = [];
    let call = 0;
    globalThis.fetch = mockFetch(async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : (input as Request).url);
      const resp = responses[call]!;
      call += 1;
      return new Response(JSON.stringify(resp.body), {
        status: 200,
        headers: { "Content-Type": "application/json", Link: resp.link },
      });
    });

    const logs = await listLogs("test-org", "my-project", { limit: 150 });

    expect(logs).toHaveLength(150);
    expect(urls).toHaveLength(2);
  });
});

describe("getLogs", () => {
  test("returns logs when API returns a valid detailed response", async () => {
    mockOk({
      data: [
        {
          "sentry.item_id": "log-001",
          timestamp: "2025-01-30T14:32:15+00:00",
          timestamp_precise: 1_770_060_419_044_800_300,
          message: "Test log message",
          severity: "info",
          trace: "abc123def456abc123def456abc12345",
          project: "test-project",
          environment: "production",
          release: "1.0.0",
          "sdk.name": "sentry.javascript.node",
          "sdk.version": "8.0.0",
          span_id: "abc123def456abc1",
          "code.function": "main",
          "code.file.path": "/app/index.ts",
          "code.line.number": "42",
          "sentry.otel.kind": "INTERNAL",
          "sentry.otel.status_code": "OK",
          "sentry.otel.instrumentation_scope.name": "my-app",
        },
      ],
      meta: { fields: {} },
    });

    const logs = await getLogs("test-org", "test-project", ["log-001"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]["sentry.item_id"]).toBe("log-001");
  });

  test("throws ApiError when API returns a string instead of object", async () => {
    mockOk("<html><body>502 Bad Gateway</body></html>");

    await expect(
      getLogs("test-org", "test-project", ["log-001"])
    ).rejects.toThrow(ApiError);

    try {
      await getLogs("test-org", "test-project", ["log-001"]);
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.message).toContain("unexpected response format");
      expect(apiError.detail).toContain("received string");
      expect(apiError.detail).toContain("self-hosted");
    }
  });

  test("scopes via the project param when projectId is provided (#1317)", async () => {
    const captured = captureRequest(EMPTY_LOGS);

    await getLogs("test-org", "my-project", ["log-001"], { projectId: 4242 });

    const url = captured.url();
    expect(url).toContain("project=4242");
    expect(url).not.toContain("project%3Amy-project");
  });

  test("falls back to project:<slug> query when no projectId is available", async () => {
    const captured = captureRequest(EMPTY_LOGS);

    await getLogs("test-org", "my-project", ["log-001"]);

    const url = captured.url();
    expect(url).toContain("project%3Amy-project");
    expect(url).not.toMatch(/[?&]project=/);
  });
});
