import { mswServer, projectFixture } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createTestContext } from "../../test-utils/context";
import { metricMonitor } from "../../test-utils/metric-monitor";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";
import { executeToolHandler } from "../catalog-runtime/availability";
import deleteMetricMonitor from "./delete-metric-monitor";
import updateMetricMonitor from "./update-metric-monitor";

const endpoint =
  "https://sentry.io/api/0/organizations/test-org/detectors/123/";
const params = { organizationSlug: "test-org", monitorId: "123" };
const context = createTestContext({ constraints: { projectSlug: "backend" } });

function useMonitor(overrides: Record<string, unknown> = {}) {
  const writes: string[] = [];
  mswServer.use(
    http.get(endpoint, () =>
      HttpResponse.json({ ...metricMonitor, ...overrides }),
    ),
    http.get("https://sentry.io/api/0/projects/test-org/backend/", () =>
      HttpResponse.json({ ...projectFixture, id: "100", slug: "backend" }),
    ),
    http.delete(endpoint, ({ request }) => {
      writes.push(request.method);
      return new HttpResponse(null, { status: 204 });
    }),
    http.put(endpoint, ({ request }) => {
      writes.push(request.method);
      return HttpResponse.json(metricMonitor);
    }),
  );
  return writes;
}

describe("delete_metric_monitor", () => {
  it("deletes the constrained monitor without deleting connected Alerts", async () => {
    const writes = useMonitor();
    const result = await executeToolHandler({
      tool: deleteMetricMonitor,
      params,
      context,
    });
    expect(writes).toEqual(["DELETE"]);
    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toMatchInlineSnapshot(`
      {
        "monitorId": "123",
        "success": true,
      }
    `);
  });

  it.each([
    [{ type: "uptime_domain_failure" }, "does not identify a Metric Monitor"],
    [{ projectId: "200" }, "outside the active project constraint"],
  ])(
    "rejects type/project mismatches in both write tools: %j",
    async (overrides, message) => {
      const writes = useMonitor(overrides);
      for (const tool of [updateMetricMonitor, deleteMetricMonitor]) {
        await expect(
          executeToolHandler({
            tool,
            params: { ...params, name: "Renamed" },
            context,
          }),
        ).rejects.toThrow(message);
      }
      expect(writes).toEqual([]);
    },
  );
});
