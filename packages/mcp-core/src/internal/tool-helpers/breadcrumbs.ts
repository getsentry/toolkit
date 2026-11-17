import { z } from "zod";
import type { SentryApiService } from "../../api-client/index";

const MAX_MESSAGE_LENGTH = 120;
const MAX_DATA_LENGTH = 200;

export const issueBreadcrumbsOutputSchema = z.object({
  issueId: z.string(),
  eventId: z.string(),
  breadcrumbs: z
    .array(
      z.object({
        timestamp: z.string().nullable(),
        level: z.string(),
        category: z.string().nullable(),
        type: z.string().nullable(),
        message: z
          .string()
          .nullable()
          .describe(
            `Single line, truncated after ${MAX_MESSAGE_LENGTH} characters.`,
          ),
        data: z
          .string()
          .nullable()
          .describe(
            `Compact JSON of the breadcrumb data, truncated after ${MAX_DATA_LENGTH} characters.`,
          ),
      }),
    )
    .describe("The trail of events leading up to the error, oldest first."),
});

type BreadcrumbValue = {
  timestamp?: string | null;
  type?: string | null;
  category?: string | null;
  level?: string | null;
  message?: string | null;
  data?: Record<string, unknown> | null;
};

/**
 * Fetches breadcrumbs from an issue event.
 * Defaults to the latest event when eventId is omitted.
 */
export async function fetchIssueBreadcrumbs(
  apiService: SentryApiService,
  organizationSlug: string,
  issueId: string,
  eventId: string = "latest",
): Promise<z.infer<typeof issueBreadcrumbsOutputSchema>> {
  const event = await apiService.getEventForIssue({
    organizationSlug,
    issueId,
    eventId,
  });

  const breadcrumbEntry = event.entries.find((e) => e.type === "breadcrumbs");
  const entryData = breadcrumbEntry?.data as
    | { values?: BreadcrumbValue[] }
    | undefined;

  return {
    issueId,
    eventId: event.id,
    breadcrumbs: (entryData?.values ?? []).map(mapBreadcrumb),
  };
}

function mapBreadcrumb(crumb: BreadcrumbValue) {
  return {
    timestamp: formatTimestamp(crumb.timestamp),
    level: crumb.level ?? "info",
    category: crumb.category ?? null,
    type: crumb.type ?? null,
    message: crumb.message
      ? cleanAndTruncate(crumb.message, MAX_MESSAGE_LENGTH)
      : null,
    data:
      crumb.data && Object.keys(crumb.data).length > 0
        ? cleanAndTruncate(JSON.stringify(crumb.data), MAX_DATA_LENGTH)
        : null,
  };
}

function formatTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

/**
 * Strips newlines and truncates a string to maxLen characters.
 */
function cleanAndTruncate(str: string, maxLen: number): string {
  const clean = str.replace(/[\r\n]+/g, " ");
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen)}...`;
}
