import { mswServer, projectFixture } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createTestContext } from "../../test-utils/context";
import { metricMonitor } from "../../test-utils/metric-monitor";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";
import findMetricMonitors, {
  findMetricMonitorsOutputSchema,
} from "./find-metric-monitors";

const params = { organizationSlug: "test-org", regionUrl: null, limit: 10 };
const endpoint = "https://sentry.io/api/0/organizations/test-org/detectors/";

describe("find_metric_monitors", () => {
  it("preserves the search and cursor while requesting only Metric Monitors", async () => {
    mswServer.use(
      http.get(endpoint, ({ request }) => {
        expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
          project: "-1",
          type: "metric_issue",
          query: 'name:"High error rate"',
          cursor: "previous",
          per_page: "10",
        });
        return HttpResponse.json([metricMonitor], {
          headers: {
            Link: `<${endpoint}?cursor=next>; rel="next"; results="true"; cursor="next"`,
          },
        });
      }),
    );
    const result = await findMetricMonitors.handler(
      { ...params, query: 'name:"High error rate"', cursor: "previous" },
      createTestContext(),
    );
    assertStructuredOnlyResult(result);
    const content = getStructuredContent(result);
    expect(findMetricMonitorsOutputSchema.parse(content)).toEqual(content);
    expect(content).toMatchInlineSnapshot(`
      {
        "monitors": [
          {
            "enabled": false,
            "id": "123",
            "name": "High error rate",
            "owner": "Backend",
            "projectId": "100",
            "webUrl": "https://test-org.sentry.io/monitors/123/",
            "workflowIds": [
              "456",
            ],
          },
        ],
        "nextCursor": "next",
      }
    `);
  });

  it.each([
    { projectSlug: "backend", constraints: {} },
    { projectSlug: "all", constraints: { projectSlug: "backend" } },
  ])(
    "restricts results to the explicit or session project: $constraints",
    async ({ projectSlug, constraints }) => {
      mswServer.use(
        http.get("https://sentry.io/api/0/projects/test-org/backend/", () =>
          HttpResponse.json({ ...projectFixture, id: "100", slug: "backend" }),
        ),
        http.get(endpoint, ({ request }) => {
          expect(new URL(request.url).searchParams.get("project")).toBe("100");
          return HttpResponse.json([
            metricMonitor,
            { ...metricMonitor, id: "2", type: "uptime_domain" },
            { ...metricMonitor, id: "3", projectId: "200" },
            { ...metricMonitor, id: "4", projectId: null },
          ]);
        }),
      );
      const result = await findMetricMonitors.handler(
        { ...params, projectSlug },
        createTestContext({ constraints }),
      );
      expect(
        findMetricMonitorsOutputSchema
          .parse(getStructuredContent(result))
          .monitors.map(({ id }) => id),
      ).toEqual(["123"]);
    },
  );

  it("rejects an explicit project outside the session constraint", async () => {
    await expect(
      findMetricMonitors.handler(
        { ...params, projectSlug: "other" },
        createTestContext({ constraints: { projectSlug: "backend" } }),
      ),
    ).rejects.toThrow("outside the active project constraint");
  });
});
