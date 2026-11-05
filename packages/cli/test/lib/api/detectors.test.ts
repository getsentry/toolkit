import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createMetricMonitor,
  deleteMetricMonitor,
  getMetricMonitor,
  listMetricMonitorsPaginated,
  updateMetricMonitor,
  type MetricMonitorCreateBody,
} from "../../../src/lib/api/detectors.js";
import { DEFAULT_SENTRY_URL } from "../../../src/lib/constants.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { resetAuthenticatedFetch } from "../../../src/lib/sentry-client.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";
import {
  metricMonitor,
  nativeMonitorCreateBody,
} from "../../fixtures/metric-monitors.js";

useTestConfigDir("api-detectors-");
let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  resetAuthenticatedFetch();
  setAuthToken("test-token");
  setOrgRegion("test-org", DEFAULT_SENTRY_URL);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAuthenticatedFetch();
});

describe("native metric monitor API", () => {
  test("lists native documents with metric type, search, project filters and server cursor", async () => {
    const monitor = metricMonitor();
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(new Request(input!, init).url);
      expect(url.pathname).toBe("/api/0/organizations/test-org/detectors/");
      expect(url.searchParams.get("query")).toBe(
        "type:metric_issue name:Latency",
      );
      expect(url.searchParams.getAll("project")).toEqual(["1", "2"]);
      expect(url.searchParams.get("cursor")).toBe("older");
      expect(url.searchParams.get("per_page")).toBe("20");
      return Response.json([monitor], {
        headers: {
          Link: '<https://sentry.io/api/0/organizations/test-org/detectors/?cursor=next-page>; rel="next"; results="true"; cursor="next-page"',
        },
      });
    });
    const result = await listMetricMonitorsPaginated("test-org", {
      perPage: 20,
      cursor: "older",
      query: "name:Latency",
      project: ["1", "2"],
    });
    expect(result.data).toEqual([monitor]);
    expect(result.nextCursor).toBe("next-page");
    expect(result.data[0]).not.toHaveProperty("status");
  });

  test("gets the exact detector response without flattening dataSources or owner", async () => {
    const monitor = metricMonitor({
      owner: { type: "team", id: "1", name: "On-call" },
    });
    globalThis.fetch = mockFetch(async () => Response.json(monitor));
    expect(await getMetricMonitor("test-org", "9")).toEqual(monitor);
  });

  test("creates a project detector with the caller's exact native SDK body", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input!, init);
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe(
        "/api/0/organizations/test-org/projects/web/detectors/",
      );
      expect(await request.json()).toEqual(nativeMonitorCreateBody);
      return Response.json(metricMonitor(), { status: 201 });
    });
    expect(
      await createMetricMonitor(
        "test-org",
        "web",
        nativeMonitorCreateBody as MetricMonitorCreateBody,
      ),
    ).toEqual(metricMonitor());
  });

  test("updates native fields without translating, after checking detector kind", async () => {
    const methods: string[] = [];
    const body = {
      enabled: false,
      config: { detectionType: "percent", comparisonDelta: 7200 },
    };
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input!, init);
      methods.push(request.method);
      if (request.method === "PUT") expect(await request.json()).toEqual(body);
      return Response.json(
        metricMonitor({ enabled: request.method !== "PUT" }),
      );
    });
    expect((await updateMetricMonitor("test-org", "9", body)).enabled).toBe(
      false,
    );
    expect(methods).toEqual(["GET", "PUT"]);
  });

  test("deletes a metric detector and accepts an empty 204", async () => {
    const methods: string[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input!, init);
      methods.push(request.method);
      return request.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json(metricMonitor());
    });
    await expect(deleteMetricMonitor("test-org", "9")).resolves.toBeUndefined();
    expect(methods).toEqual(["GET", "DELETE"]);
  });

  test("rejects nonmetric details before either mutation", async () => {
    const methods: string[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      methods.push(new Request(input!, init).method);
      return Response.json(metricMonitor({ type: "uptime_domain_failure" }));
    });
    await expect(getMetricMonitor("test-org", "9")).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      updateMetricMonitor("test-org", "9", { name: "Do not edit" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(deleteMetricMonitor("test-org", "9")).rejects.toMatchObject({
      status: 404,
    });
    expect(methods).toEqual(["GET", "GET", "GET"]);
  });
});
