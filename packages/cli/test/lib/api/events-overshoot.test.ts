/**
 * Regression tests for listIssueEvents pagination.
 *
 * Two bugs framed this behavior:
 * 1. The original skip bug: trimming an overshooting page while returning the
 *    server's next-page cursor skipped the trimmed tail on `-c next`.
 * 2. The overcorrection: dropping the cursor on overshoot stranded all events
 *    past the first `limit`, so `sentry issue events` could never page forward.
 *
 * The fix caps page size with `per_page = min(limit, API_MAX_PER_PAGE)` so the
 * server cursor is page-aligned, and trims defensively while PRESERVING the
 * cursor (the events cursor is offset-based, so resuming re-includes any trimmed
 * tail). These tests pin both the `per_page` request and the cursor preservation.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listIssueEvents } from "../../../src/lib/api/events.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("test-events-overshoot-");
let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  await setAuthToken("test-token");
  setOrgRegion("test-org", "https://sentry.io");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Build a Sentry pagination Link header advertising a next page. */
function nextLinkHeader(cursor: string): string {
  return `<https://sentry.io/next/>; rel="next"; results="true"; cursor="${cursor}"`;
}

function makeEvents(count: number): Array<{ id: string }> {
  return Array.from({ length: count }, (_unused, i) => ({ id: `evt-${i}` }));
}

describe("listIssueEvents pagination", () => {
  test("sends per_page capped at the requested limit", async () => {
    let capturedUrl = "";
    globalThis.fetch = mockFetch(async (input, init) => {
      capturedUrl = new Request(input!, init).url;
      return new Response(JSON.stringify(makeEvents(2)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await listIssueEvents("test-org", "123", { limit: 2 });

    expect(new URL(capturedUrl).searchParams.get("per_page")).toBe("2");
  });

  test("caps per_page at API_MAX_PER_PAGE for very large limits", async () => {
    let capturedUrl = "";
    globalThis.fetch = mockFetch(async (input, init) => {
      capturedUrl = new Request(input!, init).url;
      return new Response(JSON.stringify(makeEvents(10)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await listIssueEvents("test-org", "123", { limit: 5000 });

    expect(new URL(capturedUrl).searchParams.get("per_page")).toBe("100");
  });

  test("trims to limit but PRESERVES nextCursor when a page overshoots", async () => {
    // Server ignores per_page and returns 5 with a next cursor; caller wants 2.
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify(makeEvents(5)), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            Link: nextLinkHeader("page2"),
          },
        })
    );

    const result = await listIssueEvents("test-org", "123", { limit: 2 });

    expect(result.data).toHaveLength(2);
    expect(result.data[0]?.id).toBe("evt-0");
    expect(result.data[1]?.id).toBe("evt-1");
    // Cursor preserved so `-c next` can advance; the offset-based events cursor
    // re-includes the trimmed tail rather than skipping it.
    expect(result.nextCursor).toBe("page2");
  });

  test("preserves nextCursor when the page exactly fills the limit", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify(makeEvents(2)), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            Link: nextLinkHeader("page2"),
          },
        })
    );

    const result = await listIssueEvents("test-org", "123", { limit: 2 });

    expect(result.data).toHaveLength(2);
    expect(result.nextCursor).toBe("page2");
  });

  test("returns all events with no cursor when under the limit", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify(makeEvents(3)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    const result = await listIssueEvents("test-org", "123", { limit: 25 });

    expect(result.data).toHaveLength(3);
    expect(result.nextCursor).toBeUndefined();
  });
});
