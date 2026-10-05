/**
 * Tests for the traces API helpers (getDetailedTrace, listTransactions, listSpans).
 *
 * Verifies URL construction, query parameter encoding, schema validation,
 * pagination cursor extraction, auto-pagination, and the 14d→90d empty-trace retry.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  fetchMultiSpanDetails,
  getDetailedTrace,
  getSpanDetails,
  listSpans,
  listTransactions,
} from "../../../src/lib/api/traces.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe("listTransactions", () => {
  useTestConfigDir("traces-txn-test-");

  let originalFetch: typeof globalThis.fetch;
  let capturedUrl = "";
  let capturedMethod = "";

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedUrl = "";
    capturedMethod = "";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockOk(body: unknown, headers: Record<string, string> = {}) {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrl = req.url;
      capturedMethod = req.method;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json", ...headers },
      });
    });
  }

  /**
   * Helper to mock sequential fetch responses for multi-page tests.
   * Each call to fetch returns the next response in the queue.
   */
  function mockSequential(
    responses: Array<{ body: unknown; headers?: Record<string, string> }>
  ): { getCapturedUrls: () => string[] } {
    const capturedUrls: string[] = [];
    let callIndex = 0;

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrls.push(req.url);

      const resp = responses[callIndex]!;
      callIndex += 1;

      return new Response(JSON.stringify(resp.body), {
        status: 200,
        headers: { "Content-Type": "application/json", ...resp.headers },
      });
    });

    return { getCapturedUrls: () => capturedUrls };
  }

  const TX_META = {
    fields: {
      trace: "string",
      id: "string",
      transaction: "string",
      timestamp: "date",
      "span.duration": "duration",
      project: "string",
    },
  };

  /** Generate N rows of fake transaction data */
  function makeTxnRows(n: number): Record<string, string | number>[] {
    return Array.from({ length: n }, (_, i) => ({
      trace: `trace-${i}`,
      id: `id-${i}`,
      transaction: `/api/endpoint-${i}`,
      timestamp: "2024-01-15T00:00:00Z",
      "span.duration": 100 + i,
      project: "my-project",
    }));
  }

  test("hits /organizations/{org}/events/ with GET", async () => {
    mockOk({ data: [], meta: TX_META });

    await listTransactions("my-org", "my-project");

    expect(capturedMethod).toBe("GET");
    expect(capturedUrl).toContain("/api/0/organizations/my-org/events/");
  });

  test("sends dataset=spans with is_transaction:true", async () => {
    mockOk({ data: [], meta: TX_META });

    await listTransactions("my-org", "my-project");

    expect(capturedUrl).toContain("dataset=spans");
    expect(decodeURIComponent(capturedUrl)).toContain("is_transaction:true");
  });

  test("uses the remaining item budget for the final page", async () => {
    const { getCapturedUrls } = mockSequential([
      {
        body: { data: makeTxnRows(100), meta: TX_META },
        headers: {
          Link: `<https://us.sentry.io/api/0/next/>; rel="next"; results="true"; cursor="0:100:0"`,
        },
      },
      {
        body: { data: makeTxnRows(50), meta: TX_META },
        headers: {
          Link: `<https://us.sentry.io/api/0/next/>; rel="next"; results="false"; cursor=""`,
        },
      },
    ]);

    await listTransactions("my-org", "my-project", { limit: 150 });

    expect(getCapturedUrls()[0]).toContain("per_page=100");
    expect(getCapturedUrls()[1]).toContain("per_page=50");
  });

  test("sends sort=-timestamp by default", async () => {
    mockOk({ data: [], meta: TX_META });

    await listTransactions("my-org", "my-project");

    expect(capturedUrl).toContain(`sort=${encodeURIComponent("-timestamp")}`);
  });

  test('sends sort=-span.duration for sort="duration"', async () => {
    mockOk({ data: [], meta: TX_META });

    await listTransactions("my-org", "my-project", { sort: "duration" });

    expect(decodeURIComponent(capturedUrl)).toContain("sort=-span.duration");
  });

  test("passes cursor when provided", async () => {
    mockOk({ data: [], meta: TX_META });

    await listTransactions("my-org", "my-project", { cursor: "0:50:0" });

    expect(capturedUrl).toContain(`cursor=${encodeURIComponent("0:50:0")}`);
  });

  test("uses statsPeriod when no absolute range provided", async () => {
    mockOk({ data: [], meta: TX_META });

    await listTransactions("my-org", "my-project", { statsPeriod: "1h" });

    expect(capturedUrl).toContain("statsPeriod=1h");
    expect(capturedUrl).not.toContain("start=");
    expect(capturedUrl).not.toContain("end=");
  });

  test("defaults statsPeriod to 7d when not provided", async () => {
    mockOk({ data: [], meta: TX_META });

    await listTransactions("my-org", "my-project");

    expect(capturedUrl).toContain("statsPeriod=7d");
  });

  test("suppresses statsPeriod when start/end are present", async () => {
    mockOk({ data: [], meta: TX_META });

    await listTransactions("my-org", "my-project", {
      start: "2024-01-15T00:00:00Z",
      end: "2024-01-16T00:00:00Z",
      statsPeriod: "7d",
    });

    expect(capturedUrl).toContain(
      `start=${encodeURIComponent("2024-01-15T00:00:00Z")}`
    );
    expect(capturedUrl).toContain(
      `end=${encodeURIComponent("2024-01-16T00:00:00Z")}`
    );
    expect(capturedUrl).not.toContain("statsPeriod=");
  });

  test("auto-paginates when limit > 100", async () => {
    const { getCapturedUrls } = mockSequential([
      {
        body: { data: makeTxnRows(100), meta: TX_META },
        headers: {
          Link: `<https://us.sentry.io/api/0/next/>; rel="next"; results="true"; cursor="0:100:0"`,
        },
      },
      {
        body: { data: makeTxnRows(50), meta: TX_META },
        headers: {
          Link: `<https://us.sentry.io/api/0/next/>; rel="next"; results="false"; cursor=""`,
        },
      },
    ]);

    const result = await listTransactions("my-org", "my-project", {
      limit: 150,
    });

    expect(result.data).toHaveLength(150);
    expect(result.nextCursor).toBeUndefined();
    expect(getCapturedUrls()).toHaveLength(2);
  });

  test("trims results and drops nextCursor when overshoot", async () => {
    mockSequential([
      {
        body: { data: makeTxnRows(100), meta: TX_META },
        headers: {
          Link: `<https://us.sentry.io/api/0/next/>; rel="next"; results="true"; cursor="0:100:0"`,
        },
      },
      {
        body: { data: makeTxnRows(100), meta: TX_META },
        headers: {
          Link: `<https://us.sentry.io/api/0/next/>; rel="next"; results="true"; cursor="0:200:0"`,
        },
      },
    ]);

    const result = await listTransactions("my-org", "my-project", {
      limit: 120,
    });

    expect(result.data).toHaveLength(120);
    expect(result.nextCursor).toBeUndefined();
  });

  test("single-page fast path for limit <= 100", async () => {
    const { getCapturedUrls } = mockSequential([
      {
        body: { data: makeTxnRows(50), meta: TX_META },
        headers: {
          Link: `<https://us.sentry.io/api/0/next/>; rel="next"; results="false"; cursor=""`,
        },
      },
    ]);

    const result = await listTransactions("my-org", "my-project", {
      limit: 50,
    });

    expect(result.data).toHaveLength(50);
    expect(getCapturedUrls()).toHaveLength(1);
    expect(getCapturedUrls()[0]).toContain("per_page=50");
  });

  test("non-numeric project slug goes in query as project:slug", async () => {
    mockOk({ data: [], meta: TX_META });

    await listTransactions("my-org", "my-project");

    expect(decodeURIComponent(capturedUrl).replaceAll("+", " ")).toContain(
      "query=is_transaction:true project:my-project"
    );
    // Should NOT appear as a separate project= param
    expect(capturedUrl).not.toMatch(/[?&]project=my-project/);
  });

  test("scopes via the project param when projectId is provided (#1317)", async () => {
    mockOk({ data: [], meta: TX_META });

    await listTransactions("my-org", "my-project", { projectId: 4242 });

    expect(capturedUrl).toContain("project=4242");
    expect(decodeURIComponent(capturedUrl)).not.toContain("project:my-project");
  });

  test("numeric project ID goes as project param", async () => {
    mockOk({ data: [], meta: TX_META });

    await listTransactions("my-org", "12345");

    expect(capturedUrl).toContain("project=12345");
    // Should NOT appear as project:12345 in the query string
    expect(decodeURIComponent(capturedUrl)).not.toContain("project:12345");
  });

  test("returns nextCursor from Link header", async () => {
    const cursor = "0:10:0";
    mockOk(
      { data: makeTxnRows(10), meta: TX_META },
      {
        Link: `<https://us.sentry.io/api/0/next/>; rel="next"; results="true"; cursor="${cursor}"`,
      }
    );

    const result = await listTransactions("my-org", "my-project", {
      limit: 10,
    });

    expect(result.nextCursor).toBe(cursor);
  });

  test("returns undefined nextCursor when results=false", async () => {
    mockOk(
      { data: [], meta: TX_META },
      {
        Link: `<https://us.sentry.io/api/0/next/>; rel="next"; results="false"; cursor=""`,
      }
    );

    const result = await listTransactions("my-org", "my-project");

    expect(result.nextCursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listSpans
// ---------------------------------------------------------------------------

describe("listSpans", () => {
  useTestConfigDir("traces-span-test-");

  let originalFetch: typeof globalThis.fetch;
  let capturedUrl = "";
  let capturedMethod = "";

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedUrl = "";
    capturedMethod = "";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockOk(body: unknown, headers: Record<string, string> = {}) {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrl = req.url;
      capturedMethod = req.method;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json", ...headers },
      });
    });
  }

  function mockSequential(
    responses: Array<{ body: unknown; headers?: Record<string, string> }>
  ): { getCapturedUrls: () => string[] } {
    const capturedUrls: string[] = [];
    let callIndex = 0;

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrls.push(req.url);

      const resp = responses[callIndex]!;
      callIndex += 1;

      return new Response(JSON.stringify(resp.body), {
        status: 200,
        headers: { "Content-Type": "application/json", ...resp.headers },
      });
    });

    return { getCapturedUrls: () => capturedUrls };
  }

  const SPAN_META = {
    fields: {
      id: "string",
      parent_span: "string",
      "span.op": "string",
      description: "string",
      "span.duration": "duration",
      timestamp: "date",
      project: "string",
      transaction: "string",
      trace: "string",
    },
  };

  /** Generate N rows of fake span data */
  function makeSpanRows(n: number): Record<string, string | number>[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `span-${i}`,
      parent_span: `parent-${i}`,
      "span.op": "http.client",
      description: `GET /api/endpoint-${i}`,
      "span.duration": 50 + i,
      timestamp: "2024-01-15T00:00:00Z",
      project: "my-project",
      transaction: "/api/foo",
      trace: `trace-${i}`,
    }));
  }

  test("hits /organizations/{org}/events/ with GET", async () => {
    mockOk({ data: [], meta: SPAN_META });

    await listSpans("my-org", "my-project");

    expect(capturedMethod).toBe("GET");
    expect(capturedUrl).toContain("/api/0/organizations/my-org/events/");
  });

  test("sends dataset=spans", async () => {
    mockOk({ data: [], meta: SPAN_META });

    await listSpans("my-org", "my-project");

    expect(capturedUrl).toContain("dataset=spans");
  });

  test("uses the remaining item budget for the final page", async () => {
    const { getCapturedUrls } = mockSequential([
      {
        body: { data: makeSpanRows(100), meta: SPAN_META },
        headers: {
          Link: `<https://us.sentry.io/api/0/next/>; rel="next"; results="true"; cursor="0:100:0"`,
        },
      },
      {
        body: { data: makeSpanRows(50), meta: SPAN_META },
        headers: {
          Link: `<https://us.sentry.io/api/0/next/>; rel="next"; results="false"; cursor=""`,
        },
      },
    ]);

    await listSpans("my-org", "my-project", { limit: 150 });

    expect(getCapturedUrls()[0]).toContain("per_page=100");
    expect(getCapturedUrls()[1]).toContain("per_page=50");
  });

  test("sends sort=-timestamp by default", async () => {
    mockOk({ data: [], meta: SPAN_META });

    await listSpans("my-org", "my-project");

    expect(capturedUrl).toContain(`sort=${encodeURIComponent("-timestamp")}`);
  });

  test('sends sort=-span.duration for sort="duration"', async () => {
    mockOk({ data: [], meta: SPAN_META });

    await listSpans("my-org", "my-project", { sort: "duration" });

    expect(decodeURIComponent(capturedUrl)).toContain("sort=-span.duration");
  });

  test("allProjects sends project=-1", async () => {
    mockOk({ data: [], meta: SPAN_META });

    await listSpans("my-org", "my-project", { allProjects: true });

    expect(capturedUrl).toContain("project=-1");
    // Should NOT have project:my-project in query
    expect(decodeURIComponent(capturedUrl)).not.toContain(
      "project%3Amy-project"
    );
  });

  test("scopes via the project param when projectId is provided (#1317)", async () => {
    mockOk({ data: [], meta: SPAN_META });

    await listSpans("my-org", "my-project", { projectId: 4242 });

    expect(capturedUrl).toContain("project=4242");
    expect(decodeURIComponent(capturedUrl)).not.toContain("project:my-project");
  });

  test("auto-paginates when limit > 100", async () => {
    const { getCapturedUrls } = mockSequential([
      {
        body: { data: makeSpanRows(100), meta: SPAN_META },
        headers: {
          Link: `<https://us.sentry.io/api/0/next/>; rel="next"; results="true"; cursor="0:100:0"`,
        },
      },
      {
        body: { data: makeSpanRows(50), meta: SPAN_META },
        headers: {
          Link: `<https://us.sentry.io/api/0/next/>; rel="next"; results="false"; cursor=""`,
        },
      },
    ]);

    const result = await listSpans("my-org", "my-project", { limit: 150 });

    expect(result.data).toHaveLength(150);
    expect(result.nextCursor).toBeUndefined();
    expect(getCapturedUrls()).toHaveLength(2);
  });

  test("trims results when overshoot", async () => {
    mockSequential([
      {
        body: { data: makeSpanRows(100), meta: SPAN_META },
        headers: {
          Link: `<https://us.sentry.io/api/0/next/>; rel="next"; results="true"; cursor="0:100:0"`,
        },
      },
      {
        body: { data: makeSpanRows(100), meta: SPAN_META },
        headers: {
          Link: `<https://us.sentry.io/api/0/next/>; rel="next"; results="true"; cursor="0:200:0"`,
        },
      },
    ]);

    const result = await listSpans("my-org", "my-project", { limit: 120 });

    expect(result.data).toHaveLength(120);
    expect(result.nextCursor).toBeUndefined();
  });

  test("single-page fast path for limit <= 100", async () => {
    const { getCapturedUrls } = mockSequential([
      {
        body: { data: makeSpanRows(30), meta: SPAN_META },
        headers: {
          Link: `<https://us.sentry.io/api/0/next/>; rel="next"; results="false"; cursor=""`,
        },
      },
    ]);

    const result = await listSpans("my-org", "my-project", { limit: 30 });

    expect(result.data).toHaveLength(30);
    expect(getCapturedUrls()).toHaveLength(1);
    expect(getCapturedUrls()[0]).toContain("per_page=30");
  });

  test("passes extraFields when provided", async () => {
    mockOk({ data: [], meta: SPAN_META });

    await listSpans("my-org", "my-project", {
      extraFields: ["span.self_time", "span.category"],
    });

    const decoded = decodeURIComponent(capturedUrl);
    expect(decoded).toContain("field=span.self_time");
    expect(decoded).toContain("field=span.category");
    // Standard fields should still be present
    expect(decoded).toContain("field=id");
    expect(decoded).toContain("field=span.op");
  });

  test("non-numeric project slug goes in query as project:slug", async () => {
    mockOk({ data: [], meta: SPAN_META });

    await listSpans("my-org", "my-project");

    expect(capturedUrl).toContain(
      `query=${encodeURIComponent("project:my-project")}`
    );
    // Should NOT appear as a separate project= param with the slug value
    expect(capturedUrl).not.toMatch(/[?&]project=my-project/);
  });

  test("numeric project ID goes as project param", async () => {
    mockOk({ data: [], meta: SPAN_META });

    await listSpans("my-org", "12345");

    expect(capturedUrl).toContain("project=12345");
    expect(decodeURIComponent(capturedUrl)).not.toContain("project:12345");
  });

  test("uses statsPeriod when no absolute range provided", async () => {
    mockOk({ data: [], meta: SPAN_META });

    await listSpans("my-org", "my-project", { statsPeriod: "1h" });

    expect(capturedUrl).toContain("statsPeriod=1h");
    expect(capturedUrl).not.toContain("start=");
    expect(capturedUrl).not.toContain("end=");
  });

  test("defaults statsPeriod to 7d when not provided", async () => {
    mockOk({ data: [], meta: SPAN_META });

    await listSpans("my-org", "my-project");

    expect(capturedUrl).toContain("statsPeriod=7d");
  });

  test("suppresses statsPeriod when start/end are present", async () => {
    mockOk({ data: [], meta: SPAN_META });

    await listSpans("my-org", "my-project", {
      start: "2024-01-15T00:00:00Z",
      end: "2024-01-16T00:00:00Z",
      statsPeriod: "7d",
    });

    expect(capturedUrl).toContain(
      `start=${encodeURIComponent("2024-01-15T00:00:00Z")}`
    );
    expect(capturedUrl).toContain(
      `end=${encodeURIComponent("2024-01-16T00:00:00Z")}`
    );
    expect(capturedUrl).not.toContain("statsPeriod=");
  });

  test("passes cursor when provided", async () => {
    mockOk({ data: [], meta: SPAN_META });

    await listSpans("my-org", "my-project", { cursor: "0:50:0" });

    expect(capturedUrl).toContain(`cursor=${encodeURIComponent("0:50:0")}`);
  });

  test("returns nextCursor from Link header", async () => {
    const cursor = "0:10:0";
    mockOk(
      { data: makeSpanRows(10), meta: SPAN_META },
      {
        Link: `<https://us.sentry.io/api/0/next/>; rel="next"; results="true"; cursor="${cursor}"`,
      }
    );

    const result = await listSpans("my-org", "my-project", { limit: 10 });

    expect(result.nextCursor).toBe(cursor);
  });

  test("returns undefined nextCursor when results=false", async () => {
    mockOk(
      { data: [], meta: SPAN_META },
      {
        Link: `<https://us.sentry.io/api/0/next/>; rel="next"; results="false"; cursor=""`,
      }
    );

    const result = await listSpans("my-org", "my-project");

    expect(result.nextCursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getSpanDetails
// ---------------------------------------------------------------------------

describe("getSpanDetails", () => {
  useTestConfigDir("traces-span-details-test-");

  let originalFetch: typeof globalThis.fetch;
  let capturedUrl = "";
  let capturedParams: Record<string, string> = {};

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedUrl = "";
    capturedParams = {};
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockOk(body: unknown) {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrl = req.url;
      const url = new URL(capturedUrl);
      url.searchParams.forEach((v, k) => {
        capturedParams[k] = v;
      });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }

  const DETAIL_RESPONSE = {
    itemId: "abc123",
    timestamp: "2026-01-01T00:00:00Z",
    attributes: [
      { name: "span.op", type: "str", value: "db.query" },
      { name: "user.id", type: "str", value: "u_42" },
    ],
  };

  test("calls trace-items endpoint with item_type=spans", async () => {
    mockOk(DETAIL_RESPONSE);

    await getSpanDetails("my-org", "my-project", "span-id-abc", "trace-id-xyz");

    expect(capturedUrl).toContain(
      "/projects/my-org/my-project/trace-items/span-id-abc/"
    );
    expect(capturedParams.item_type).toBe("spans");
    expect(capturedParams.trace_id).toBe("trace-id-xyz");
  });

  test("returns parsed attributes", async () => {
    mockOk(DETAIL_RESPONSE);

    const result = await getSpanDetails(
      "my-org",
      "my-project",
      "span-id-abc",
      "trace-id-xyz"
    );

    expect(result.itemId).toBe("abc123");
    expect(result.attributes).toHaveLength(2);
    expect(result.attributes[0]).toEqual({
      name: "span.op",
      type: "str",
      value: "db.query",
    });
  });
});

// ---------------------------------------------------------------------------
// fetchMultiSpanDetails
// ---------------------------------------------------------------------------

describe("fetchMultiSpanDetails", () => {
  useTestConfigDir("traces-multi-span-details-test-");

  let originalFetch: typeof globalThis.fetch;
  let requestedUrls: string[] = [];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    requestedUrls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockOk() {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      requestedUrls.push(req.url);
      return new Response(
        JSON.stringify({
          itemId: "x",
          timestamp: "2026-01-01T00:00:00Z",
          attributes: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
  }

  test("skips spans with no project slug instead of issuing a malformed request", async () => {
    mockOk();

    // fallbackProject is empty (org-scoped target) and the span has no
    // project_slug — a request here would produce /projects/my-org//trace-items/…
    const details = await fetchMultiSpanDetails(
      [{ span_id: "span-no-project" }],
      { org: "my-org", fallbackProject: "", traceId: "trace-xyz" }
    );

    expect(details.size).toBe(0);
    expect(requestedUrls).toHaveLength(0);
  });

  test("uses fallback project when a span has no project_slug", async () => {
    mockOk();

    await fetchMultiSpanDetails([{ span_id: "span-a" }], {
      org: "my-org",
      fallbackProject: "fallback-proj",
      traceId: "trace-xyz",
    });

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain(
      "/projects/my-org/fallback-proj/trace-items/span-a/"
    );
  });

  test("does not skip other spans when one lacks a project slug", async () => {
    mockOk();

    const details = await fetchMultiSpanDetails(
      [
        { span_id: "span-no-project" },
        { span_id: "span-b", project_slug: "proj-b" },
      ],
      { org: "my-org", fallbackProject: "", traceId: "trace-xyz" }
    );

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain(
      "/projects/my-org/proj-b/trace-items/span-b/"
    );
    expect(details.has("span-b")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getDetailedTrace
// ---------------------------------------------------------------------------

describe("getDetailedTrace", () => {
  useTestConfigDir("traces-detail-test-");

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const SPAN = {
    span_id: "span-1",
    start_timestamp: 1_700_000_000,
    timestamp: 1_700_000_001,
  };

  function mockSequential(bodies: unknown[]): {
    getCapturedUrls: () => string[];
  } {
    const capturedUrls: string[] = [];
    let callIndex = 0;

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrls.push(req.url);
      const body = bodies[callIndex] ?? [];
      callIndex += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    return { getCapturedUrls: () => capturedUrls };
  }

  test("sends timestamp and skips statsPeriod when event time is known", async () => {
    const { getCapturedUrls } = mockSequential([[SPAN]]);

    const result = await getDetailedTrace("my-org", "abc123def456", {
      timestamp: 1_700_000_000,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.span_id).toBe("span-1");
    expect(getCapturedUrls()).toHaveLength(1);
    const url = new URL(getCapturedUrls()[0]!);
    expect(url.searchParams.get("timestamp")).toBe("1700000000");
    expect(url.searchParams.get("statsPeriod")).toBeNull();
    expect(url.searchParams.get("limit")).toBe("10000");
    expect(url.searchParams.get("project")).toBe("-1");
  });

  test("queries 14d and does not retry when spans are returned", async () => {
    const { getCapturedUrls } = mockSequential([[SPAN]]);

    const result = await getDetailedTrace("my-org", "abc123def456");

    expect(result).toHaveLength(1);
    expect(getCapturedUrls()).toHaveLength(1);
    const url = new URL(getCapturedUrls()[0]!);
    expect(url.searchParams.get("statsPeriod")).toBe("14d");
    expect(url.searchParams.get("timestamp")).toBeNull();
  });

  test("retries 90d when the 14d lookup is empty", async () => {
    const { getCapturedUrls } = mockSequential([[], [SPAN]]);

    const result = await getDetailedTrace("my-org", "abc123def456");

    expect(result).toHaveLength(1);
    expect(result[0]!.span_id).toBe("span-1");
    expect(getCapturedUrls()).toHaveLength(2);
    expect(new URL(getCapturedUrls()[0]!).searchParams.get("statsPeriod")).toBe(
      "14d"
    );
    expect(new URL(getCapturedUrls()[1]!).searchParams.get("statsPeriod")).toBe(
      "90d"
    );
    expect(
      new URL(getCapturedUrls()[0]!).searchParams.get("timestamp")
    ).toBeNull();
    expect(
      new URL(getCapturedUrls()[1]!).searchParams.get("timestamp")
    ).toBeNull();
  });

  test("does not widen when a known timestamp returns empty", async () => {
    const { getCapturedUrls } = mockSequential([[]]);

    const result = await getDetailedTrace("my-org", "abc123def456", {
      timestamp: 1_700_000_000,
    });

    expect(result).toHaveLength(0);
    expect(getCapturedUrls()).toHaveLength(1);
    expect(new URL(getCapturedUrls()[0]!).searchParams.get("timestamp")).toBe(
      "1700000000"
    );
    expect(
      new URL(getCapturedUrls()[0]!).searchParams.get("statsPeriod")
    ).toBeNull();
  });

  test("forwards project and additional attributes on both lookups", async () => {
    const { getCapturedUrls } = mockSequential([[], [SPAN]]);

    await getDetailedTrace("my-org", "abc123def456", {
      projectId: 42,
      additionalAttributes: ["gen_ai.request.model"],
    });

    expect(getCapturedUrls()).toHaveLength(2);
    for (const raw of getCapturedUrls()) {
      const url = new URL(raw);
      expect(url.searchParams.get("project")).toBe("42");
      expect(url.searchParams.getAll("additional_attributes")).toEqual([
        "gen_ai.request.model",
      ]);
    }
  });
});
