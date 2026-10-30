/**
 * Regression tests for listIssueEvents pagination.
 *
 * Without `per_page`, every page overshot the limit. listIssueEvents now sends
 * the walk's page size; trimming and cursor continuity are the shared
 * `paginate()` contract, covered by test/lib/paginate.property.test.ts.
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
  setAuthToken("test-token");
  setOrgRegion("test-org", "https://sentry.io");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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
});
