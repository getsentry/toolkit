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

  test("maps the metrics alias to the tracemetrics API dataset", async () => {
    mockOk();
    await getDroppedEvents("my-org", { dataset: "metrics" });
    expect(capturedUrl).toContain("dataset=tracemetrics");
    expect(capturedUrl).not.toContain("dataset=metrics");
  });

  test("passes other datasets through unchanged and scopes by project id", async () => {
    mockOk();
    await getDroppedEvents("my-org", { dataset: "spans", projectId: "12345" });
    expect(capturedUrl).toContain("dataset=spans");
    expect(capturedUrl).toContain("project=12345");
  });
});
