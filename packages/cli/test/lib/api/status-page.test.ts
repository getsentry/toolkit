import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { fetchSentryStatus } from "../../../src/lib/api/status-page.js";

const { customFetchMock } = vi.hoisted(() => ({ customFetchMock: vi.fn() }));
vi.mock("../../../src/lib/custom-ca.js", () => ({
  customFetch: customFetchMock,
}));

beforeEach(() => {
  customFetchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A minimal, valid Statuspage summary payload. */
function summaryResponse(
  indicator: string,
  description: string,
  pageUrl: string
): Response {
  return Response.json({
    page: { url: pageUrl },
    status: { indicator, description },
    components: [],
    incidents: [],
  });
}

test("probes summary.json first and uses it when the target is Statuspage", async () => {
  customFetchMock.mockResolvedValue(
    summaryResponse(
      "none",
      "All Systems Operational",
      "https://status.sentry.io"
    )
  );

  const status = await fetchSentryStatus();

  expect(status.description).toBe("All Systems Operational");
  // Exactly one request: the summary probe succeeded, no health fallback.
  expect(customFetchMock).toHaveBeenCalledTimes(1);
  const [calledUrl] = customFetchMock.mock.calls[0] ?? [];
  expect(calledUrl).toBe("https://status.sentry.io/api/v2/summary.json");
});

test("uses summary.json for an arbitrary host that responds like Statuspage", async () => {
  customFetchMock.mockResolvedValue(
    summaryResponse(
      "minor",
      "Minor Service Outage",
      "https://sentry.example.com"
    )
  );

  const status = await fetchSentryStatus("https://sentry.example.com");

  expect(status.indicator).toBe("minor");
  expect(customFetchMock).toHaveBeenCalledTimes(1);
  const [calledUrl] = customFetchMock.mock.calls[0] ?? [];
  expect(calledUrl).toBe("https://sentry.example.com/api/v2/summary.json");
});

test("falls back to /_health/ when summary.json is not found (404)", async () => {
  customFetchMock
    .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
    .mockResolvedValueOnce(new Response("", { status: 200, statusText: "OK" }));

  const status = await fetchSentryStatus("https://self.sentry.local");

  expect(status.indicator).toBe("none");
  expect(status.url).toBe("https://self.sentry.local");
  expect(customFetchMock).toHaveBeenCalledTimes(2);
  const [summaryUrl] = customFetchMock.mock.calls[0] ?? [];
  const [healthUrl, healthInit] = customFetchMock.mock.calls[1] ?? [];
  expect(summaryUrl).toBe("https://self.sentry.local/api/v2/summary.json");
  expect(healthUrl).toBe("https://self.sentry.local/_health/?full=1");
  expect(healthInit).toHaveProperty("signal");
});

test("falls back to /_health/ when summary.json returns non-Statuspage JSON", async () => {
  customFetchMock
    .mockResolvedValueOnce(Response.json({ hello: "world" }))
    .mockResolvedValueOnce(new Response("", { status: 200, statusText: "OK" }));

  const status = await fetchSentryStatus("https://self.sentry.local");

  expect(status.indicator).toBe("none");
  expect(customFetchMock).toHaveBeenCalledTimes(2);
  const [healthUrl] = customFetchMock.mock.calls[1] ?? [];
  expect(healthUrl).toBe("https://self.sentry.local/_health/?full=1");
});

test("falls back to /_health/ when summary.json is not JSON", async () => {
  customFetchMock
    .mockResolvedValueOnce(
      new Response("<html>not json</html>", { status: 200 })
    )
    .mockResolvedValueOnce(new Response("", { status: 200, statusText: "OK" }));

  const status = await fetchSentryStatus("https://self.sentry.local");

  expect(status.indicator).toBe("none");
  expect(customFetchMock).toHaveBeenCalledTimes(2);
});

test("reports major when the health fallback returns non-2xx", async () => {
  customFetchMock
    .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
    .mockResolvedValueOnce(
      new Response("", { status: 503, statusText: "Service Unavailable" })
    );

  const status = await fetchSentryStatus("https://self.sentry.local");

  expect(status.indicator).toBe("major");
  expect(status.description).toContain("Service Unavailable");
});

test("reports major when both the summary probe and health probe throw", async () => {
  customFetchMock.mockRejectedValue(new Error("network down"));

  const status = await fetchSentryStatus("https://self.sentry.local");

  expect(status.indicator).toBe("major");
  expect(status.description).toContain("network down");
});
