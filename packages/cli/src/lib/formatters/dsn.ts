/** Human output for the public DSN fields shown in Sentry's Client Keys UI. */

import type { ProjectDsn } from "../api/projects.js";
import type { ListResult } from "../org-list.js";
import { escapeMarkdownCell } from "./markdown.js";
import { type Column, formatTable } from "./table.js";
import { formatRelativeTime } from "./time-utils.js";

/** A public DSN with the organization and project slugs used to find it. */
export type DsnListItem = ProjectDsn & {
  /** Organization slug shown in the project context. */
  org: string;
  /** Project slug shown in the project context. */
  project: string;
};

const COLUMNS: Column<DsnListItem>[] = [
  {
    header: "PROJECT",
    value: (item) => escapeMarkdownCell(`${item.org}/${item.project}`),
    minWidth: 24,
  },
  {
    header: "NAME",
    value: (item) => escapeMarkdownCell(item.name),
    minWidth: 12,
  },
  {
    header: "STATUS",
    value: (item) => (item.isActive ? "Enabled" : "Disabled"),
    minWidth: 8,
  },
  {
    header: "CREATED",
    value: (item) => formatRelativeTime(item.dateCreated ?? undefined),
    minWidth: 7,
  },
  {
    header: "DSN",
    value: (item) => escapeMarkdownCell(item.dsn),
    shrinkable: false,
  },
];

/** Render a DSN page, preserving the complete public DSN for copying. */
export function formatDsnList(result: ListResult<DsnListItem>): string {
  if (result.items.length === 0) {
    return "No DSNs found on this page.";
  }
  return formatTable(result.items, COLUMNS);
}
