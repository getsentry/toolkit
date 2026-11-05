import type { Alert } from "../../src/lib/api/alerts.js";

/** Scrubbed native WorkflowSerializer document, including multiple action groups. */
export function workflow(overrides: Partial<Alert> = {}): Alert {
  return {
    id: "42",
    name: "Notify on-call",
    organizationId: "1",
    createdBy: "123",
    dateCreated: "2026-10-20T00:00:00Z",
    dateUpdated: "2026-10-21T00:00:00Z",
    enabled: false,
    environment: "production",
    config: { frequency: 30 },
    detectorIds: ["9"],
    lastTriggered: null,
    owner: "team:7",
    triggers: {
      id: "100",
      organizationId: "1",
      logicType: "any-short",
      conditions: [
        {
          id: "101",
          type: "first_seen_event",
          comparison: true,
          conditionResult: true,
        },
      ],
      actions: [],
    },
    actionFilters: [
      {
        id: "200",
        organizationId: "1",
        logicType: "all",
        conditions: [
          { id: "201", type: "eq", comparison: 75, conditionResult: true },
        ],
        actions: [
          {
            id: "202",
            type: "slack",
            integrationId: "15",
            status: "active",
            config: {
              targetType: "specific",
              targetIdentifier: "C123",
              targetDisplay: "#on-call",
            },
            data: { tags: "environment" },
          },
        ],
      },
      {
        id: "300",
        organizationId: "1",
        logicType: "any-short",
        conditions: [],
        actions: [
          {
            id: "301",
            type: "email",
            status: "active",
            config: { targetType: "team", targetIdentifier: "7" },
            data: {},
          },
        ],
      },
    ],
    ...overrides,
  };
}
