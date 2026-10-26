import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getDroppedEvents } from "../../../src/lib/api/dropped-events.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

const EMPTY_BODY = {
  meta: { dataset: "errors", start: 0, end: 0, interval: 0 },
  droppedEvents: [],
  acceptedEvents: [],
};

describe("getDroppedEvents", () => {
  useTestConfigDir("dropped-events-test-");

  let originalFetch: typeof globalThis.fetch;
  let capturedUrl = "";

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedUrl = "";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockOk(body: unknown = EMPTY_BODY) {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrl = req.url;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }

  test("hits the events-dropped endpoint, defaulting dataset to errors", async () => {
    mockOk();
    await getDroppedEvents("my-org");
    expect(capturedUrl).toContain(
      "/api/0/organizations/my-org/events-dropped/",
    );
    expect(capturedUrl).toContain("dataset=errors");
  });

  test("sends the dataset through unchanged and scopes by project id", async () => {
    mockOk();
    // Plain transport: callers resolve aliases (metrics → tracemetrics) first.
    await getDroppedEvents("my-org", {
      dataset: "tracemetrics",
      projectId: "12345",
    });
    expect(capturedUrl).toContain("dataset=tracemetrics");
    expect(capturedUrl).toContain("project=12345");
  });

  test("defaults tags to [] when a bucket omits the field", async () => {
    mockOk({
      meta: { dataset: "errors", start: 0, end: 3600, interval: 3600 },
      // No `tags` field — the API omits it on accepted buckets and may on drops.
      droppedEvents: [
        {
          type: "error",
          category: "error",
          outcome: "rate_limited",
          reason: "key_quota",
          start: 0,
          end: 3600,
          count: 5,
        },
      ],
      acceptedEvents: [
        {
          type: "error",
          category: "error",
          outcome: "accepted",
          reason: "accepted",
          start: 0,
          end: 3600,
          count: 10,
        },
      ],
    });

    const response = await getDroppedEvents("my-org");
    expect(response.droppedEvents[0].tags).toEqual([]);
    expect(response.acceptedEvents[0].tags).toEqual([]);
  });
});
