/**
 * Tests for listLogs and getLogs — guards against non-object SDK responses.
 *
 * CLI-20C: self-hosted instances can return non-object data (plain text, HTML)
 * from the /events/?dataset=logs endpoint when the logs dataset is unsupported
 * or a reverse proxy intercepts the request. Previously this crashed with an
 * unhandled schema validation error; now it throws a descriptive ApiError.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
      }),
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
      ApiError,
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
      ApiError,
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
      ApiError,
    );

    try {
      await listLogs("test-org", "test-project");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).message).toContain(
        "unexpected response format",
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
  const LOG_TIMESTAMP = "2026-10-08T12:00:00.000Z";

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(LOG_TIMESTAMP));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function logIdAt(timestamp: string): string {
    const timeHex = Date.parse(timestamp).toString(16).padStart(12, "0");
    return `${timeHex}70008000000000000000`;
  }

  function logEntryAt(timestamp: string) {
    return {
      "sentry.item_id": logIdAt(timestamp),
      timestamp,
      timestamp_precise: Date.parse(timestamp) * 1_000_000,
      message: "Test log message",
      severity: "info",
      trace: null,
    };
  }

  test("finds an exact log ID that a partial scan would miss", async () => {
    const logId = logIdAt(LOG_TIMESTAMP);
    const entry = logEntryAt(LOG_TIMESTAMP);
    const requests: URL[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      requests.push(url);
      const fullScan = url.searchParams.get("sampling") === "HIGHEST_ACCURACY";
      return new Response(
        JSON.stringify({
          data: fullScan ? [entry] : [],
          meta: { fields: {}, dataScanned: fullScan ? "full" : "partial" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const logs = await getLogs("test-org", "test-project", [logId]);

    expect(logs).toEqual([entry]);
    expect(requests).toHaveLength(2);
    expect(requests.map((url) => url.searchParams.get("sampling"))).toEqual([
      "NORMAL",
      "HIGHEST_ACCURACY",
    ]);
    for (const url of requests) {
      expect(url.searchParams.get("start")).toBe("2026-10-08T11:55:00.000Z");
      expect(url.searchParams.get("end")).toBe("2026-10-08T12:05:00.000Z");
      expect(url.searchParams.get("statsPeriod")).toBeNull();
      expect(url.searchParams.get("query")).toBe(
        `project:test-project sentry.item_id:[${logId}]`,
      );
      expect(url.searchParams.get("project")).toBeNull();
      expect(url.searchParams.getAll("field")).toEqual(
        requests[0]!.searchParams.getAll("field"),
      );
    }
  });

  test("retries only missing IDs in a partial batch and preserves options", async () => {
    const found = logEntryAt(LOG_TIMESTAMP);
    const missing = logEntryAt("2026-10-09T12:00:00.000Z");
    const requests: URL[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      requests.push(url);
      const isRetry = url.searchParams.get("sampling") === "HIGHEST_ACCURACY";
      return new Response(
        JSON.stringify({
          data: isRetry ? [missing] : [found],
          meta: { fields: {}, dataScanned: isRetry ? "full" : "partial" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const logs = await getLogs(
      "test-org",
      "test-project",
      [
        found["sentry.item_id"],
        missing["sentry.item_id"],
        missing["sentry.item_id"],
      ],
      { projectId: 4242, extraFields: ["custom.attribute"] },
    );

    expect(logs).toEqual([found, missing]);
    expect(requests).toHaveLength(2);
    const [initial, retry] = requests;
    expect(initial!.searchParams.get("sampling")).toBe("NORMAL");
    expect(initial!.searchParams.get("start")).toBe("2026-10-08T11:55:00.000Z");
    expect(initial!.searchParams.get("end")).toBe("2026-10-09T12:05:00.000Z");
    expect(retry!.searchParams.get("sampling")).toBe("HIGHEST_ACCURACY");
    expect(retry!.searchParams.get("query")).toBe(
      `sentry.item_id:[${missing["sentry.item_id"]}]`,
    );
    expect(retry!.searchParams.get("per_page")).toBe("1");
    expect(retry!.searchParams.get("start")).toBe("2026-10-09T11:55:00.000Z");
    expect(retry!.searchParams.get("end")).toBe("2026-10-09T12:05:00.000Z");
    for (const url of requests) {
      expect(url.searchParams.get("project")).toBe("4242");
      expect(url.searchParams.getAll("field")).toContain("custom.attribute");
      expect(url.searchParams.getAll("field")).toEqual(
        initial!.searchParams.getAll("field"),
      );
      expect(url.searchParams.get("statsPeriod")).toBeNull();
    }
  });

  test.each([
    { kind: "full empty scan", data: [], meta: { dataScanned: "full" } },
    { kind: "missing metadata", data: [], meta: undefined },
    { kind: "missing scan status", data: [], meta: { fields: {} } },
    {
      kind: "partial scan with every ID found",
      data: [logEntryAt(LOG_TIMESTAMP)],
      meta: { dataScanned: "partial" },
    },
  ])("does not retry a $kind", async ({ data, meta }) => {
    const requests: URL[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push(new URL(new Request(input, init).url));
      return new Response(JSON.stringify({ data, meta }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const id = logIdAt(LOG_TIMESTAMP);

    expect(await getLogs("test-org", "test-project", [id, id])).toEqual(data);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.searchParams.get("sampling")).toBe("NORMAL");
  });

  test("stops after one accuracy retry even if the scan remains partial", async () => {
    const requests: URL[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push(new URL(new Request(input, init).url));
      return new Response(
        JSON.stringify({ data: [], meta: { dataScanned: "partial" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    expect(
      await getLogs("test-org", "test-project", [logIdAt(LOG_TIMESTAMP)]),
    ).toEqual([]);

    expect(requests.map((url) => url.searchParams.get("sampling"))).toEqual([
      "NORMAL",
      "HIGHEST_ACCURACY",
    ]);
  });

  test("propagates API errors from the accuracy retry", async () => {
    const requests: URL[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      requests.push(url);
      const retry = url.searchParams.get("sampling") === "HIGHEST_ACCURACY";
      return new Response(
        JSON.stringify(
          retry
            ? { detail: "Access denied" }
            : { data: [], meta: { dataScanned: "partial" } },
        ),
        {
          status: retry ? 403 : 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    await expect(
      getLogs("test-org", "test-project", [logIdAt(LOG_TIMESTAMP)]),
    ).rejects.toMatchObject({ status: 403 });
    expect(requests).toHaveLength(2);
  });

  test("bounds each batch by all its UUIDv7 timestamps and preserves options", async () => {
    const firstIds = Array.from({ length: 100 }, (_, i) =>
      logIdAt(new Date(Date.parse(LOG_TIMESTAMP) + i * 60_000).toISOString()),
    ).reverse();
    const lastId = logIdAt("2026-10-09T12:00:00.000Z");
    const requests: URL[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push(new URL(new Request(input, init).url));
      return new Response(JSON.stringify(EMPTY_LOGS), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const logs = await getLogs(
      "test-org",
      "test-project",
      [...firstIds, lastId],
      {
        projectId: 4242,
        extraFields: ["custom.attribute"],
      },
    );

    expect(logs).toEqual([]);
    expect(requests).toHaveLength(2);
    const first = requests.find(
      (url) => url.searchParams.get("per_page") === "100",
    )!;
    const last = requests.find(
      (url) => url.searchParams.get("per_page") === "1",
    )!;
    expect(first.searchParams.get("start")).toBe("2026-10-08T11:55:00.000Z");
    expect(first.searchParams.get("end")).toBe("2026-10-08T13:44:00.000Z");
    expect(first.searchParams.get("query")).toBe(
      `sentry.item_id:[${firstIds.join(",")}]`,
    );
    expect(last.searchParams.get("start")).toBe("2026-10-09T11:55:00.000Z");
    expect(last.searchParams.get("end")).toBe("2026-10-09T12:05:00.000Z");
    expect(last.searchParams.get("query")).toBe(`sentry.item_id:[${lastId}]`);
    for (const url of requests) {
      expect(url.searchParams.get("sampling")).toBe("NORMAL");
      expect(url.searchParams.get("statsPeriod")).toBeNull();
      expect(url.searchParams.get("project")).toBe("4242");
      expect(url.searchParams.getAll("field")).toContain("custom.attribute");
    }
  });

  test.each([
    { kind: "non-v7", ids: ["c0a5a9d4dce44358ab4231fc3bead7e9"] },
    { kind: "pre-2020", ids: [logIdAt("2019-12-31T23:59:59.999Z")] },
    { kind: "epoch-zero", ids: [logIdAt("1970-01-01T00:00:00.000Z")] },
    {
      kind: "future timestamp beyond tolerance",
      ids: [logIdAt("2026-10-09T12:00:00.001Z")],
    },
    {
      kind: "arbitrary hex with a v7 nibble",
      ids: ["deadbeefdead7eefdeadbeefdeadbeef"],
    },
    {
      kind: "maximum UUID timestamp",
      ids: ["ffffffffffff70008000000000000000"],
    },
    {
      kind: "mixed",
      ids: [logIdAt(LOG_TIMESTAMP), "c0a5a9d4dce44358ab4231fc3bead7e9"],
    },
    {
      kind: "mixed plausible and implausible timestamps",
      ids: [logIdAt(LOG_TIMESTAMP), logIdAt("1970-01-01T00:00:00.000Z")],
    },
  ])("keeps the retention window for $kind IDs", async ({ ids }) => {
    const captured = captureRequest(EMPTY_LOGS);

    expect(await getLogs("test-org", "test-project", ids)).toEqual([]);

    const url = new URL(captured.url());
    expect(url.searchParams.get("sampling")).toBe("NORMAL");
    expect(url.searchParams.get("statsPeriod")).toBe("90d");
    expect(url.searchParams.get("start")).toBeNull();
    expect(url.searchParams.get("end")).toBeNull();
  });

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
      getLogs("test-org", "test-project", ["log-001"]),
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
