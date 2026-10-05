import { mswServer, projectFixture } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestContext } from "../../test-utils/context";
import { metricMonitor } from "../../test-utils/metric-monitor";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";
import getMetricMonitorDetails, {
  getMetricMonitorDetailsOutputSchema,
} from "./get-metric-monitor-details";

const params = {
  organizationSlug: "test-org",
  regionUrl: null,
  monitorId: "123",
};
const endpoint =
  "https://sentry.io/api/0/organizations/test-org/detectors/123/";
const context = createTestContext();

describe("get_metric_monitor_details", () => {
  beforeEach(() =>
    mswServer.use(
      http.get(endpoint, () => HttpResponse.json(metricMonitor)),
      http.get("https://sentry.io/api/0/projects/test-org/backend/", () =>
        HttpResponse.json({ ...projectFixture, id: "100", slug: "backend" }),
      ),
    ),
  );

  it("reads a native monitor with static thresholds, resolution and query units", async () => {
    const result = await getMetricMonitorDetails.handler(params, context);
    assertStructuredOnlyResult(result);
    const content = getStructuredContent(result);
    expect(getMetricMonitorDetailsOutputSchema.parse(content)).toEqual(content);
    expect(content).toMatchInlineSnapshot(`
      {
        "monitor": {
          "conditionGroup": {
            "conditions": [
              {
                "comparison": 100,
                "conditionResult": 75,
                "id": "11",
                "type": "gt",
              },
              {
                "comparison": 50,
                "conditionResult": 0,
                "id": "12",
                "type": "lte",
              },
            ],
            "id": "10",
            "logicType": "any",
          },
          "config": {
            "detectionType": "static",
          },
          "dataSources": [
            {
              "query": {
                "aggregate": "count()",
                "dataset": "events",
                "environment": "production",
                "eventTypes": [
                  "error",
                ],
                "extrapolationMode": null,
                "query": "level:error",
                "timeWindowSeconds": 300,
              },
              "type": "snuba_query_subscription",
            },
          ],
          "dateCreated": "2026-01-01T00:00:00.000Z",
          "dateUpdated": "2026-01-02T00:00:00.000Z",
          "description": "Monitor production errors",
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
      }
    `);
  });

  it.each([
    {
      config: { detectionType: "percent", comparisonDelta: 3600 },
      comparison: 110,
      type: "gt",
      expectedConfig: {
        detectionType: "percent",
        comparisonDeltaSeconds: 3600,
      },
    },
    {
      config: { detectionType: "dynamic", comparisonDelta: null },
      comparison: {
        sensitivity: "high",
        seasonality: "auto",
        thresholdType: 0,
      },
      type: "anomaly_detection",
      expectedConfig: { detectionType: "dynamic" },
    },
  ])(
    "preserves $config.detectionType detection semantics",
    async ({ config, comparison, type, expectedConfig }) => {
      const conditions = [{ type, comparison, conditionResult: 75 }];
      mswServer.use(
        http.get(endpoint, () =>
          HttpResponse.json({
            ...metricMonitor,
            config,
            conditionGroup: { logicType: "any", conditions },
          }),
        ),
      );
      const result = await getMetricMonitorDetails.handler(params, context);
      const { monitor } = getMetricMonitorDetailsOutputSchema.parse(
        getStructuredContent(result),
      );
      expect(monitor).toMatchObject({
        config: expectedConfig,
        conditionGroup: { conditions },
        dataSources: [
          { query: { timeWindowSeconds: 300, query: "level:error" } },
        ],
      });
    },
  );

  it.each([
    {
      changes: { type: "uptime_domain" },
      error: "does not identify a Metric Monitor",
    },
    {
      changes: { projectId: "200" },
      error: "outside the active project constraint",
    },
    {
      changes: { projectId: null },
      error: "outside the active project constraint",
    },
  ])(
    "rejects mismatched type or project: $changes",
    async ({ changes, error }) => {
      mswServer.use(
        http.get(endpoint, () =>
          HttpResponse.json({ ...metricMonitor, ...changes }),
        ),
      );
      await expect(
        getMetricMonitorDetails.handler(
          params,
          createTestContext({ constraints: { projectSlug: "backend" } }),
        ),
      ).rejects.toThrow(error);
    },
  );

  it("does not invent query values when source configuration is unavailable", async () => {
    mswServer.use(
      http.get(endpoint, () =>
        HttpResponse.json({
          ...metricMonitor,
          dataSources: [{ type: "snuba_query_subscription", queryObj: [] }],
        }),
      ),
    );
    const result = await getMetricMonitorDetails.handler(params, context);
    expect(
      getMetricMonitorDetailsOutputSchema.parse(getStructuredContent(result))
        .monitor.dataSources,
    ).toEqual([
      {
        type: "snuba_query_subscription",
        unavailableReason: "Source configuration is unavailable.",
      },
    ]);
  });
});
