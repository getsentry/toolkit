import type { SentryApiService } from "../../api-client/index";

/**
 * Fetches breadcrumbs from an issue event and formats them.
 * Defaults to the latest event when eventId is omitted.
 */
export async function fetchAndFormatBreadcrumbs(
  apiService: SentryApiService,
  organizationSlug: string,
  issueId: string,
  eventId: string = "latest",
): Promise<string> {
  const event = await apiService.getEventForIssue({
    organizationSlug,
    issueId,
    eventId,
  });

  const breadcrumbEntry = event.entries.find((e) => e.type === "breadcrumbs");
  const entryData = breadcrumbEntry?.data as
    | { values?: Array<Record<string, unknown>> }
    | undefined;
  const breadcrumbs = entryData?.values ?? [];

  return formatBreadcrumbs(breadcrumbs, issueId, event.id);
}

export function formatBreadcrumbs(
  breadcrumbs: Array<{
    timestamp?: string | null;
    type?: string | null;
    category?: string | null;
    level?: string | null;
    message?: string | null;
    data?: Record<string, unknown> | null;
  }>,
  issueId: string,
  eventId: string,
): string {
  if (breadcrumbs.length === 0) {
    return [
      `# Breadcrumbs for ${issueId}`,
      "",
      `**Event ID**: ${eventId}`,
      "",
      "No breadcrumbs found in this event for the issue.",
    ].join("\n");
  }

  const output: string[] = [
    `# Breadcrumbs for ${issueId}`,
    "",
    `**Event ID**: ${eventId}`,
    `**Total Breadcrumbs**: ${breadcrumbs.length}`,
    "",
    "```",
  ];

  for (const crumb of breadcrumbs) {
    const timestamp = crumb.timestamp
      ? new Date(crumb.timestamp).toISOString()
      : " ".repeat(24);
    const level = (crumb.level ?? "info").padEnd(7);
    const category = crumb.category ?? crumb.type ?? "-";
    const message = cleanAndTruncate(crumb.message ?? "", 120);
    const data = formatBreadcrumbData(crumb.data);

    const parts = [`${timestamp} ${level} [${category}]`];
    if (message) parts.push(message);
    if (data) parts.push(data);
    output.push(parts.join(" "));
  }

  output.push("```");

  output.push(
    "",
    "Breadcrumbs show the trail of events leading up to the error, in chronological order.",
    `Use \`get_sentry_resource(resourceType='issue', organizationSlug='...', resourceId='${issueId}')\` for full issue details.`,
  );

  return output.join("\n");
}

/**
 * Formats breadcrumb data as a compact inline JSON string.
 */
export function formatBreadcrumbData(
  data: Record<string, unknown> | null | undefined,
): string {
  if (!data || Object.keys(data).length === 0) return "";
  return cleanAndTruncate(JSON.stringify(data), 200);
}

/**
 * Strips newlines and truncates a string to maxLen characters.
 */
export function cleanAndTruncate(str: string, maxLen: number): string {
  const clean = str.replace(/[\r\n]+/g, " ");
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen)}...`;
}
