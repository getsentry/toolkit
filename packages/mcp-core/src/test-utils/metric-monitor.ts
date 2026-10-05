import type { Detector } from "../api-client/types";

// Native detector response: query configuration is nested in the subscription.
export const metricMonitor = {
  id: "123",
  projectId: "100",
  name: "High error rate",
  type: "metric_issue",
  enabled: false,
  description: "Monitor production errors",
  owner: { type: "team", id: "7", name: "Backend" },
  config: { detectionType: "static", comparisonDelta: null },
  conditionGroup: {
    id: "10",
    logicType: "any",
    conditions: [
      { id: "11", type: "gt", comparison: 100, conditionResult: 75 },
      { id: "12", type: "lte", comparison: 50, conditionResult: 0 },
    ],
  },
  dataSources: [
    {
      id: "20",
      type: "snuba_query_subscription",
      sourceId: "30",
      queryObj: {
        id: "30",
        subscription: "internal-subscription-id",
        snubaQuery: {
          id: "40",
          dataset: "events",
          query: "level:error",
          aggregate: "count()",
          timeWindow: 300,
          environment: "production",
          eventTypes: ["error"],
          extrapolationMode: null,
        },
      },
    },
  ],
  workflowIds: ["456"],
  dateCreated: "2026-01-01T00:00:00Z",
  dateUpdated: "2026-01-02T00:00:00Z",
  alertRuleId: 42,
} satisfies Detector;
