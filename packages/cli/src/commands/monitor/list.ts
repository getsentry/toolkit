/**
 * sentry monitor list
 *
 * List cron monitors in an organization, with flexible targeting and cursor
 * pagination.
 *
 * Supports:
 * - Auto-detection from DSN/config
 * - Org-scoped listing with cursor pagination (e.g., sentry/)
 * - Project-scoped targeting (e.g., sentry/cli) — monitors are org-scoped, so
 *   this lists the org's monitors
 * - Cross-org project search (e.g., sentry)
 */

import { listMonitors, listMonitorsPaginated } from "../../lib/api-client.js";
import { escapeMarkdownCell } from "../../lib/formatters/markdown.js";
import { type Column, formatTable } from "../../lib/formatters/table.js";
import {
  buildOrgListCommand,
  type OrgListCommandDocs,
} from "../../lib/list-command.js";
import type { OrgListConfig } from "../../lib/org-list.js";
import { type SentryMonitor, SentryMonitorSchema } from "../../types/index.js";

/** Command key for pagination cursor storage */
export const PAGINATION_KEY = "monitor-list";

/** Monitor with its organization context for display */
type MonitorWithOrg = SentryMonitor & { orgSlug?: string };

/**
 * Render a monitor's schedule for display.
 *
 * Crontab schedules show the raw expression (e.g. `"0 * * * *"`).
 * Interval schedules show `"every <value> <unit>"` (e.g. `"every 1 hour"`).
 * Returns an empty string when no schedule is configured.
 */
export function formatSchedule(monitor: MonitorWithOrg): string {
  const config = monitor.config;
  if (!config?.schedule) {
    return "";
  }
  if (Array.isArray(config.schedule)) {
    if (config.schedule.length < 2) {
      return String(config.schedule[0] ?? "");
    }
    return `every ${config.schedule[0]} ${config.schedule[1]}`;
  }
  return config.schedule;
}

/** Column definitions for the monitor table. */
const MONITOR_COLUMNS: Column<MonitorWithOrg>[] = [
  { header: "ID", value: (m) => m.id },
  { header: "SLUG", value: (m) => m.slug },
  { header: "NAME", value: (m) => escapeMarkdownCell(m.name) },
  { header: "STATUS", value: (m) => m.status },
  { header: "SCHEDULE", value: (m) => escapeMarkdownCell(formatSchedule(m)) },
];

/** Shared config that plugs into the org-list framework. */
const monitorListConfig: OrgListConfig<SentryMonitor, MonitorWithOrg> = {
  paginationKey: PAGINATION_KEY,
  entityPlural: "monitors",
  commandPrefix: "sentry monitor list",
  listForOrg: (org) => listMonitors(org),
  listPaginated: (org, opts) => listMonitorsPaginated(org, opts),
  withOrg: (monitor, orgSlug) => ({ ...monitor, orgSlug }),
  displayTable: (monitors: MonitorWithOrg[]) =>
    formatTable(monitors, MONITOR_COLUMNS),
  schema: SentryMonitorSchema,
};

const docs: OrgListCommandDocs = {
  brief: "List cron monitors",
  fullDescription:
    "List cron monitors in an organization.\n\n" +
    "Target specification:\n" +
    "  sentry monitor list               # auto-detect from DSN or config\n" +
    "  sentry monitor list <org>/        # list all monitors in org (paginated)\n" +
    "  sentry monitor list <org>/<proj>  # list monitors in org (project context)\n" +
    "  sentry monitor list <org>         # list monitors in org\n\n" +
    "Pagination:\n" +
    "  sentry monitor list <org>/ -c next  # fetch next page\n" +
    "  sentry monitor list <org>/ -c prev  # fetch previous page\n\n" +
    "Examples:\n" +
    "  sentry monitor list              # auto-detect or list all\n" +
    "  sentry monitor list my-org/      # list monitors in my-org (paginated)\n" +
    "  sentry monitor list --limit 10\n" +
    "  sentry monitor list --json\n\n" +
    "Alias: `sentry monitors` → `sentry monitor list`",
};

export const listCommand = buildOrgListCommand(
  monitorListConfig,
  docs,
  "monitor"
);
