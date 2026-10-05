import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { MetricMonitorCreate } from "../../api-client/types";
import { createTestContext } from "../../test-utils/context";
import { metricMonitor } from "../../test-utils/metric-monitor";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";
import { executeToolHandler } from "../catalog-runtime/availability";
import createMetricMonitor from "./create-metric-monitor";
import findMetricMonitors from "./find-metric-monitors";

const endpoint =
  "https://sentry.io/api/0/organizations/test-org/projects/backend/detectors/";
const params = {
  organizationSlug: "test-org",
  projectSlug: "backend",
  name: "High error rate",
  query: {
    dataset: "events",
    query: "level:error",
    aggregate: "count()",
    eventTypes: ["error"],
    timeWindowSeconds: 3600,
  },
  config: { detectionType: "static" },
  conditionGroup: {
    id: metricMonitor.conditionGroup.id,
    conditions: metricMonitor.conditionGroup.conditions,
  },
};
const anomalyGroup = {
  logicType: "any",
  conditions: [
    {
      type: "anomaly_detection",
      comparison: {
        sensitivity: "high",
        seasonality: "auto",
        thresholdType: 2,
      },
      conditionResult: 75,
    },
  ],
};
const context = createTestContext();

function create(changes: Record<string, unknown> = {}) {
  return executeToolHandler({
    tool: createMetricMonitor,
    params: { ...params, ...changes },
    context,
  });
}

function savedMonitor(body: MetricMonitorCreate) {
  const source = structuredClone(metricMonitor.dataSources[0]);
  Object.assign(source.queryObj.snubaQuery, body.dataSources[0]);
  return {
    ...metricMonitor,
    ...body,
    enabled: true,
    owner: body.owner ? metricMonitor.owner : null,
    description: body.description ?? null,
    dataSources: [source],
    conditionGroup: {
      ...body.conditionGroup,
      id: "101",
      conditions: body.conditionGroup.conditions.map((condition, index) => ({
        ...condition,
        id: String(201 + index),
      })),
    },
  };
}

function useCreateHandler(status = 201) {
  const writes: MetricMonitorCreate[] = [];
  mswServer.use(
    http.post(endpoint, async ({ request }) => {
      const body = (await request.json()) as MetricMonitorCreate;
      writes.push(body);
      if (status !== 201)
        return HttpResponse.json(
          { detail: "Creation rejected by Sentry" },
          { status },
        );
      return HttpResponse.json(savedMonitor(body), { status });
    }),
  );
  return writes;
}

describe("create_metric_monitor", () => {
  it("creates an active detached monitor with defaults and discards copied component IDs", async () => {
    const writes = useCreateHandler();
    const result = await create();
    expect(writes).toEqual([
      {
        type: "metric_issue",
        name: params.name,
        config: { detectionType: "static", comparisonDelta: null },
        dataSources: [
          {
            dataset: "events",
            query: "level:error",
            aggregate: "count()",
            eventTypes: ["error"],
            timeWindow: 3600,
            environment: null,
          },
        ],
        conditionGroup: {
          logicType: "any",
          conditions: [
            { type: "gt", comparison: 100, conditionResult: 75 },
            { type: "lte", comparison: 50, conditionResult: 0 },
          ],
        },
        workflowIds: [],
      },
    ]);
    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toMatchInlineSnapshot(`
      {
        "guidance": "This monitor has no connected Alerts. Connect an Alert with update_metric_monitor to configure notifications.",
        "monitor": {
          "conditionGroup": {
            "conditions": [
              {
                "comparison": 100,
                "conditionResult": 75,
                "id": "201",
                "type": "gt",
              },
              {
                "comparison": 50,
                "conditionResult": 0,
                "id": "202",
                "type": "lte",
              },
            ],
            "id": "101",
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
                "environment": null,
                "eventTypes": [
                  "error",
                ],
                "extrapolationMode": null,
                "query": "level:error",
                "timeWindowSeconds": 3600,
              },
              "type": "snuba_query_subscription",
            },
          ],
          "dateCreated": "2026-01-01T00:00:00.000Z",
          "dateUpdated": "2026-01-02T00:00:00.000Z",
          "description": null,
          "enabled": true,
          "id": "123",
          "name": "High error rate",
          "owner": null,
          "projectId": "100",
          "webUrl": "https://test-org.sentry.io/monitors/123/",
          "workflowIds": [],
        },
      }
    `);
  });

  it.each(["percent", "dynamic"])(
    "creates %s detection with existing Alert connections",
    async (detectionType) => {
      const writes = useCreateHandler();
      const conditionGroup =
        detectionType === "dynamic"
          ? anomalyGroup
          : {
              logicType: "any",
              conditions: [
                { type: "gt", comparison: 110, conditionResult: 75 },
                { type: "lte", comparison: 105, conditionResult: 0 },
              ],
            };
      const metadata = {
        owner: "team:7",
        description: "Monitor production errors",
        workflowIds: ["456"],
      };
      const comparisonDelta = detectionType === "percent" ? 86400 : null;
      const result = await create({
        config: {
          detectionType,
          comparisonDeltaSeconds: comparisonDelta,
        },
        conditionGroup,
        ...metadata,
      });
      expect(writes[0]).toMatchObject({
        config: { detectionType, comparisonDelta },
        conditionGroup,
        ...metadata,
      });
      expect(getStructuredContent(result)).not.toHaveProperty("guidance");
    },
  );

  it("leaves a Dynamic creation error visible and lets callers find the persisted monitor without retrying POST", async () => {
    const writes = useCreateHandler(500);
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/detectors/",
        () =>
          HttpResponse.json(
            writes.map((body) => ({
              ...savedMonitor(body),
              conditionGroup: null,
            })),
          ),
      ),
    );
    await expect(
      create({
        config: { detectionType: "dynamic" },
        conditionGroup: anomalyGroup,
      }),
    ).rejects.toMatchObject({
      name: "ApiServerError",
      status: 500,
      message: expect.stringContaining("find_metric_monitors"),
    });
    const result = await executeToolHandler({
      tool: findMetricMonitors,
      params: { organizationSlug: "test-org", query: "name:High error rate" },
      context,
    });
    expect(getStructuredContent(result)).toMatchObject({
      monitors: [{ id: "123", name: params.name }],
    });
    expect(writes).toHaveLength(1);
  });

  it("rejects a conflicting project before creating a monitor", async () => {
    const writes = useCreateHandler();
    const parsed = z.object(createMetricMonitor.inputSchema).parse(params);
    await expect(
      createMetricMonitor.handler(
        parsed,
        createTestContext({ constraints: { projectSlug: "other-project" } }),
      ),
    ).rejects.toThrow("outside the active project constraint");
    expect(writes).toEqual([]);
  });
});
