import { z } from "zod";
import { structuredResult } from "../../../internal/tool-helpers/results";
import { isPlainObject } from "../../../internal/type-guards";
import {
  buildSuggestedToolAction,
  suggestedToolActionSchema,
} from "../../../internal/tool-helpers/suggested-actions";
import { logInfo } from "../../../telem/logging";
import type { StructuredToolOutput } from "../../types";

const PRESENTATION_HINT =
  "Useful details to surface include severity, event IDs, and links. Please tell the user this dashboard link is available if they want to open the results in Sentry.";
const EMPTY_NOTE =
  "No results found. Try being more specific or using different terms in your search.";
const DEFAULT_SORT = "-timestamp";
const SORT_NOTE =
  "Results are newest first; the requested sort only applies to the Sentry link.";

const nullableString = z.string().nullable();

/**
 * The search_issue_events payload. Events are mapped explicitly from the
 * issue events endpoint (SimpleEventSerializer, or EventSerializer on an
 * event ID direct hit). The user data Sentry stored is returned; backend-only
 * fields such as entries, contexts, and metadata cannot leak.
 */
export const searchIssueEventsOutputSchema = z.object({
  query: z.string(),
  explanation: nullableString,
  executedSearch: z.object({
    issueId: z.string(),
    query: z.string(),
    timeRange: z.object({
      statsPeriod: nullableString,
      start: nullableString,
      end: nullableString,
    }),
  }),
  url: z.string().describe("Opens these results in Sentry."),
  issueUrl: z.string(),
  presentationHint: z.string(),
  notes: z.array(z.string()),
  events: z
    .array(
      z.object({
        id: z.string(),
        url: z.string(),
        eventType: nullableString,
        title: nullableString,
        message: nullableString,
        culprit: nullableString,
        location: nullableString,
        platform: nullableString,
        dateCreated: nullableString,
        user: z
          .object({
            id: nullableString,
            email: nullableString,
            username: nullableString,
            name: nullableString,
            ipAddress: nullableString,
            geo: z
              .object({
                countryCode: nullableString,
                city: nullableString,
                region: nullableString,
              })
              .nullable(),
          })
          .nullable(),
        tags: z.array(z.object({ key: z.string(), value: z.string() })),
      }),
    )
    .describe("Newest first; the issue events endpoint has no sort."),
  suggestedActions: z.array(suggestedToolActionSchema),
});

export type SearchIssueEventsStructuredContent = z.infer<
  typeof searchIssueEventsOutputSchema
>;

type IssueEvent = SearchIssueEventsStructuredContent["events"][number];

export interface BuildIssueEventResultsParams {
  events: Record<string, unknown>[];
  organizationSlug: string;
  issueId: string;
  issueUrl: string;
  explorerUrl: string;
  inputQuery: string;
  query: string;
  timeRange: { statsPeriod?: string; start?: string; end?: string };
  sort: string;
  explanation?: string;
  experimentalMode?: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
}

function readString(value: unknown): string | null {
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }
  return typeof value === "number" ? String(value) : null;
}

const allNull = (record: Record<string, unknown>) =>
  Object.values(record).every((field) => field === null);

function mapUser(value: unknown): IssueEvent["user"] {
  if (!isPlainObject(value)) {
    return null;
  }
  const geo = isPlainObject(value.geo)
    ? {
        countryCode: readString(value.geo.country_code),
        city: readString(value.geo.city),
        region: readString(value.geo.region),
      }
    : null;
  const user = {
    id: readString(value.id),
    email: readString(value.email),
    username: readString(value.username),
    name: readString(value.name),
    ipAddress: readString(value.ip_address),
    geo: geo && !allNull(geo) ? geo : null,
  };
  return allNull(user) ? null : user;
}

function mapTags(value: unknown): IssueEvent["tags"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((tag) => {
    if (!isPlainObject(tag)) {
      return [];
    }
    const key = readString(tag.key);
    const tagValue = readString(tag.value);
    // Tags with an empty value are dropped on purpose.
    return key && tagValue !== null ? [{ key, value: tagValue }] : [];
  });
}

function mapEvent(
  event: Record<string, unknown>,
  issueUrl: string,
): IssueEvent | null {
  const id = readString(event.eventID) ?? readString(event.id);
  if (!id) {
    return null;
  }
  return {
    id,
    url: `${issueUrl}/events/${id}/`,
    eventType: readString(event["event.type"]) ?? readString(event.type),
    title: readString(event.title),
    message: readString(event.message),
    culprit: readString(event.culprit),
    location: readString(event.location),
    platform: readString(event.platform),
    dateCreated: readString(event.dateCreated),
    user: mapUser(event.user),
    tags: mapTags(event.tags),
  };
}

/** Builds the structured search_issue_events result. */
export function buildIssueEventResults(
  params: BuildIssueEventResultsParams,
): StructuredToolOutput<SearchIssueEventsStructuredContent> {
  const events = params.events.flatMap((event) => {
    const mapped = mapEvent(event, params.issueUrl);
    return mapped ? [mapped] : [];
  });

  if (events.length === 0) {
    logInfo(`No error events found for query: ${params.inputQuery}`, {
      extra: {
        query: params.query,
        organizationSlug: params.organizationSlug,
        dataset: "errors",
      },
    });
  }

  const first = events[0];
  const action = first
    ? buildSuggestedToolAction({
        toolName: "get_sentry_resource",
        arguments: { url: first.url },
        reason: "Inspect the newest matching event in full.",
        experimentalMode: params.experimentalMode ?? false,
        availableToolNames: params.availableToolNames,
        directToolNames: params.directToolNames,
      })
    : null;

  return structuredResult({
    query: params.inputQuery,
    explanation: params.explanation || null,
    executedSearch: {
      issueId: params.issueId,
      query: params.query,
      timeRange: {
        statsPeriod: params.timeRange.statsPeriod ?? null,
        start: params.timeRange.start ?? null,
        end: params.timeRange.end ?? null,
      },
    },
    url: params.explorerUrl,
    issueUrl: params.issueUrl,
    presentationHint: PRESENTATION_HINT,
    notes: [
      ...(params.sort === DEFAULT_SORT ? [] : [SORT_NOTE]),
      ...(events.length === 0 ? [EMPTY_NOTE] : []),
    ],
    events,
    suggestedActions: action ? [action] : [],
  });
}
