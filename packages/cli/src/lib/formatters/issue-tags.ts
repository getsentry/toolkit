/**
 * Render the API's top-values aggregate without treating the returned subset
 * as the whole distribution. JSON retains the original API response.
 */

import type { GetOrganizationIssueTagResponse } from "@sentry/api";
import { sanitize } from "./local.js";
import { escapeMarkdownInline, renderMarkdown } from "./markdown.js";
import { type Column, formatTable } from "./table.js";

type TagValue = NonNullable<
  GetOrganizationIssueTagResponse["topValues"]
>[number];

function percentage(
  count: number | null,
  total: number | null | undefined,
): string {
  return count !== null && typeof total === "number" && total > 0
    ? `${((count / total) * 100).toFixed(1)}%`
    : "—";
}

/** Show counts and shares of retained events, with any undisplayed remainder. */
export function formatIssueTags(tag: GetOrganizationIssueTagResponse): string {
  const values = tag.topValues ?? [];
  const total = tag.totalValues;
  const heading = renderMarkdown(
    `### ${escapeMarkdownInline(sanitize(tag.key))} — top values\n\n` +
      `Total retained events: ${total ?? "unknown"}\n`,
  );
  if (values.length === 0) {
    return `${heading}\nNo top values returned.\n`;
  }

  const columns: Column<TagValue>[] = [
    {
      header: "VALUE",
      value: (row) =>
        escapeMarkdownInline(
          sanitize(
            row.value === ""
              ? "(empty or missing)"
              : (row.value ?? "(unknown)"),
          ),
        ),
    },
    {
      header: "EVENTS",
      align: "right",
      value: (row) => String(row.count ?? "—"),
    },
    {
      header: "SHARE",
      align: "right",
      value: (row) => percentage(row.count, total),
    },
  ];
  let output = `${heading}\n${formatTable(values, columns)}\n`;

  // Null counts are unknown, not zero. Only subtract a fully known subset.
  if (typeof total === "number" && values.every((row) => row.count !== null)) {
    const displayed = values.reduce((sum, row) => sum + (row.count ?? 0), 0);
    const other = total - displayed;
    if (other > 0) {
      output += `\nOther values (not shown): ${other} events (${percentage(other, total)}).\n`;
    }
  }
  return output;
}
