/**
 * Structured results for the dataset-specific search tools.
 *
 * The markdown formatters stay the view for the legacy multi-dataset
 * search_events tool. Each dataset tool that declares an `outputSchema`
 * returns this payload instead; the server renders it as pretty JSON for
 * clients that only read `content`.
 */
import { z } from "zod";
import type { SentryApiService } from "../../../api-client";
import type { EventsTimeSeriesResponse } from "../../../api-client/schema";
import {
  buildSuggestedToolAction,
  type SuggestedToolAction,
  suggestedToolActionSchema,
} from "../../../internal/tool-helpers/suggested-actions";
import { structuredResult } from "../../../internal/tool-helpers/results";
import { logInfo } from "../../../telem/logging";
import type { StructuredToolOutput } from "../../types";
import type { PublicEventsDataset } from "../../../utils/events-datasets";
import {
  DASHBOARD_LINK_HINT,
  ERROR_RESULT_HINTS,
  getProfileDetailUrl,
  type ExecutedSearch,
  PROFILE_RESULT_HINTS,
  METRIC_RESULT_HINTS,
  SPAN_RESULT_HINTS,
  LOG_RESULT_HINTS,
  type SearchResultHints,
  summarizeTimeSeries,
} from "./formatters";
import { type FlexibleEventData, isAggregateQuery } from "./utils";

export const timeRangeSchema = z.object({
  statsPeriod: z.string().nullable(),
  start: z.string().nullable(),
  end: z.string().nullable(),
});

const executedSearchSchema = z.object({
  dataset: z.string(),
  query: z.string(),
  fields: z.array(z.string()),
  sort: z.string().nullable(),
  timeRange: timeRangeSchema,
});

const timeSeriesSchema = z.object({
  yAxis: z.string(),
  interval: z
    .string()
    .nullable()
    .describe("Bucket size; null when Sentry chose it for the range."),
  total: z
    .number()
    .nullable()
    .describe("Sum of all buckets; null for non-additive aggregates."),
  totalIncludesIncompleteBuckets: z.boolean(),
  peak: z
    .object({
      time: z.string(),
      value: z.union([z.number(), z.string()]),
    })
    .nullable()
    .describe("Highest bucket that is no longer receiving data."),
  ingestion: z
    .object({
      status: z.string(),
      delaySeconds: z.number().nullable(),
      completeThrough: z.string().nullable(),
    })
    .nullable(),
  bucketCount: z.number(),
  buckets: z
    .array(
      z.object({
        time: z.string(),
        value: z.union([z.number(), z.string()]),
        incomplete: z
          .boolean()
          .describe("Data is still arriving, so the value may rise."),
        outsideRetention: z
          .boolean()
          .describe(
            "Starts before the retention window, so older data is missing and the value will not change.",
          ),
      }),
    )
    .describe("The most recent buckets, oldest first."),
});

const SEARCH_RESULT_TYPES = ["samples", "aggregates", "timeSeries"] as const;

/**
 * The search payload every dataset shares, with row links loosened to a
 * record. Derived from the output schema so the builders cannot drift from
 * it; `DatasetSearchStructuredContent` narrows the links for one dataset.
 */
export type SearchEventsStructuredContent = z.output<
  ReturnType<
    typeof searchEventsOutputSchema<
      z.ZodRecord<z.ZodString, z.ZodNullable<z.ZodString>>
    >
  >
>;

interface StructuredSearchSession {
  apiService: SentryApiService;
  organizationSlug: string;
  experimentalMode: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
}

type RowLinkShape = Record<string, z.ZodType<string | null>>;

interface StructuredDatasetConfig<TLinks extends RowLinkShape = RowLinkShape> {
  hints: SearchResultHints;
  /** Units the raw values use, keyed by the field they describe. */
  fieldUnitNotes?: Record<string, string>;
  /** The Sentry URLs derived for each result row; the output schema uses it. */
  links: TLinks;
  rowLinks(
    event: FlexibleEventData,
    session: StructuredSearchSession,
  ): z.infer<z.ZodObject<TLinks>>;
  suggestedActions(
    results: SearchEventsStructuredContent["results"],
    session: StructuredSearchSession,
  ): SuggestedToolAction[];
}

/** Ties a dataset's `rowLinks` return type to its declared `links` schema. */
function defineDatasetConfig<TLinks extends RowLinkShape>(
  config: StructuredDatasetConfig<TLinks>,
): StructuredDatasetConfig<TLinks> {
  return config;
}

function getStringField(
  event: FlexibleEventData,
  field: string,
): string | null {
  const value = event[field];
  return typeof value === "string" && value ? value : null;
}

function traceUrlFor(
  event: FlexibleEventData,
  { apiService, organizationSlug }: StructuredSearchSession,
): string | null {
  const traceId = getStringField(event, "trace");
  return traceId ? apiService.getTraceUrl(organizationSlug, traceId) : null;
}

/** Suggests opening the trace of the first row that has one. */
function firstTraceAction(
  results: SearchEventsStructuredContent["results"],
  session: StructuredSearchSession,
  reason: string,
): SuggestedToolAction[] {
  const traceId = results
    .map((row) => row.values.trace)
    .find((trace): trace is string => typeof trace === "string" && !!trace);
  const action = traceId
    ? buildSuggestedToolAction({
        toolName: "get_sentry_resource",
        arguments: {
          organizationSlug: session.organizationSlug,
          resourceType: "trace",
          resourceId: traceId,
        },
        reason,
        experimentalMode: session.experimentalMode,
        availableToolNames: session.availableToolNames,
        directToolNames: session.directToolNames,
      })
    : null;
  return action ? [action] : [];
}

const STRUCTURED_DATASETS = {
  errors: defineDatasetConfig({
    hints: ERROR_RESULT_HINTS,
    links: { issueUrl: z.string().nullable() },
    rowLinks: (event, { apiService, organizationSlug }) => ({
      issueUrl:
        typeof event.issue === "string" && event.issue
          ? apiService.getIssueUrl(organizationSlug, event.issue)
          : null,
    }),
    suggestedActions(results, session) {
      const issueId = results
        .map((row) => row.values.issue)
        .find((issue): issue is string => typeof issue === "string" && !!issue);
      const action = issueId
        ? buildSuggestedToolAction({
            toolName: "get_sentry_resource",
            arguments: {
              organizationSlug: session.organizationSlug,
              resourceType: "issue",
              resourceId: issueId,
            },
            reason: "Inspect the first matching issue.",
            experimentalMode: session.experimentalMode,
            availableToolNames: session.availableToolNames,
            directToolNames: session.directToolNames,
          })
        : null;
      return action ? [action] : [];
    },
  }),
  logs: defineDatasetConfig({
    hints: LOG_RESULT_HINTS,
    links: {
      logUrl: z.string().nullable(),
      traceUrl: z.string().nullable(),
    },
    rowLinks: (event, session) => {
      const logId = getStringField(event, "id");
      return {
        logUrl: logId
          ? session.apiService.getLogUrl(session.organizationSlug, logId)
          : null,
        traceUrl: traceUrlFor(event, session),
      };
    },
    suggestedActions: (results, session) =>
      firstTraceAction(
        results,
        session,
        "Inspect the trace for the first matching log.",
      ),
  }),
  spans: defineDatasetConfig({
    hints: SPAN_RESULT_HINTS,
    fieldUnitNotes: {
      "span.duration": "span.duration values are in milliseconds.",
    },
    links: { traceUrl: z.string().nullable() },
    rowLinks: (event, session) => ({ traceUrl: traceUrlFor(event, session) }),
    suggestedActions: (results, session) =>
      firstTraceAction(
        results,
        session,
        "Inspect the trace for the first matching span.",
      ),
  }),
  metrics: defineDatasetConfig({
    hints: METRIC_RESULT_HINTS,
    links: { traceUrl: z.string().nullable() },
    rowLinks: (event, session) => ({ traceUrl: traceUrlFor(event, session) }),
    suggestedActions: (results, session) =>
      firstTraceAction(
        results,
        session,
        "Inspect the trace for the first matching metric sample.",
      ),
  }),
  profiles: defineDatasetConfig({
    hints: PROFILE_RESULT_HINTS,
    fieldUnitNotes: {
      "transaction.duration": "transaction.duration values are in nanoseconds.",
      "profile.duration": "profile.duration values are in nanoseconds.",
    },
    links: {
      profileUrl: z.string().nullable(),
      traceUrl: z.string().nullable(),
    },
    rowLinks: (event, session) => ({
      profileUrl: getProfileDetailUrl(
        session.apiService,
        session.organizationSlug,
        event,
      ),
      traceUrl: traceUrlFor(event, session),
    }),
    suggestedActions(results, session) {
      const profileUrl = results.find((row) => row.links.profileUrl)?.links
        .profileUrl;
      const reason = "Analyze the flamegraph for the first matching profile.";
      // Experimental sessions route profile URLs through get_sentry_resource.
      const profileAction = profileUrl
        ? buildSuggestedToolAction({
            ...(session.experimentalMode
              ? {
                  toolName: "get_sentry_resource",
                  arguments: { url: profileUrl },
                }
              : { toolName: "get_profile_details", arguments: { profileUrl } }),
            reason,
            experimentalMode: session.experimentalMode,
            availableToolNames: session.availableToolNames,
            directToolNames: session.directToolNames,
          })
        : null;
      return [
        ...(profileAction ? [profileAction] : []),
        ...firstTraceAction(
          results,
          session,
          "Inspect the trace for the first profiled request.",
        ),
      ];
    },
  }),
} satisfies Partial<Record<PublicEventsDataset, StructuredDatasetConfig>>;

export type StructuredSearchDataset = keyof typeof STRUCTURED_DATASETS;

function searchEventsOutputSchema<
  TLinks extends z.ZodType<Record<string, string | null>>,
>(links: TLinks) {
  return z.object({
    query: z.string(),
    explanation: z.string().nullable(),
    executedSearch: executedSearchSchema,
    url: z.string().describe("Opens these results in Sentry."),
    presentationHint: z.string(),
    notes: z.array(z.string()),
    resultType: z.enum(SEARCH_RESULT_TYPES),
    results: z.array(
      z.object({
        values: z
          .record(z.string(), z.unknown())
          .describe("The requested fields, keyed by field name."),
        links,
      }),
    ),
    timeSeries: timeSeriesSchema.nullable(),
    suggestedActions: z.array(suggestedToolActionSchema),
  });
}

/** Output schema for the dataset search tool that searches `dataset`. */
export function buildSearchEventsOutputSchema<
  TDataset extends StructuredSearchDataset,
>(dataset: TDataset) {
  return searchEventsOutputSchema(z.object(STRUCTURED_DATASETS[dataset].links));
}

/** The payload of the dataset search tool that searches `TDataset`. */
export type DatasetSearchStructuredContent<
  TDataset extends StructuredSearchDataset,
> = z.output<ReturnType<typeof buildSearchEventsOutputSchema<TDataset>>>;

function getDatasetConfig(dataset: string): StructuredDatasetConfig {
  if (!Object.hasOwn(STRUCTURED_DATASETS, dataset)) {
    throw new Error(`Structured search results are not defined for ${dataset}`);
  }
  return STRUCTURED_DATASETS[dataset as StructuredSearchDataset];
}

function toExecutedSearch(
  executedSearch: ExecutedSearch,
): SearchEventsStructuredContent["executedSearch"] {
  return {
    dataset: executedSearch.dataset,
    query: executedSearch.query,
    fields: executedSearch.fields ?? [],
    sort: executedSearch.sort ?? null,
    timeRange: {
      statsPeriod: executedSearch.timeRange?.statsPeriod ?? null,
      start: executedSearch.timeRange?.start ?? null,
      end: executedSearch.timeRange?.end ?? null,
    },
  };
}

/** Keeps only the fields the search requested; never the whole upstream row. */
function pickRequestedValues(
  event: FlexibleEventData,
  requestFields: readonly string[],
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of requestFields) {
    if (Object.hasOwn(event, field)) {
      values[field] = event[field];
    }
  }
  return values;
}

export function buildStructuredEventsResult(params: {
  dataset: PublicEventsDataset;
  eventData: FlexibleEventData[];
  inputQuery: string;
  includeExplanation: boolean;
  explanation?: string;
  explorerUrl: string;
  sentryQuery: string;
  fields: string[];
  requestFields: string[];
  executedSearch: ExecutedSearch;
  notes: string[];
  session: StructuredSearchSession;
}): StructuredToolOutput<SearchEventsStructuredContent> {
  const { dataset, eventData, fields, session } = params;
  const config = getDatasetConfig(dataset);
  const isAggregate = isAggregateQuery(fields);

  if (eventData.length === 0) {
    logInfo(`No ${dataset} events found for query: ${params.inputQuery}`, {
      extra: {
        query: params.sentryQuery,
        fields,
        organizationSlug: session.organizationSlug,
        dataset,
      },
    });
  }

  const results = eventData.map((event) => ({
    values: pickRequestedValues(event, params.requestFields),
    links: config.rowLinks(event, session),
  }));

  return structuredResult({
    query: params.inputQuery,
    explanation:
      params.includeExplanation && params.explanation
        ? params.explanation
        : null,
    executedSearch: toExecutedSearch(params.executedSearch),
    url: params.explorerUrl,
    presentationHint: `${isAggregate ? config.hints.aggregates : config.hints.samples} ${DASHBOARD_LINK_HINT}`,
    notes:
      results.length === 0
        ? [...params.notes, `No results found. ${config.hints.empty}`]
        : [
            ...params.notes,
            ...params.requestFields.flatMap(
              (field) => config.fieldUnitNotes?.[field] ?? [],
            ),
          ],
    resultType: isAggregate ? "aggregates" : "samples",
    results,
    timeSeries: null,
    suggestedActions: config.suggestedActions(results, session),
  });
}

export function buildStructuredTimeSeriesResult(params: {
  dataset: PublicEventsDataset;
  series: EventsTimeSeriesResponse;
  yAxis: string;
  interval: string | null;
  inputQuery: string;
  includeExplanation: boolean;
  explanation?: string;
  query: string;
  timeRange: { statsPeriod?: string; start?: string; end?: string };
  url: string;
  notes: string[];
}): StructuredToolOutput<SearchEventsStructuredContent> {
  const { bucketCount, shown, total, hasFilling, peak, ingestion } =
    summarizeTimeSeries(params.series, params.yAxis);

  return structuredResult({
    query: params.inputQuery,
    explanation:
      params.includeExplanation && params.explanation
        ? params.explanation
        : null,
    executedSearch: toExecutedSearch({
      dataset: params.dataset,
      query: params.query,
      fields: [params.yAxis],
      timeRange: params.timeRange,
    }),
    url: params.url,
    presentationHint: DASHBOARD_LINK_HINT,
    notes: params.notes,
    resultType: "timeSeries",
    results: [],
    timeSeries: {
      yAxis: params.yAxis,
      interval: params.interval,
      total,
      totalIncludesIncompleteBuckets: total !== null && hasFilling,
      peak: peak
        ? { time: new Date(peak.timestamp).toISOString(), value: peak.rawValue }
        : null,
      ingestion: ingestion
        ? {
            status: ingestion.status,
            delaySeconds: ingestion.delaySeconds ?? null,
            completeThrough:
              ingestion.completeThrough === undefined
                ? null
                : new Date(ingestion.completeThrough).toISOString(),
          }
        : null,
      bucketCount,
      buckets: shown.map((point) => ({
        time: new Date(point.timestamp).toISOString(),
        value: point.rawValue,
        incomplete: point.filling,
        outsideRetention: point.outsideRetention,
      })),
    },
    suggestedActions: [],
  });
}
