/** Sanitized shapes from Sentry's DetectorSerializer and QuerySubscriptionSerializer. */
export function metricMonitor(overrides: Record<string, unknown> = {}) {
  return {
    id: "9",
    projectId: "1",
    name: "Error volume",
    description: "Detect elevated errors",
    type: "metric_issue",
    enabled: true,
    owner: null,
    createdBy: null,
    dateCreated: "2026-01-01T00:00:00Z",
    dateUpdated: "2026-01-01T00:00:00Z",
    workflowIds: ["42"],
    alertRuleId: null,
    ruleId: null,
    latestGroup: null,
    config: {
      detectionType: "percent",
      comparisonDelta: 3600,
      thresholdPeriod: 1,
    },
    dataSources: [
      {
        id: "10",
        organizationId: "1",
        type: "snuba_query_subscription",
        sourceId: "11",
        queryObj: {
          id: "11",
          status: 1,
          subscription: null,
          snubaQuery: {
            id: "12",
            aggregate: "count()",
            dataset: "events",
            eventTypes: ["error"],
            query: "level:error",
            timeWindow: 300,
            environment: "production",
            extrapolationMode: "client_and_server_weighted",
          },
        },
      },
    ],
    conditionGroup: {
      id: "13",
      organizationId: "1",
      logicType: "any",
      actions: [],
      conditions: [
        { id: "14", type: "gt", comparison: 110, conditionResult: 75 },
        { id: "15", type: "lte", comparison: 100, conditionResult: 0 },
      ],
    },
    ...overrides,
  };
}

export const nativeMonitorCreateBody = {
  name: "Error volume",
  type: "metric_issue",
  config: { detectionType: "static" },
  dataSources: [
    {
      dataset: "events",
      queryType: 0,
      eventTypes: ["error", "default"],
      query: "",
      aggregate: "count()",
      timeWindow: 300,
      environment: null,
    },
  ],
  conditionGroup: {
    logicType: "any",
    conditions: [
      { type: "gt", comparison: 100, conditionResult: 75 },
      { type: "lte", comparison: 100, conditionResult: 0 },
    ],
  },
};
