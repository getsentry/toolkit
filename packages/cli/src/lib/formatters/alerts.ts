/** Human-readable inspection of metric detectors and linked workflows. */
import type { GetOrganizationWorkflowResponse } from "@sentry/api";
import { METRIC_MONITOR_PRIORITY } from "@sentry/toolkit-core/metric-monitor";
import { metricAlertStatusLabel } from "../../commands/alert/metrics/status.js";
import type { MetricAlertRule } from "../api/alerts.js";
import { escapeMarkdownInline, mdKvTable, renderMarkdown } from "./markdown.js";

export type MetricAlertViewResult = {
  orgSlug: string;
  rule: MetricAlertRule;
  workflows: GetOrganizationWorkflowResponse[];
  workflowErrors: { id: string; status: number }[];
};

type Row = [string, string];

const OPERATORS: Record<string, string> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  eq: "=",
  ne: "!=",
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function valueText(value: unknown): string {
  if (value === undefined) {
    return "not returned";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function table(rows: Row[], heading?: string): string {
  return mdKvTable(
    rows.map(([label, value]) => [label, escapeMarkdownInline(value)]),
    heading,
  );
}

function conditionResult(value: unknown, detector: boolean): string {
  if (detector) {
    switch (value) {
      case METRIC_MONITOR_PRIORITY.resolved:
        return "OK / recovery (0)";
      case 25:
        return "low (25)";
      case METRIC_MONITOR_PRIORITY.warning:
        return "medium (50)";
      case METRIC_MONITOR_PRIORITY.critical:
        return "high (75)";
      default:
        break;
    }
  }
  return valueText(value);
}

function conditionText(value: unknown, detector: boolean): string {
  const condition = asObject(value);
  if (!condition || typeof condition.type !== "string") {
    return valueText(value);
  }
  const operator = OPERATORS[condition.type] ?? condition.type;
  const comparison = valueText(condition.comparison);
  const result = conditionResult(condition.conditionResult, detector);
  return `${operator} ${comparison} → ${result}`;
}

function conditionRows(value: unknown, detector: boolean): Row[] {
  const group = asObject(value);
  if (!group) {
    return [["Conditions", value === null ? "none" : valueText(value)]];
  }
  const rows: Row[] = [["Logic", valueText(group.logicType)]];
  const conditions = group.conditions;
  if (Array.isArray(conditions) && conditions.length > 0) {
    conditions.forEach((condition, index) => {
      rows.push([`Condition ${index + 1}`, conditionText(condition, detector)]);
    });
  } else {
    rows.push([
      "Conditions",
      Array.isArray(conditions) ? "none" : valueText(conditions),
    ]);
  }
  return rows;
}

function actionSection(value: unknown, index: number): string {
  const action = asObject(value);
  if (!action) {
    return table([["Action", valueText(value)]], `Action ${index + 1}`);
  }
  const config = asObject(action.config);
  const target =
    config?.targetDisplay ||
    config?.targetIdentifier ||
    (config?.targetType === "issue_owners" ? "Issue owners" : undefined);
  const rows: Row[] = [
    ["Provider", valueText(action.type)],
    ["Target", target ? valueText(target) : "not returned"],
    ["Status", valueText(action.status)],
  ];
  if (action.integrationId !== undefined && action.integrationId !== null) {
    rows.push(["Integration ID", valueText(action.integrationId)]);
  }
  if (action.config !== undefined) {
    rows.push(["Config", valueText(action.config)]);
  }
  if (action.data !== undefined) {
    rows.push(["Data", valueText(action.data)]);
  }
  return table(rows, `Action ${index + 1}`);
}

function workflowGroupSections(value: unknown, heading: string): string[] {
  const sections = [table(conditionRows(value, false), heading)];
  const group = asObject(value);
  const actions = group?.actions;
  if (Array.isArray(actions) && actions.length > 0) {
    sections.push(...actions.map(actionSection));
  } else if (group) {
    sections.push(
      table([
        ["Actions", Array.isArray(actions) ? "none" : valueText(actions)],
      ]),
    );
  }
  return sections;
}

function workflowSections(workflow: GetOrganizationWorkflowResponse): string[] {
  const sections = [
    `## Workflow ${escapeMarkdownInline(workflow.id)}: ${escapeMarkdownInline(workflow.name)}`,
    table([
      ["Status", workflow.enabled ? "enabled" : "disabled"],
      ["Environment", workflow.environment ?? "all"],
      ["Config", valueText(workflow.config)],
    ]),
    ...workflowGroupSections(workflow.triggers, "Triggers"),
  ];
  if (workflow.actionFilters?.length) {
    workflow.actionFilters.forEach((group, index) => {
      sections.push(
        ...workflowGroupSections(group, `Action filter ${index + 1}`),
      );
    });
  } else {
    sections.push(table([["Action filters", "none"]]));
  }
  return sections;
}

/** Show current configuration without treating it as proof a notification fired. */
export function formatMetricAlertView(data: MetricAlertViewResult): string {
  const { orgSlug, rule, workflows, workflowErrors } = data;
  const sections = [
    `## Metric alert rule in ${escapeMarkdownInline(orgSlug)}`,
    table([
      ["ID", rule.id],
      ["Name", rule.name],
      ["Status", metricAlertStatusLabel(rule.status)],
      ["Dataset", rule.dataset],
      ["Aggregate", rule.aggregate],
      ["Query", rule.query || "(none)"],
      ["Time Window", `${rule.timeWindow}m`],
      ["Projects", rule.projects.join(", ") || "(all)"],
      ["Environment", rule.environment ?? "all"],
      ["Owner", rule.owner ?? "none"],
    ]),
    table(
      [
        ["Config", valueText(rule.config)],
        ...conditionRows(rule.conditionGroup, true),
      ],
      "Detection",
    ),
  ];
  if (rule.workflowIds === undefined || rule.workflowIds === null) {
    sections.push(
      "Workflow links were not returned; notification configuration is unverified.",
    );
  } else if (rule.workflowIds.length === 0) {
    sections.push("No workflows connected.");
  } else {
    sections.push(
      table([["Connected workflows", rule.workflowIds.join(", ")]]),
    );
  }
  for (const workflow of workflows) {
    sections.push(...workflowSections(workflow));
  }
  for (const error of workflowErrors) {
    const reason =
      error.status === 403 ? "access denied" : "not found or inaccessible";
    sections.push(
      `Workflow ${escapeMarkdownInline(error.id)}: ${reason} (HTTP ${error.status}); notification configuration is unverified.`,
    );
  }
  return renderMarkdown(sections.join("\n\n"));
}
