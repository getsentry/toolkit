/** Human rendering of native workflow documents, without flattening their state. */
import { tableCell } from "@sentry/toolkit-core/markdown";
import type { Alert } from "../api/alerts.js";
import type { WithOrg } from "../org-list.js";
import type {
  AlertDeleteOutput,
  AlertMutationOutput,
  AlertViewOutput,
} from "../../output-schemas/alert.js";
import { type Column, formatTable } from "./table.js";

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const ALERT_COLUMNS: Column<WithOrg<Alert>>[] = [
  { header: "ORG", value: (alert) => alert.orgSlug ?? "" },
  { header: "ID", value: (alert) => alert.id },
  { header: "NAME", value: (alert) => tableCell(alert.name) },
  { header: "ENABLED", value: (alert) => String(alert.enabled) },
  {
    header: "MONITORS",
    value: (alert) => String(alert.detectorIds?.length ?? 0),
  },
  {
    header: "TRIGGERS",
    value: (alert) => String(alert.triggers?.conditions?.length ?? 0),
  },
  {
    header: "ACTIONS",
    value: (alert) =>
      String(
        (alert.actionFilters ?? []).reduce(
          (count, group) => count + (group.actions?.length ?? 0),
          0,
        ),
      ),
  },
];

export function formatAlertTable(alerts: WithOrg<Alert>[]): string {
  return alerts.length
    ? formatTable(alerts, ALERT_COLUMNS)
    : "No alerts found.";
}

export function formatAlertView(alert: AlertViewOutput): string {
  return [
    `Alert ${alert.id} in ${alert.org}: ${alert.name}`,
    `Enabled: ${alert.enabled}`,
    `Monitors: ${(alert.detectorIds ?? []).join(", ") || "none (detached)"}`,
    `Environment: ${alert.environment ?? "all"}`,
    `Owner: ${alert.owner ?? "none"}`,
    `Created: ${alert.dateCreated}`,
    `Updated: ${alert.dateUpdated}`,
    `Last triggered: ${alert.lastTriggered ?? "never"}`,
    `Config:\n${json(alert.config)}`,
    `Triggers:\n${json(alert.triggers)}`,
    `Action filters and actions:\n${json(alert.actionFilters)}`,
  ].join("\n");
}

export function formatAlertMutation(
  action: "create" | "edit",
  alert: AlertMutationOutput,
): string {
  if (alert.dryRun) {
    return `Would ${action} alert '${alert.name}' in ${alert.org}:\n${json(alert.body)}`;
  }
  return `${action === "create" ? "Created" : "Updated"} alert ${alert.id} in ${alert.org}: ${alert.name} (enabled: ${alert.enabled}).`;
}

export function formatAlertDelete(alert: AlertDeleteOutput): string {
  return `${alert.dryRun ? "Would delete" : "Deleted"} alert '${alert.name}' (${alert.id}) in ${alert.org}.`;
}
