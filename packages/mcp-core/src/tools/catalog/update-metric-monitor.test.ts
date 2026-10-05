import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { UserInputError } from "../../errors";
import { createTestContext } from "../../test-utils/context";
import { metricMonitor } from "../../test-utils/metric-monitor";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";
import { executeToolHandler } from "../catalog-runtime/availability";
import updateMetricMonitor from "./update-metric-monitor";

const endpoint =
  "https://sentry.io/api/0/organizations/test-org/detectors/123/";
const thresholdGroup = {
  ...metricMonitor.conditionGroup,
  conditions: [
    { ...metricMonitor.conditionGroup.conditions[0], comparison: 110 },
    { ...metricMonitor.conditionGroup.conditions[1], comparison: 105 },
  ],
};
const anomaly = {
  type: "anomaly_detection",
  comparison: { sensitivity: "high", seasonality: "auto", thresholdType: 2 },
  conditionResult: 75,
};
const dynamicGroup = { logicType: "any", conditions: [anomaly] };

function update(changes: Record<string, unknown>) {
  return executeToolHandler({
    tool: updateMetricMonitor,
    params: { organizationSlug: "test-org", monitorId: "123", ...changes },
    context: createTestContext(),
  });
}

function useMonitor(overrides: Record<string, unknown> = {}) {
  const monitor = { ...metricMonitor, ...overrides };
  const writes: Record<string, unknown>[] = [];
  mswServer.use(
    http.get(endpoint, () => HttpResponse.json(monitor)),
    http.put(endpoint, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      writes.push(body);
      return HttpResponse.json({
        ...monitor,
        ...body,
        dataSources: monitor.dataSources,
      });
    }),
  );
  return writes;
}

describe("update_metric_monitor", () => {
  it.each(["static", "percent", "dynamic"])(
    "preserves %s detection when editing metadata and disconnecting Alerts",
    async (detectionType) => {
      const writes = useMonitor({
        config: {
          detectionType,
          comparisonDelta: detectionType === "percent" ? 3600 : null,
        },
        conditionGroup:
          detectionType === "dynamic" ? dynamicGroup : thresholdGroup,
      });
      const metadata = {
        name: "Renamed",
        owner: null,
        description: null,
        workflowIds: [],
      };
      await update({ ...metadata, status: "active" });
      expect(writes).toEqual([{ ...metadata, enabled: true }]);
    },
  );

  it("returns the saved monitor after disabling it", async () => {
    const writes = useMonitor({ enabled: true });
    const result = await update({ status: "disabled" });
    expect(writes).toEqual([{ enabled: false }]);
    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toMatchInlineSnapshot(`
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

  it("merges percent settings without changing native thresholds or condition IDs", async () => {
    const writes = useMonitor({
      config: { detectionType: "percent", comparisonDelta: 3600 },
    });
    await update({
      config: { comparisonDeltaSeconds: 86400 },
      conditionGroup: thresholdGroup,
    });
    expect(writes).toEqual([
      {
        config: { detectionType: "percent", comparisonDelta: 86400 },
        conditionGroup: thresholdGroup,
      },
    ]);
  });

  it.each([
    ["events", ["error"], "count()", null],
    [
      "events_analytics_platform",
      ["trace_item_span"],
      "count(span.duration)",
      "server_weighted",
    ],
    ["events_analytics_platform", ["trace_item_log"], "count()", null],
    [
      "events_analytics_platform",
      ["trace_item_metric"],
      "sum(value,requests,counter,none)",
      "client_and_server_weighted",
    ],
    [
      "metrics",
      [],
      "percentage(sessions_crashed, sessions) AS _crash_rate_alert_aggregate",
      null,
    ],
    ["generic_metrics", ["transaction"], "p95(transaction.duration)", null],
  ])(
    "preserves %s / %j source settings when editing query filters",
    async (dataset, eventTypes, aggregate, extrapolationMode) => {
      const query = {
        dataset,
        eventTypes,
        aggregate,
        extrapolationMode,
        timeWindow: 3600,
        query: "",
        environment: null,
      };
      const source = structuredClone(metricMonitor.dataSources[0]);
      Object.assign(source.queryObj.snubaQuery, {
        ...query,
        timeWindow: 7200,
        query: "release:previous",
        environment: "production",
      });
      const writes = useMonitor({ dataSources: [source] });
      await update({
        query: { query: "", timeWindowSeconds: 3600, environment: null },
      });
      expect(writes).toEqual([{ dataSources: [query] }]);
    },
  );

  it.each([
    ["static", "dynamic"],
    ["dynamic", "dynamic"],
    ["percent", "static"],
  ])(
    "updates %s to %s with consistent config and conditions",
    async (previousMode, detectionType) => {
      const writes = useMonitor({
        config: {
          detectionType: previousMode,
          comparisonDelta: previousMode === "percent" ? 3600 : null,
        },
      });
      const conditionGroup =
        detectionType === "dynamic" ? dynamicGroup : thresholdGroup;
      await update({
        conditionGroup,
        ...(previousMode !== detectionType
          ? { config: { detectionType } }
          : {}),
      });
      expect(writes).toEqual([
        {
          config: { detectionType, comparisonDelta: null },
          conditionGroup,
        },
      ]);
    },
  );

  it.each([
    {},
    { config: { comparisonDeltaSeconds: 3600 } },
    { config: { detectionType: "percent" }, conditionGroup: thresholdGroup },
    {
      config: { detectionType: "dynamic" },
      conditionGroup: { ...dynamicGroup, conditions: [anomaly, anomaly] },
    },
    {
      config: { detectionType: "dynamic" },
      conditionGroup: {
        ...dynamicGroup,
        conditions: [{ ...anomaly, comparison: 100 }],
      },
    },
    { config: { detectionType: "dynamic" } },
    { config: { detectionType: "dynamic" }, conditionGroup: thresholdGroup },
  ])(
    "rejects incomplete or incompatible edits before writing: %j",
    async (changes) => {
      const writes = useMonitor();
      await expect(update(changes)).rejects.toThrow(UserInputError);
      expect(writes).toEqual([]);
    },
  );

  it("refuses to merge a query whose source is unavailable", async () => {
    const writes = useMonitor({ dataSources: [] });
    await expect(
      update({ query: { aggregate: "count_unique(user)" } }),
    ).rejects.toThrow(UserInputError);
    expect(writes).toEqual([]);
  });
});
