import type { GetOrganizationWorkflowResponse } from "@sentry/api";
import { describe, expect, test } from "vitest";
import type { MetricAlertRule } from "../../../src/lib/api/alerts.js";
import {
  formatMetricAlertView,
  type MetricAlertViewResult,
} from "../../../src/lib/formatters/alerts.js";

const rule: MetricAlertRule = {
  id: "9",
  name: "P95 latency",
  status: 0,
  query: "environment:prod",
  aggregate: "p95(span.duration)",
  dataset: "spans",
  timeWindow: 5,
  environment: "prod",
  owner: null,
  projects: ["backend"],
  dateCreated: "2026-10-20T00:00:00Z",
  workflowIds: ["12"],
  config: { detectionType: "static", thresholdPeriod: 3 },
  conditionGroup: {
    logicType: "any",
    conditions: [
      { type: "gte", comparison: 500, conditionResult: 75 },
      { type: "lte", comparison: 300, conditionResult: 0 },
    ],
  },
};

const workflow: GetOrganizationWorkflowResponse = {
  id: "12",
  name: "Notify on-call",
  organizationId: "1",
  createdBy: null,
  dateCreated: "2026-10-20T00:00:00Z",
  dateUpdated: "2026-10-20T00:00:00Z",
  enabled: false,
  environment: "prod",
  config: { frequency: 30 },
  detectorIds: ["9"],
  lastTriggered: null,
  owner: null,
  triggers: {
    logicType: "any",
    conditions: [
      { type: "level_change", comparison: true, conditionResult: true },
    ],
    actions: [],
  },
  actionFilters: [
    {
      logicType: "all",
      conditions: [{ type: "eq", comparison: 75, conditionResult: true }],
      actions: [
        {
          id: "21",
          type: "slack",
          integrationId: "15",
          status: "active",
          config: {
            targetType: "specific",
            targetDisplay: "#backend_alerts",
            targetIdentifier: "C123",
          },
          data: { tags: "environment" },
        },
      ],
    },
  ],
};

function view(overrides: Partial<MetricAlertViewResult> = {}): string {
  return formatMetricAlertView({
    orgSlug: "test-org",
    rule,
    workflows: [workflow],
    workflowErrors: [],
    ...overrides,
  });
}

describe("formatMetricAlertView", () => {
  test("shows thresholds, recovery and notification gates with provider and target", () => {
    const output = view();

    expect(output).toContain("P95 latency");
    expect(output).toContain('"thresholdPeriod":3');
    expect(output).toContain(">= 500 → high (75)");
    expect(output).toContain("<= 300 → OK / recovery (0)");
    expect(output).toContain("Notify on-call");
    expect(output).toContain("disabled");
    expect(output).toContain('"frequency":30');
    expect(output).toContain("level_change true → true");
    expect(output).toContain("= 75 → true");
    expect(output).toContain("slack");
    expect(output).toContain("#backend_alerts");
    expect(output).toContain("C123");
    expect(output).toContain("active");
    expect(output).toContain('"tags":"environment"');
  });

  test("preserves structured comparisons and trigger actions with an opaque target", () => {
    const output = view({
      rule: {
        ...rule,
        config: { detectionType: "dynamic" },
        conditionGroup: {
          logicType: "any",
          conditions: [
            {
              type: "anomaly_detection",
              comparison: { sensitivity: "high" },
              conditionResult: 50,
            },
          ],
        },
      },
      workflows: [
        {
          ...workflow,
          triggers: {
            logicType: "any",
            conditions: [],
            actions: [
              {
                type: "pagerduty",
                status: "disabled",
                config: { targetIdentifier: "service-123" },
                data: { severity: "critical" },
              },
            ],
          },
          actionFilters: [],
        },
      ],
    });

    expect(output).toContain(
      'anomaly_detection {"sensitivity":"high"} → medium (50)',
    );
    expect(output).toContain("pagerduty");
    expect(output).toContain("service-123");
    expect(output).toContain('"severity":"critical"');
  });

  test("distinguishes disconnected workflows from unknown linkage", () => {
    const disconnected = view({
      rule: { ...rule, workflowIds: [] },
      workflows: [],
    });
    const unknown = view({
      rule: { ...rule, workflowIds: null },
      workflows: [],
    });

    expect(disconnected).toContain("No workflows connected.");
    expect(unknown).toContain("Workflow links were not returned");
    expect(unknown).toContain("notification configuration is unverified");
    expect(unknown).not.toContain("No workflows connected.");
  });

  test("shows unreadable workflows as unverified without claiming no notifications", () => {
    const output = view({
      rule: { ...rule, workflowIds: ["12", "13"] },
      workflows: [],
      workflowErrors: [
        { id: "12", status: 403 },
        { id: "13", status: 404 },
      ],
    });

    expect(output).toContain("Workflow 12: access denied (HTTP 403)");
    expect(output).toContain(
      "Workflow 13: not found or inaccessible (HTTP 404)",
    );
    expect(output).toContain("notification configuration is unverified");
    expect(output).not.toContain("No workflows connected.");
  });
});
