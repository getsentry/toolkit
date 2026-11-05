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
  type ExecutedSearch,
  type SearchResultHints,
  summarizeTimeSeries,
} from "./formatters";
import { type FlexibleEventData, isAggregateQuery } from "./utils";

const timeRangeSchema = z.object({
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

type SearchResultType = (typeof SEARCH_RESULT_TYPES)[number];
type RowLinks = Record<string, string | null>;

/**
 * The search payload shape shared by every dataset, with links loosened to a
 * record. Use it to read rows generically; a dataset tool's own payload type
 * is `DatasetSearchStructuredContent`.
 */
export interface SearchEventsStructuredContent extends Record<string, unknown> {
  query: string;
  explanation: string | null;
  executedSearch: z.infer<typeof executedSearchSchema>;
  url: string;
  presentationHint: string;
  notes: string[];
  resultType: SearchResultType;
  results: Array<{ values: Record<string, unknown>; links: RowLinks }>;
  timeSeries: z.infer<typeof timeSeriesSchema> | null;
  suggestedActions: SuggestedToolAction[];
}

interface StructuredSearchSession {
  apiService: SentryApiService;
  organizationSlug: string;
  experimentalMode: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
}

type RowLinkShape = Record<string, z.ZodType<string | null>>;

interface SearchResultRow<TLinks extends RowLinkShape> {
  values: Record<string, unknown>;
  links: z.infer<z.ZodObject<TLinks>>;
}

interface StructuredDatasetConfig<TLinks extends RowLinkShape = RowLinkShape> {
  hints: SearchResultHints;
  /** The Sentry URLs derived for each result row; the output schema uses it. */
  links: TLinks;
  rowLinks(
    event: FlexibleEventData,
    session: StructuredSearchSession,
  ): z.infer<z.ZodObject<TLinks>>;
  suggestedActions(
    results: SearchResultRow<TLinks>[],
    session: StructuredSearchSession,
  ): SuggestedToolAction[];
}

/** Ties a dataset's `rowLinks` return type to its declared `links` schema. */
function defineDatasetConfig<TLinks extends RowLinkShape>(
  config: StructuredDatasetConfig<TLinks>,
): StructuredDatasetConfig<TLinks> {
  return config;
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
} satisfies Partial<Record<PublicEventsDataset, StructuredDatasetConfig>>;

export type StructuredSearchDataset = keyof typeof STRUCTURED_DATASETS;

type DatasetLinkShape<TDataset extends StructuredSearchDataset> =
  (typeof STRUCTURED_DATASETS)[TDataset]["links"];

/** Output schema for the dataset search tool that searches `dataset`. */
export function buildSearchEventsOutputSchema<
  TDataset extends StructuredSearchDataset,
>(dataset: TDataset) {
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
        links: z.object<DatasetLinkShape<TDataset>>(
          STRUCTURED_DATASETS[dataset].links,
        ),
      }),
    ),
    timeSeries: timeSeriesSchema.nullable(),
    suggestedActions: z.array(suggestedToolActionSchema),
  });
}

/**
 * The payload a dataset search tool returns, derived from that dataset's
 * output schema so builders and the tool's `outputSchema` cannot drift.
 */
export type DatasetSearchStructuredContent<
  TDataset extends StructuredSearchDataset,
> = z.output<ReturnType<typeof buildSearchEventsOutputSchema<TDataset>>>;

function isStructuredSearchDataset(
  dataset: string,
): dataset is StructuredSearchDataset {
  return Object.hasOwn(STRUCTURED_DATASETS, dataset);
}

/** Throws for a dataset whose tool has no structured output schema. */
export function assertStructuredSearchDataset(
  dataset: string,
): asserts dataset is StructuredSearchDataset {
  if (!isStructuredSearchDataset(dataset)) {
    throw new Error(`Structured search results are not defined for ${dataset}`);
  }
}

function getDatasetConfig<TDataset extends StructuredSearchDataset>(
  dataset: TDataset,
): StructuredDatasetConfig<DatasetLinkShape<TDataset>> {
  return STRUCTURED_DATASETS[dataset];
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

export function buildStructuredEventsResult<
  TDataset extends StructuredSearchDataset,
>(params: {
  dataset: TDataset;
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
}): StructuredToolOutput<DatasetSearchStructuredContent<TDataset>> {
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
        : params.notes,
    resultType: isAggregate ? "aggregates" : "samples",
    results,
    timeSeries: null,
    suggestedActions: config.suggestedActions(results, session),
  });
}

export function buildStructuredTimeSeriesResult<
  TDataset extends StructuredSearchDataset,
>(params: {
  dataset: TDataset;
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
}): StructuredToolOutput<DatasetSearchStructuredContent<TDataset>> {
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
