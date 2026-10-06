/**
 * Hex ID Recovery — adapter integration tests
 *
 * Exercises `ADAPTERS.{event,trace,log,span}` and `recoverHexId`'s
 * cross-entity redirect path against mocked `globalThis.fetch`. These
 * complement `hex-id-recovery.test.ts` (which stubs `ADAPTERS` directly)
 * by verifying the adapter bodies — the API query strings, response
 * shapes, and empty-context guards — actually work end-to-end.
 *
 * Lives in `test/lib/` (not `test/isolated/`) because no module mocking
 * is needed — just a bare `globalThis.fetch` swap, same pattern as
 * `api-client.coverage.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { setAuthToken } from "../../src/lib/db/auth.js";
import { setOrgRegion } from "../../src/lib/db/regions.js";
import { ADAPTERS, recoverHexId } from "../../src/lib/hex-id-recovery.js";
import { mockFetch, useTestConfigDir } from "../helpers.js";

useTestConfigDir("test-hex-recovery-adapters-");

let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  await setAuthToken("test-token");
  setOrgRegion("test-org", "https://sentry.io");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Build an Events-API style response with arbitrary data rows. */
function eventsResponse(data: unknown[]): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      Link: '<https://sentry.io/api/0/next/>; rel="next"; results="false"',
    },
  });
}

// ---------------------------------------------------------------------------
// Adapters: empty-context short-circuit
// ---------------------------------------------------------------------------

describe("adapter context guards", () => {
  test("event adapter returns [] without hitting fetch when org is empty", async () => {
    let fetchCalled = false;
    globalThis.fetch = mockFetch(async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const ids = await ADAPTERS.event({ org: "", project: "my-project" });
    expect(ids).toEqual([]);
    expect(fetchCalled).toBe(false);
  });

  test("event adapter returns [] without hitting fetch when project is empty", async () => {
    let fetchCalled = false;
    globalThis.fetch = mockFetch(async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const ids = await ADAPTERS.event({ org: "test-org" });
    expect(ids).toEqual([]);
    expect(fetchCalled).toBe(false);
  });

  test("span adapter returns [] when traceId is missing even with org+project", async () => {
    let fetchCalled = false;
    globalThis.fetch = mockFetch(async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const ids = await ADAPTERS.span({
      org: "test-org",
      project: "test-project",
    });
    expect(ids).toEqual([]);
    expect(fetchCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Adapters: query-string correctness
// ---------------------------------------------------------------------------

describe("adapter query params", () => {
  test("event adapter queries the errors dataset with project scope", async () => {
    let queryUrl = "";
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      queryUrl = req.url;
      return eventsResponse([
        {
          id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          timestamp: "2026-01-01T00:00:00Z",
        },
        {
          id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          timestamp: "2026-01-01T00:00:00Z",
        },
      ]);
    });

    const ids = await ADAPTERS.event({
      org: "test-org",
      project: "test-project",
    });

    expect(queryUrl).toContain("dataset=errors");
    expect(queryUrl).toContain("field=id");
    expect(queryUrl).toContain("project%3Atest-project"); // project:test-project URL-encoded
    expect(queryUrl).toContain("sort=-timestamp");
    expect(queryUrl).toContain("statsPeriod=90d");
    expect(ids).toEqual([
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
  });

  test("trace adapter queries the spans dataset and extracts trace field", async () => {
    let queryUrl = "";
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      queryUrl = req.url;
      return eventsResponse([
        {
          id: "span1",
          trace: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          timestamp: "2026-01-01T00:00:00Z",
          project: "test-project",
        },
        {
          id: "span2",
          trace: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          timestamp: "2026-01-01T00:00:00Z",
          project: "test-project",
        },
      ]);
    });

    const traces = await ADAPTERS.trace({
      org: "test-org",
      project: "test-project",
    });

    expect(queryUrl).toContain("dataset=spans");
    expect(queryUrl).toContain("statsPeriod=30d");
    expect(traces).toEqual([
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
  });

  test("span adapter scopes query by traceId", async () => {
    let queryUrl = "";
    const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      queryUrl = req.url;
      return eventsResponse([
        {
          id: "abcd1234abcd1234",
          trace: traceId,
          timestamp: "2026-01-01T00:00:00Z",
          project: "test-project",
        },
      ]);
    });

    const spanIds = await ADAPTERS.span({
      org: "test-org",
      project: "test-project",
      traceId,
    });

    expect(queryUrl).toContain("dataset=spans");
    expect(queryUrl).toContain(`trace%3A${traceId}`);
    expect(spanIds).toEqual(["abcd1234abcd1234"]);
  });

  test("log adapter queries the logs dataset and extracts sentry.item_id", async () => {
    let queryUrl = "";
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      queryUrl = req.url;
      return new Response(
        JSON.stringify({
          data: [
            {
              "sentry.item_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              timestamp: "2026-01-01T00:00:00Z",
              // Nanosecond timestamps exceed Number.MAX_SAFE_INTEGER
              // when encoded literally. Use string form (the schema
              // coerces it to a number for us).
              timestamp_precise: "1735689600000000000",
              message: "test log",
              severity: "info",
            },
            {
              "sentry.item_id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              timestamp: "2026-01-01T00:00:00Z",
              timestamp_precise: "1735689600000000001",
              message: "another log",
              severity: "error",
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    });

    const ids = await ADAPTERS.log({
      org: "test-org",
      project: "test-project",
    });

    expect(queryUrl).toContain("dataset=logs");
    expect(queryUrl).toContain("statsPeriod=30d");
    expect(ids).toEqual([
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
  });

  test("ctx.period override replaces the default scan window", async () => {
    let queryUrl = "";
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      queryUrl = req.url;
      return eventsResponse([]);
    });

    await ADAPTERS.trace({
      org: "test-org",
      project: "test-project",
      period: "7d",
    });

    expect(queryUrl).toContain("statsPeriod=7d");
    expect(queryUrl).not.toContain("statsPeriod=30d");
  });
});

// ---------------------------------------------------------------------------
// Cross-entity redirect: 16-hex span → parent trace
// ---------------------------------------------------------------------------

describe("recoverHexId trace redirect via findTraceBySpanId", () => {
  test("16-hex input to trace recovery queries spans with id:<span> and returns parent trace", async () => {
    const spanId = "a1b2c3d4e5f67890";
    const parentTrace = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let queryUrl = "";
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      queryUrl = req.url;
      return eventsResponse([
        {
          id: spanId,
          trace: parentTrace,
          timestamp: "2026-01-01T00:00:00Z",
          project: "test-project",
        },
      ]);
    });

    const result = await recoverHexId(spanId, "trace", {
      org: "test-org",
      project: "test-project",
    });

    expect(queryUrl).toContain(`id%3A${spanId}`);
    expect(result.kind).toBe("redirect");
    if (result.kind === "redirect") {
      expect(result.id).toBe(parentTrace);
      expect(result.fromEntity).toBe("span");
      expect(result.toEntity).toBe("trace");
    }
  });

  test("16-hex span not found returns null from findTraceBySpanId — falls through to fuzzy", async () => {
    const spanId = "a1b2c3d4e5f67890";
    // First call (id:<span> lookup) returns empty → null trace → falls through.
    // Second call (fuzzy scan) also returns empty → no-matches.
    const callCount = { n: 0 };
    globalThis.fetch = mockFetch(async () => {
      callCount.n += 1;
      return eventsResponse([]);
    });

    const result = await recoverHexId(spanId, "trace", {
      org: "test-org",
      project: "test-project",
    });

    expect(callCount.n).toBeGreaterThanOrEqual(1);
    // The span lookup returned null, so no redirect happened. Input has a
    // valid-looking 16-hex prefix, so it proceeds to the fuzzy path and
    // ultimately returns `no-matches` (or `multiple-matches` if somehow
    // filtered) — here we just confirm it's a failed outcome, not a
    // redirect/fuzzy-success.
    expect(result.kind).toBe("failed");
  });
});
