import type { GetOrganizationWorkflowResponse } from "@sentry/api";
import { text, tableCell } from "@sentry/toolkit-core/markdown";
import type { MetricMonitor } from "../api/detectors.js";
import { stringifyUnknown } from "../errors.js";
import { monitorQuery } from "../metric-monitor.js";
import { mdKvTable, renderMarkdown } from "./markdown.js";
import { formatTable } from "./table.js";

export type MetricMonitorView = MetricMonitor & {
  org: string;
  workflows: GetOrganizationWorkflowResponse[];
  workflowErrors: { id: string; status: number }[];
};

export function formatMetricMonitorView(monitor: MetricMonitorView): string {
  const query = monitorQuery(monitor);
  const sections = [
    `## Monitor ${text(monitor.id)}: ${text(monitor.name)}`,
    mdKvTable([
      ["Organization", text(monitor.org)],
      ["Project ID", text(monitor.projectId ?? "none")],
      ["Enabled", String(monitor.enabled)],
      ["Description", text(monitor.description ?? "none")],
      ["Owner", text(JSON.stringify(monitor.owner) ?? "not returned")],
      ["Aggregate", text(stringifyUnknown(query?.aggregate ?? "not returned"))],
      ["Dataset", text(stringifyUnknown(query?.dataset ?? "not returned"))],
      ["Query", text(stringifyUnknown(query?.query ?? ""))],
      [
        "Window",
        typeof query?.timeWindow === "number"
          ? `${query.timeWindow / 60}m`
          : "not returned",
      ],
      ["Environment", text(stringifyUnknown(query?.environment ?? "all"))],
      ["Config", text(JSON.stringify(monitor.config) ?? "not returned")],
      [
        "Conditions",
        text(JSON.stringify(monitor.conditionGroup) ?? "not returned"),
      ],
      [
        "Connected alerts",
        monitor.workflowIds == null
          ? "not returned; notification configuration is unverified"
          : monitor.workflowIds.join(", ") || "none",
      ],
    ]),
  ];
  for (const workflow of monitor.workflows) {
    sections.push(
      `### Alert ${text(workflow.id)}: ${text(workflow.name)}`,
      mdKvTable([
        ["Enabled", String(workflow.enabled)],
        ["Triggers", text(JSON.stringify(workflow.triggers) ?? "not returned")],
        [
          "Action filters",
          text(JSON.stringify(workflow.actionFilters) ?? "not returned"),
        ],
        ["Config", text(JSON.stringify(workflow.config) ?? "not returned")],
      ]),
    );
  }
  for (const error of monitor.workflowErrors) {
    sections.push(
      `Alert ${text(error.id)}: HTTP ${error.status}; notification configuration is unverified.`,
    );
  }
  return renderMarkdown(sections.join("\n\n"));
}

export function formatMetricMonitorList(
  monitors: (MetricMonitor & { orgSlug: string })[],
): string {
  return formatTable(monitors, [
    { header: "ID", value: (m) => m.id },
    { header: "NAME", value: (m) => tableCell(m.name) },
    { header: "ORG", value: (m) => m.orgSlug },
    { header: "PROJECT", value: (m) => m.projectId ?? "" },
    { header: "ENABLED", value: (m) => String(m.enabled) },
    {
      header: "AGGREGATE",
      value: (m) => stringifyUnknown(monitorQuery(m)?.aggregate ?? ""),
    },
    {
      header: "DATASET",
      value: (m) => stringifyUnknown(monitorQuery(m)?.dataset ?? ""),
    },
  ]);
}
