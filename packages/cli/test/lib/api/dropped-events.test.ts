import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getDroppedEvents } from "../../../src/lib/api/dropped-events.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

const ORG = "test-org";

function mockOk(body: unknown): {
  getCapturedUrl: () => string;
  getCapturedMethod: () => string;
} {
  let capturedUrl = "";
  let capturedMethod = "";
  globalThis.fetch = mockFetch(async (input, init) => {
    const req = new Request(input!, init);
    capturedUrl = req.url;
    capturedMethod = req.method;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return {
    getCapturedUrl: () => capturedUrl,
    getCapturedMethod: () => capturedMethod,
  };
}

function emptyResponse() {
  return {
    meta: { dataset: "errors", start: 1, end: 2, interval: 3600 },
    droppedEvents: [],
    acceptedEvents: [],
  };
}

useTestConfigDir("dropped-events-api-test-");

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("getDroppedEvents", () => {
  test("hits /organizations/{org}/events-dropped/ with GET", async () => {
    const { getCapturedUrl, getCapturedMethod } = mockOk(emptyResponse());

    await getDroppedEvents(ORG);

    expect(getCapturedMethod()).toBe("GET");
    expect(getCapturedUrl()).toContain(
      `/api/0/organizations/${ORG}/events-dropped/`,
    );
  });

  test("forwards the dataset as given (API-level name)", async () => {
    const { getCapturedUrl } = mockOk(emptyResponse());

    await getDroppedEvents(ORG, { dataset: "tracemetrics" });

    const url = new URL(getCapturedUrl());
    expect(url.searchParams.get("dataset")).toBe("tracemetrics");
  });

  test("forwards project and statsPeriod", async () => {
    const { getCapturedUrl } = mockOk(emptyResponse());

    await getDroppedEvents(ORG, { projectId: "42", statsPeriod: "24h" });

    const url = new URL(getCapturedUrl());
    expect(url.searchParams.get("project")).toBe("42");
    expect(url.searchParams.get("statsPeriod")).toBe("24h");
  });

  test("drops statsPeriod when an absolute range is given", async () => {
    const { getCapturedUrl } = mockOk(emptyResponse());

    await getDroppedEvents(ORG, {
      statsPeriod: "24h",
      start: "2026-01-01T00:00:00Z",
      end: "2026-01-02T00:00:00Z",
    });

    const url = new URL(getCapturedUrl());
    expect(url.searchParams.has("statsPeriod")).toBe(false);
    expect(url.searchParams.get("start")).toBe("2026-01-01T00:00:00Z");
    expect(url.searchParams.get("end")).toBe("2026-01-02T00:00:00Z");
  });
});
