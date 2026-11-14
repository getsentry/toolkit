import { z } from "zod";
import { ErrorEntrySchema } from "../../api-client";
import type { Event, Trace } from "../../api-client/types";
import {
  SelectedEventPackagesSchema,
  selectEventPackages,
} from "../../internal/event-packages";
import {
  KNOWN_PERFORMANCE_ISSUE_TYPES,
  type MetricAlertContext,
  type MetricIssueCondition,
  type N1EvidenceData,
  OCCURRENCE_TYPE_TO_ISSUE_TYPE,
  type PerformanceSpan,
  formatMetricAlertCondition,
  formatMetricAlertValue,
  getMetricAlertContext,
  getMetricAlertDatasetKind,
  getMetricAlertEvaluatedWindow,
  getRepeatingSpanLines,
  parseThreadsEntryData,
  safeParseInt,
  selectN1EvidenceSpans,
  stripReplayMetadata,
} from "../../internal/formatting";
import { isPlainObject } from "../../internal/type-guards";
import {
  type StructuredThread,
  mapStructuredStacktrace,
  mapStructuredThread,
  mapStructuredThreadSummary,
  nonEmptyString,
  structuredStacktraceSchema,
  structuredThreadSchema,
  structuredThreadSummarySchema,
} from "./structured-stacktrace";

const exceptionSchema = z.object({
  type: z.string().nullable(),
  value: z.string().nullable(),
  module: z.string().nullable(),
  mechanism: z
    .object({ type: z.string().nullable(), handled: z.boolean().nullable() })
    .nullable(),
  stacktrace: structuredStacktraceSchema.nullable(),
});

const evidenceItemSchema = z.object({ name: z.string(), value: z.string() });

const performanceSpanSchema = z.object({
  spanId: z.string().nullable(),
  parentSpanId: z.string().nullable(),
  op: z.string().nullable(),
  description: z.string().nullable(),
  durationMs: z.number().nullable(),
  isOffender: z.boolean(),
});

/**
 * The event as `structuredContent`. Every field is mapped from the event
 * entries Sentry returns; nothing is spread from the api response.
 */
/** Thread summaries listed per event; get_event_stacktrace reads any one thread in full. */
const MAX_THREAD_SUMMARIES = 20;

export const issueEventSchema = z.object({
  id: z.string(),
  type: z.string().nullable(),
  occurredAt: z.string().nullable(),
  platform: z.string().nullable(),
  message: z.string().nullable(),
  exceptions: z
    .array(exceptionSchema)
    .nullable()
    .describe(
      "The exception that was raised first, then each one it was chained from.",
    ),
  threads: z
    .array(structuredThreadSummarySchema)
    .nullable()
    .describe(
      `The first ${MAX_THREAD_SUMMARIES} threads; threadCount says how many the event has.`,
    ),
  threadCount: z.number(),
  crashedThread: structuredThreadSchema
    .nullable()
    .describe("The crashed thread's stacktrace, when there is no exception."),
  request: z
    .object({ method: z.string().nullable(), url: z.string().nullable() })
    .nullable(),
  csp: z
    .object({
      blockedUri: z.string().nullable(),
      violatedDirective: z.string().nullable(),
      effectiveDirective: z.string().nullable(),
      documentUri: z.string().nullable(),
      sourceFile: z.string().nullable(),
      lineNumber: z.number().nullable(),
      disposition: z.string().nullable(),
      originalPolicy: z.string().nullable(),
    })
    .nullable(),
  performance: z
    .object({
      issueType: z.string().nullable(),
      transactionName: z.string().nullable(),
      parentOperation: z.string().nullable(),
      repeatedOperations: z.array(z.string()),
      repeatCount: z.number().nullable(),
      spans: z.array(performanceSpanSchema),
    })
    .nullable(),
  metricAlert: z
    .object({
      monitorId: z.string().nullable(),
      alertRuleId: z.string().nullable(),
      dataset: z.string().nullable(),
      aggregate: z.string().nullable(),
      query: z.string().nullable(),
      intervalSeconds: z.number().nullable(),
      environment: z.string().nullable(),
      evaluatedWindow: z
        .object({ start: z.string(), end: z.string() })
        .nullable(),
      value: z.string().nullable(),
      thresholds: z.array(z.string()),
    })
    .nullable(),
  evidence: z.array(evidenceItemSchema).nullable(),
  user: z
    .object({
      id: z.string().nullable(),
      email: z.string().nullable(),
      username: z.string().nullable(),
      ipAddress: z.string().nullable(),
      name: z.string().nullable(),
      geo: z
        .object({
          countryCode: z.string().nullable(),
          city: z.string().nullable(),
          region: z.string().nullable(),
        })
        .nullable(),
      data: z.record(z.string(), z.unknown()).nullable(),
    })
    .nullable(),
  tags: z.array(z.object({ key: z.string(), value: z.string().nullable() })),
  extra: z.record(z.string(), z.unknown()).nullable(),
  contexts: z.record(z.string(), z.record(z.string(), z.unknown())).nullable(),
  packageVersions: SelectedEventPackagesSchema.optional(),
});

export type IssueEventPayload = z.output<typeof issueEventSchema>;

type Entry = NonNullable<Event["entries"]>[number];

function findEntry(event: Event, type: string): Entry | undefined {
  return Array.isArray(event.entries)
    ? event.entries.find((entry) => entry.type === type)
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

/** Copies a user-data map, dropping keys with no value. */
function compactMap(
  value: unknown,
  omitKeys: ReadonlySet<string> = new Set(),
): Record<string, unknown> | null {
  const source = record(value);
  if (!source) {
    return null;
  }
  const entries = Object.entries(source).filter(
    ([key, entryValue]) => !omitKeys.has(key) && hasValue(entryValue),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/** The event types differ in where `dateCreated` sits; normalize it to ISO and tolerate bad values. */
/**
 * When the event happened. The transaction and unknown (CSP and others)
 * event schemas drop `dateCreated`, so fall back to `dateReceived`.
 */
export function getEventTimestamp(event: Event): Date | null {
  const raw =
    nonEmptyString((event as { dateCreated?: unknown }).dateCreated) ??
    nonEmptyString(event.dateReceived);
  if (!raw) {
    return null;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mapMessage(event: Event): string | null {
  const data = record(findEntry(event, "message")?.data);
  return (
    nonEmptyString(data?.["formatted"]) ??
    nonEmptyString(data?.["message"]) ??
    nonEmptyString(event.message)
  );
}

function mapExceptions(event: Event): IssueEventPayload["exceptions"] {
  const parsed = ErrorEntrySchema.safeParse(
    findEntry(event, "exception")?.data,
  );
  if (!parsed.success) {
    return null;
  }
  const { values: chain, value } = parsed.data;
  const values = chain ?? (value ? [value] : []);
  // Sentry lists the chain cause first; the exception that was raised is last.
  const exceptions = values
    .filter((exception) => exception != null)
    .reverse()
    .map((exception, index) => ({
      type: nonEmptyString(exception.type),
      value: nonEmptyString(exception.value),
      module: nonEmptyString(exception.module),
      mechanism: exception.mechanism
        ? {
            type: nonEmptyString(exception.mechanism.type),
            handled:
              typeof exception.mechanism.handled === "boolean"
                ? exception.mechanism.handled
                : null,
          }
        : null,
      // like the markdown view, only the raised exception's relevant frame gets context and variables
      stacktrace: mapStructuredStacktrace(exception.stacktrace, {
        detail: index === 0,
      }),
    }));
  return exceptions.length > 0 ? exceptions : null;
}

function mapThreads(event: Event, hasExceptions: boolean) {
  const entry = findEntry(event, "threads");
  const threads = entry
    ? (parseThreadsEntryData(entry.data)?.values ?? [])
    : [];
  if (threads.length === 0) {
    return { threads: null, threadCount: 0, crashedThread: null };
  }
  // the markdown shows the crashed thread's frames only when there is no exception
  const crashed = hasExceptions
    ? undefined
    : threads.find((thread) => thread.crashed && thread.stacktrace?.frames);
  const crashedThread: StructuredThread | null = crashed
    ? mapStructuredThread(crashed)
    : null;
  return {
    threads: threads
      .slice(0, MAX_THREAD_SUMMARIES)
      .map(mapStructuredThreadSummary),
    threadCount: threads.length,
    crashedThread,
  };
}

function mapRequest(event: Event): IssueEventPayload["request"] {
  const data = record(findEntry(event, "request")?.data);
  const method = nonEmptyString(data?.["method"]);
  const url = nonEmptyString(data?.["url"]);
  return method || url ? { method, url } : null;
}

function mapCsp(event: Event): IssueEventPayload["csp"] {
  const data = record(findEntry(event, "csp")?.data);
  if (!data) {
    return null;
  }
  return {
    blockedUri: nonEmptyString(data["blocked_uri"]),
    violatedDirective: nonEmptyString(data["violated_directive"]),
    effectiveDirective: nonEmptyString(data["effective_directive"]),
    documentUri: nonEmptyString(data["document_uri"]),
    sourceFile: nonEmptyString(data["source_file"]),
    lineNumber:
      typeof data["line_number"] === "number" ? data["line_number"] : null,
    disposition: nonEmptyString(data["disposition"]),
    originalPolicy: nonEmptyString(data["original_policy"]),
  };
}

function getOccurrence(event: Event): Record<string, unknown> | undefined {
  if (event.type !== "transaction" && event.type !== "generic") {
    return undefined;
  }
  return record((event as { occurrence?: unknown }).occurrence);
}

function mapEvidence(
  occurrence: Record<string, unknown> | undefined,
): IssueEventPayload["evidence"] {
  const display = occurrence?.["evidenceDisplay"];
  if (!Array.isArray(display)) {
    return null;
  }
  // the markdown shows only the items Sentry marks important
  const items = display
    .map(record)
    .filter((item) => item?.["important"] === true)
    .flatMap((item) => {
      const name = nonEmptyString(item?.["name"]);
      const value = nonEmptyString(item?.["value"]);
      return name && value ? [{ name, value }] : [];
    });
  return items.length > 0 ? items : null;
}

function flattenSpans(
  spans: PerformanceSpan[],
  parentSpanId: string | null = null,
): NonNullable<IssueEventPayload["performance"]>["spans"] {
  return spans.flatMap((span) => [
    {
      spanId: span.span_id,
      parentSpanId,
      op: span.op,
      description: span.description,
      durationMs:
        span.duration != null && span.duration > 0
          ? Math.round(span.duration * 100) / 100
          : null,
      isOffender: span.is_n1_query,
    },
    ...flattenSpans(span.children, span.span_id),
  ]);
}

const N1_ISSUE_TYPES: ReadonlySet<string> = new Set([
  KNOWN_PERFORMANCE_ISSUE_TYPES.N_PLUS_ONE_DB_QUERIES,
  KNOWN_PERFORMANCE_ISSUE_TYPES.N_PLUS_ONE_API_CALLS,
  KNOWN_PERFORMANCE_ISSUE_TYPES.M_N_PLUS_ONE_DB_QUERIES,
]);

function mapPerformance(
  event: Event,
  occurrence: Record<string, unknown> | undefined,
  performanceTrace: Trace | undefined,
): IssueEventPayload["performance"] {
  if (event.type !== "transaction" || !occurrence) {
    return null;
  }
  const issueType =
    typeof occurrence["type"] === "number"
      ? (OCCURRENCE_TYPE_TO_ISSUE_TYPE[occurrence["type"]] ?? null)
      : (nonEmptyString(occurrence["issueType"]) ??
        nonEmptyString(occurrence["type"]));
  const evidenceData: N1EvidenceData | undefined = record(
    occurrence["evidenceData"],
  );
  const isN1 = issueType != null && N1_ISSUE_TYPES.has(issueType);
  const repeatCount =
    isN1 && evidenceData
      ? evidenceData.numberRepeatingSpans
        ? safeParseInt(evidenceData.numberRepeatingSpans, 0)
        : evidenceData.numPatternRepetitions ||
          evidenceData.offenderSpanIds?.length ||
          0
      : 0;
  return {
    issueType,
    transactionName: nonEmptyString(evidenceData?.transactionName),
    parentOperation: nonEmptyString(evidenceData?.parentSpan),
    repeatedOperations:
      isN1 && evidenceData ? getRepeatingSpanLines(evidenceData) : [],
    repeatCount: repeatCount > 0 ? repeatCount : null,
    spans:
      isN1 && evidenceData
        ? flattenSpans(
            selectN1EvidenceSpans(
              evidenceData,
              findEntry(event, "spans")?.data,
              performanceTrace,
            ),
          )
        : [],
  };
}

function mapMetricAlert(
  event: Event,
  context: MetricAlertContext | undefined,
): IssueEventPayload["metricAlert"] {
  if (!context) {
    return null;
  }
  const { query, evidenceData } = context;
  const datasetKind = query ? getMetricAlertDatasetKind(query) : undefined;
  const window = getMetricAlertEvaluatedWindow(event, query);
  const conditions = Array.isArray(evidenceData.conditions)
    ? evidenceData.conditions
    : [];
  return {
    monitorId: context.monitorId ?? null,
    alertRuleId: context.alertRuleId ?? null,
    // the dataset the monitor's search tool reads (errors, logs, spans, metrics) when known
    dataset: datasetKind ?? nonEmptyString(query?.dataset),
    aggregate: nonEmptyString(query?.aggregate),
    query: nonEmptyString(query?.query),
    intervalSeconds: query?.timeWindowSeconds ?? null,
    environment: nonEmptyString(query?.environment),
    evaluatedWindow: window
      ? { start: window.start.toISOString(), end: window.end.toISOString() }
      : null,
    value: formatMetricAlertValue(evidenceData.value) ?? null,
    thresholds: conditions
      .filter(isPlainObject)
      .map((condition) =>
        formatMetricAlertCondition(
          condition as Partial<Record<keyof MetricIssueCondition, unknown>>,
        ),
      )
      .filter((condition): condition is string => condition != null),
  };
}

function mapUser(event: Event): IssueEventPayload["user"] {
  const user = record((event as { user?: unknown }).user);
  if (!user) {
    return null;
  }
  const geo = record(user["geo"]);
  const mappedGeo = geo
    ? {
        countryCode: nonEmptyString(geo["country_code"]),
        city: nonEmptyString(geo["city"]),
        region: nonEmptyString(geo["region"]),
      }
    : null;
  const mapped = {
    id: nonEmptyString(user["id"]),
    email: nonEmptyString(user["email"]),
    username: nonEmptyString(user["username"]),
    // Sentry's user interface serializes `ip_address` and `name`; some
    // payloads carry the `ip` / `display_name` aliases instead.
    ipAddress: nonEmptyString(user["ip_address"]) ?? nonEmptyString(user["ip"]),
    name: nonEmptyString(user["name"]) ?? nonEmptyString(user["display_name"]),
    geo:
      mappedGeo && Object.values(mappedGeo).some((value) => value !== null)
        ? mappedGeo
        : null,
    data: compactMap(user["data"]),
  };
  return Object.values(mapped).some((value) => value !== null) ? mapped : null;
}

function mapContexts(event: Event): IssueEventPayload["contexts"] {
  const contexts = record(event.contexts);
  if (!contexts) {
    return null;
  }
  const omitType = new Set(["type"]);
  const entries = Object.entries(contexts).flatMap(([name, value]) => {
    const mapped = compactMap(value, omitType);
    return mapped ? [[name, mapped] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/** Maps an issue event, of any type, to its structured payload. */
export function buildIssueEventPayload({
  event,
  performanceTrace,
  packageNames,
}: {
  event: Event;
  performanceTrace?: Trace;
  packageNames?: string[];
}): IssueEventPayload {
  // replays are reported beside the event, not inside its contexts and tags
  const stripped = stripReplayMetadata(event);
  const exceptions = mapExceptions(stripped);
  const { threads, threadCount, crashedThread } = mapThreads(
    stripped,
    exceptions !== null,
  );
  const occurrence = getOccurrence(stripped);
  const metricAlertContext = getMetricAlertContext(stripped);
  const packageVersions = selectEventPackages(event.packages, packageNames);

  return {
    id: event.id,
    type: nonEmptyString(event.type),
    occurredAt: getEventTimestamp(event)?.toISOString() ?? null,
    platform: nonEmptyString(event.platform),
    message: mapMessage(stripped),
    exceptions,
    threads,
    threadCount,
    crashedThread,
    request: mapRequest(stripped),
    csp: mapCsp(stripped),
    performance: mapPerformance(stripped, occurrence, performanceTrace),
    metricAlert: mapMetricAlert(stripped, metricAlertContext),
    // a metric issue's evidence is the alert itself, which metricAlert carries
    evidence: metricAlertContext ? null : mapEvidence(occurrence),
    user: mapUser(stripped),
    tags: (stripped.tags ?? []).map((tag) => ({
      key: tag.key,
      value: nonEmptyString(tag.value),
    })),
    extra: compactMap(stripped.context),
    contexts: mapContexts(stripped),
    ...(packageVersions ? { packageVersions } : {}),
  };
}
