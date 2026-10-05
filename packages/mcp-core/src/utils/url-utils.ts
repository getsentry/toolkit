import type { SentryProtocol } from "../types";
import {
  type EventsDataset,
  isMetricsDataset,
  isProfilesDataset,
} from "./events-datasets";

/**
 * Recognizes Sentry-owned hosts, including single-tenant deployments.
 */
export function isSentryHost(host: string): boolean {
  return host === "sentry.io" || host.endsWith(".sentry.io");
}

/** Hosts that use the public SaaS control host and organization web subdomains. */
export function isPublicSentryHost(host: string): boolean {
  return isSentryHost(host) && !host.endsWith(".my.sentry.io");
}

export interface TraceMetricIdentifier {
  name: string;
  type: string;
  unit?: string;
}

export interface TraceMetricsExplorerUrlOptions {
  query: string;
  projectId?: string;
  statsPeriod?: string;
  start?: string;
  end?: string;
  sort?: string;
  aggregateFunctions?: string[];
  groupByFields?: string[];
  traceMetrics?: TraceMetricIdentifier[];
}

export interface ProfilesExplorerUrlOptions {
  query: string;
  projectId?: string;
  statsPeriod?: string;
  start?: string;
  end?: string;
  sort?: string;
  fields?: string[];
  aggregateFunctions?: string[];
  groupByFields?: string[];
}

export interface DashboardUrlOptions {
  projectId?: string | number | null;
  statsPeriod?: string | null;
}

function deriveSelectedFields(
  fields?: string[],
  aggregateFunctions?: string[],
  groupByFields?: string[],
): string[] {
  if (fields && fields.length > 0) {
    return fields;
  }

  return Array.from(
    new Set([...(groupByFields ?? []), ...(aggregateFunctions ?? [])]),
  );
}

function getSentryWebBaseUrl(
  host: string,
  organizationSlug: string,
  path: string,
  protocol: SentryProtocol = "https",
): string {
  const isSaas = isPublicSentryHost(host);
  const webHost = isSaas ? "sentry.io" : host;
  return isSaas
    ? `${protocol}://${organizationSlug}.${webHost}${path}`
    : `${protocol}://${host}/organizations/${organizationSlug}${path}`;
}

function normalizeTraceMetric(
  metric: TraceMetricIdentifier | null | undefined,
): TraceMetricIdentifier | null {
  if (!metric?.name || !metric.type) {
    return null;
  }

  return {
    name: metric.name,
    type: metric.type,
    unit: metric.unit && metric.unit !== "-" ? metric.unit : undefined,
  };
}

function extractTraceMetricFromAggregate(
  field: string,
): TraceMetricIdentifier | null {
  const match = field.match(/^[^(]+\((.*)\)$/);
  if (!match) {
    return null;
  }

  const args = match[1]
    .split(",")
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0);

  if (args.length < 4) {
    return null;
  }

  return normalizeTraceMetric({
    name: args[1]!,
    type: args[2]!,
    unit: args[3],
  });
}

function extractTraceMetricFromQuery(
  query: string,
): TraceMetricIdentifier | null {
  const extractValue = (field: string): string | null => {
    const quotedMatch = query.match(new RegExp(`${field}:"([^"]+)"`, "i"));
    if (quotedMatch?.[1]) {
      return quotedMatch[1];
    }

    const unquotedMatch = query.match(new RegExp(`${field}:([^\\s]+)`, "i"));
    return unquotedMatch?.[1] ?? null;
  };

  return normalizeTraceMetric({
    name: extractValue("metric\\.name") ?? "",
    type: extractValue("metric\\.type") ?? "",
    unit: extractValue("metric\\.unit") ?? undefined,
  });
}

function dedupeTraceMetrics(
  metrics: Array<TraceMetricIdentifier | null | undefined>,
): TraceMetricIdentifier[] {
  const deduped = new Map<string, TraceMetricIdentifier>();

  for (const metric of metrics) {
    const normalizedMetric = normalizeTraceMetric(metric);
    if (!normalizedMetric) {
      continue;
    }

    const key = `${normalizedMetric.name}|${normalizedMetric.type}|${normalizedMetric.unit ?? ""}`;
    deduped.set(key, normalizedMetric);
  }

  return [...deduped.values()];
}

function buildMetricQueryState(params: {
  metric: TraceMetricIdentifier;
  query: string;
  mode: "aggregate" | "samples";
  yAxes: string[];
  groupByFields?: string[];
  aggregateSortBys?: Array<{ field: string; kind: "asc" | "desc" }>;
}): string {
  return JSON.stringify({
    metric: params.metric,
    query: params.query,
    aggregateFields: [
      ...params.yAxes.map((yAxis) => ({ yAxes: [yAxis] })),
      ...(params.groupByFields ?? []).map((field) => ({ groupBy: field })),
    ],
    aggregateSortBys: params.aggregateSortBys ?? [],
    mode: params.mode,
  });
}

export function getTraceMetricsExploreUrl(
  host: string,
  organizationSlug: string,
  options: TraceMetricsExplorerUrlOptions,
  protocol: SentryProtocol = "https",
): string {
  const {
    query,
    projectId,
    statsPeriod,
    start,
    end,
    sort,
    aggregateFunctions,
    groupByFields,
    traceMetrics,
  } = options;

  const urlParams = new URLSearchParams();

  if (projectId) {
    urlParams.set("project", projectId);
  }

  if (start && end) {
    urlParams.set("start", start);
    urlParams.set("end", end);
  } else {
    urlParams.set("statsPeriod", statsPeriod || "24h");
  }

  const aggregateFields = aggregateFunctions ?? [];
  const aggregateGroupByFields = groupByFields ?? [];
  const isAggregateQuery = aggregateFields.length > 0;

  const sortField = sort?.startsWith("-") ? sort.slice(1) : sort;
  const sortKind = sort?.startsWith("-") ? ("desc" as const) : ("asc" as const);

  if (isAggregateQuery) {
    const metricQueries = new Map<
      string,
      {
        metric: TraceMetricIdentifier;
        yAxes: string[];
      }
    >();

    for (const aggregateField of aggregateFields) {
      const metric = extractTraceMetricFromAggregate(aggregateField);
      if (!metric) {
        continue;
      }

      const key = `${metric.name}|${metric.type}|${metric.unit ?? ""}`;
      const existing = metricQueries.get(key);
      if (existing) {
        existing.yAxes.push(aggregateField);
      } else {
        metricQueries.set(key, {
          metric,
          yAxes: [aggregateField],
        });
      }
    }

    for (const { metric, yAxes } of metricQueries.values()) {
      const aggregateSortBys =
        sortField &&
        (yAxes.includes(sortField) ||
          aggregateGroupByFields.includes(sortField))
          ? [{ field: sortField, kind: sortKind }]
          : [];

      urlParams.append(
        "metric",
        buildMetricQueryState({
          metric,
          query,
          mode: "aggregate",
          yAxes,
          groupByFields: aggregateGroupByFields,
          aggregateSortBys,
        }),
      );
    }
  } else {
    const sampleMetrics = dedupeTraceMetrics([
      ...(traceMetrics ?? []),
      extractTraceMetricFromQuery(query),
    ]);

    for (const metric of sampleMetrics) {
      urlParams.append(
        "metric",
        buildMetricQueryState({
          metric,
          query,
          mode: "samples",
          yAxes: ["sum(value)"],
          aggregateSortBys: [{ field: "sum(value)", kind: "desc" }],
        }),
      );
    }
  }

  return `${getSentryWebBaseUrl(host, organizationSlug, "/explore/metrics/", protocol)}?${urlParams.toString()}`;
}

export function getProfilingExplorerUrl(
  host: string,
  organizationSlug: string,
  options: ProfilesExplorerUrlOptions,
  protocol: SentryProtocol = "https",
): string {
  const {
    query,
    projectId,
    statsPeriod,
    start,
    end,
    sort,
    fields,
    aggregateFunctions,
    groupByFields,
  } = options;
  const urlParams = new URLSearchParams();

  if (query) {
    urlParams.set("query", query);
  }
  if (projectId) {
    urlParams.set("project", projectId);
  }
  if (sort) {
    urlParams.set("sort", sort);
  }

  for (const field of deriveSelectedFields(
    fields,
    aggregateFunctions,
    groupByFields,
  )) {
    urlParams.append("field", field);
  }

  if (start && end) {
    urlParams.set("start", start);
    urlParams.set("end", end);
  } else {
    urlParams.set("statsPeriod", statsPeriod || "24h");
  }

  return `${getSentryWebBaseUrl(host, organizationSlug, "/explore/profiling/", protocol)}?${urlParams.toString()}`;
}

/**
 * Generates a Sentry issue URL.
 * @param host The Sentry host (may include regional subdomain for API access)
 * @param organizationSlug Organization identifier
 * @param issueId Issue identifier (e.g., "PROJECT-123")
 * @returns The complete issue URL
 */
export function getIssueUrl(
  host: string,
  organizationSlug: string,
  issueId: string,
  protocol: SentryProtocol = "https",
): string {
  return getSentryWebBaseUrl(
    host,
    organizationSlug,
    `/issues/${issueId}`,
    protocol,
  );
}

/**
 * Generates a Sentry dashboard URL.
 * @param host The Sentry host (may include regional subdomain for API access)
 * @param organizationSlug Organization identifier
 * @param dashboardId Dashboard ID
 * @param options Optional dashboard view query parameters
 * @param protocol Protocol to use when building the web URL
 * @returns The complete dashboard URL
 */
export function getDashboardUrl(
  host: string,
  organizationSlug: string,
  dashboardId: string,
  options: DashboardUrlOptions = {},
  protocol: SentryProtocol = "https",
): string {
  const encodedDashboardId = encodeURIComponent(dashboardId);
  const params = new URLSearchParams();
  if (options.projectId !== null && options.projectId !== undefined) {
    params.set("project", String(options.projectId));
  }
  if (options.statsPeriod) {
    params.set("statsPeriod", options.statsPeriod);
  }

  const queryString = params.toString();
  return `${getSentryWebBaseUrl(
    host,
    organizationSlug,
    `/dashboard/${encodedDashboardId}/`,
    protocol,
  )}${queryString ? `?${queryString}` : ""}`;
}

/**
 * Generates a Sentry preprod snapshot URL.
 * @param host The Sentry host (may include regional subdomain for API access)
 * @param organizationSlug Organization identifier
 * @param snapshotId Preprod snapshot artifact ID
 * @returns The complete snapshot URL
 */
export function getPreprodSnapshotUrl(
  host: string,
  organizationSlug: string,
  snapshotId: string,
  protocol: SentryProtocol = "https",
): string {
  return getSentryWebBaseUrl(
    host,
    organizationSlug,
    `/preprod/snapshots/${snapshotId}/`,
    protocol,
  );
}

/**
 * Generates a Sentry cron monitor URL.
 * @param host The Sentry host (may include regional subdomain for API access)
 * @param organizationSlug Organization identifier
 * @param monitorSlug Monitor slug
 * @param projectSlug Optional project slug to disambiguate monitors with the same slug
 * @returns The complete monitor URL
 */
export function getMonitorUrl(
  host: string,
  organizationSlug: string,
  monitorSlug: string,
  protocol: SentryProtocol = "https",
  projectSlug?: string,
): string {
  const monitorPath = (projectSlug ? [projectSlug, monitorSlug] : [monitorSlug])
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return getSentryWebBaseUrl(
    host,
    organizationSlug,
    `/crons/${monitorPath}/`,
    protocol,
  );
}

/**
 * Generates a Sentry release URL.
 * @param host The Sentry host (may include regional subdomain for API access)
 * @param organizationSlug Organization identifier
 * @param releaseVersion Release version identifier
 * @returns The complete release URL
 */
/**
 * Generates a Sentry uptime monitor URL.
 *
 * Uses the monitors UI path (`/monitors/{id}/`), which is the current home for
 * uptime detectors in Sentry.
 */
export function getUptimeMonitorUrl(
  host: string,
  organizationSlug: string,
  uptimeMonitorId: string | number,
  protocol: SentryProtocol = "https",
): string {
  const encodedId = encodeURIComponent(String(uptimeMonitorId));
  return getSentryWebBaseUrl(
    host,
    organizationSlug,
    `/monitors/${encodedId}/`,
    protocol,
  );
}

export function getReleaseUrl(
  host: string,
  organizationSlug: string,
  releaseVersion: string,
  protocol: SentryProtocol = "https",
): string {
  const encodedReleaseVersion = encodeURIComponent(releaseVersion);
  return getSentryWebBaseUrl(
    host,
    organizationSlug,
    `/releases/${encodedReleaseVersion}/`,
    protocol,
  );
}

/**
 * Generates a Sentry issues search URL.
 * @param host The Sentry host (may include regional subdomain for API access)
 * @param organizationSlug Organization identifier
 * @param query Optional search query
 * @param projectSlugOrId Optional project slug or ID
 * @returns The complete issues search URL
 */
export function getIssuesSearchUrl(
  host: string,
  organizationSlug: string,
  query?: string | null,
  projectSlugOrId?: string,
  protocol: SentryProtocol = "https",
): string {
  let url = getSentryWebBaseUrl(host, organizationSlug, "/issues/", protocol);

  const params = new URLSearchParams();
  if (projectSlugOrId) {
    params.append("project", projectSlugOrId);
  }
  if (query) {
    params.append("query", query);
  }

  const queryString = params.toString();
  if (queryString) {
    url += `?${queryString}`;
  }

  return url;
}

/**
 * Generates a Sentry replay search URL.
 * @param host The Sentry host (may include regional subdomain for API access)
 * @param organizationSlug Organization identifier
 * @param options Replay search options
 * @returns The complete replay search URL
 */
export function getReplaysSearchUrl(
  host: string,
  organizationSlug: string,
  options: {
    query?: string | null;
    projectSlugOrId?: string;
    environment?: string | string[] | null;
    sort?: string | null;
    statsPeriod?: string | null;
    start?: string | null;
    end?: string | null;
  } = {},
  protocol: SentryProtocol = "https",
): string {
  const { query, projectSlugOrId, environment, sort, statsPeriod, start, end } =
    options;

  let url = getSentryWebBaseUrl(
    host,
    organizationSlug,
    "/explore/replays/",
    protocol,
  );
  const params = new URLSearchParams();

  if (projectSlugOrId) {
    params.append("project", projectSlugOrId);
  }
  if (query) {
    params.append("query", query);
  }
  if (environment) {
    const environments = Array.isArray(environment)
      ? environment
      : [environment];
    for (const value of environments) {
      params.append("environment", value);
    }
  }
  if (sort) {
    params.append("sort", sort);
  }
  if (start && end) {
    params.append("start", start);
    params.append("end", end);
  } else if (statsPeriod) {
    params.append("statsPeriod", statsPeriod);
  }

  const queryString = params.toString();
  if (queryString) {
    url += `?${queryString}`;
  }

  return url;
}

/**
 * Generates a Sentry trace URL for performance investigation.
 * @param host The Sentry host (may include regional subdomain for API access)
 * @param organizationSlug Organization identifier
 * @param traceId Trace identifier
 * @returns The complete trace URL
 */
export function getTraceUrl(
  host: string,
  organizationSlug: string,
  traceId: string,
  protocol: SentryProtocol = "https",
): string {
  return getSentryWebBaseUrl(
    host,
    organizationSlug,
    `/explore/traces/trace/${traceId}`,
    protocol,
  );
}

/**
 * Generates a Sentry replay URL.
 * @param host The Sentry host (may include regional subdomain for API access)
 * @param organizationSlug Organization identifier
 * @param replayId Replay identifier
 * @returns The complete replay URL
 */
export function getReplayUrl(
  host: string,
  organizationSlug: string,
  replayId: string,
  protocol: SentryProtocol = "https",
): string {
  return getSentryWebBaseUrl(
    host,
    organizationSlug,
    `/explore/replays/${replayId}/`,
    protocol,
  );
}

/**
 * Generates a Sentry AI conversation URL.
 * @param host The Sentry host
 * @param organizationSlug Organization identifier
 * @param conversationId AI conversation identifier
 * @returns The complete AI conversation URL
 */
export function getAIConversationUrl(
  host: string,
  organizationSlug: string,
  conversationId: string,
  protocol: SentryProtocol = "https",
): string {
  return getSentryWebBaseUrl(
    host,
    organizationSlug,
    `/explore/conversations/${encodeURIComponent(conversationId)}/`,
    protocol,
  );
}

/**
 * Extract a single non-negated AI conversation ID from a Sentry search query
 * that filters on `gen_ai.conversation.id`. Returns undefined when the query
 * does not contain exactly one such filter or contains a negated filter.
 */
export function extractConversationIdFromSearchQuery(
  query: string | undefined | null,
): string | undefined {
  if (!query) {
    return undefined;
  }

  if (
    /!gen_ai\.conversation\.id:|\bNOT\s+(?:\(\s*)?gen_ai\.conversation\.id:/i.test(
      query,
    )
  ) {
    return undefined;
  }

  const pattern = /gen_ai\.conversation\.id:(?:"([^"]+)"|([^\s)]+))/g;
  const matches = [...query.matchAll(pattern)];
  if (matches.length !== 1) {
    return undefined;
  }

  const conversationId = matches[0][1] ?? matches[0][2];
  if (conversationId.startsWith("[")) {
    return undefined;
  }

  return conversationId;
}

/**
 * Generates a Sentry AI conversations list URL with optional search filters.
 */
export function getAIConversationsUrl(
  host: string,
  organizationSlug: string,
  options: {
    query?: string;
    project?: string[];
    environment?: string | string[];
    statsPeriod?: string;
    start?: string;
    end?: string;
  } = {},
  protocol: SentryProtocol = "https",
): string {
  const urlParams = new URLSearchParams();

  if (options.query) {
    urlParams.set("query", options.query);
  }
  for (const projectId of options.project ?? []) {
    urlParams.append("project", projectId);
  }
  const environments = Array.isArray(options.environment)
    ? options.environment
    : options.environment
      ? [options.environment]
      : [];
  for (const environmentName of environments) {
    urlParams.append("environment", environmentName);
  }
  if (options.start && options.end) {
    urlParams.set("start", options.start);
    urlParams.set("end", options.end);
  } else if (options.statsPeriod) {
    urlParams.set("statsPeriod", options.statsPeriod);
  }
  const baseUrl = getSentryWebBaseUrl(
    host,
    organizationSlug,
    "/explore/conversations/",
    protocol,
  );
  const queryString = urlParams.toString();
  return queryString ? `${baseUrl}?${queryString}` : baseUrl;
}

export function getProfileUrl(
  host: string,
  organizationSlug: string,
  projectSlug: string,
  profileId: string,
  protocol: SentryProtocol = "https",
): string {
  return getSentryWebBaseUrl(
    host,
    organizationSlug,
    `/explore/profiling/profile/${projectSlug}/${profileId}/flamegraph/`,
    protocol,
  );
}

export function getContinuousProfileUrl(
  host: string,
  organizationSlug: string,
  projectSlug: string,
  options: {
    profilerId: string;
    start: string;
    end: string;
  },
  protocol: SentryProtocol = "https",
): string {
  const url = new URL(
    getSentryWebBaseUrl(
      host,
      organizationSlug,
      `/explore/profiling/profile/${projectSlug}/flamegraph/`,
      protocol,
    ),
  );
  url.searchParams.set("profilerId", options.profilerId);
  url.searchParams.set("start", options.start);
  url.searchParams.set("end", options.end);
  return url.toString();
}

/**
 * Generates a Sentry events explorer URL.
 * @param host The Sentry host (may include regional subdomain for API access)
 * @param organizationSlug Organization identifier
 * @param query Search query
 * @param dataset Dataset type
 * @param projectSlug Optional project slug
 * @param fields Optional fields to display
 * @returns The complete events explorer URL
 */
export function getEventsExplorerUrl(
  host: string,
  organizationSlug: string,
  query: string,
  dataset: EventsDataset = "spans",
  projectSlugOrId?: string,
  fields?: string[],
  explorerOptions?: Omit<TraceMetricsExplorerUrlOptions, "query" | "projectId">,
  protocol: SentryProtocol = "https",
): string {
  if (isMetricsDataset(dataset)) {
    const derivedAggregateFunctions =
      explorerOptions?.aggregateFunctions ??
      fields?.filter((field) => field.includes("(") && field.includes(")"));
    const derivedGroupByFields =
      explorerOptions?.groupByFields ??
      fields?.filter((field) => !field.includes("(") && !field.includes(")"));

    return getTraceMetricsExploreUrl(
      host,
      organizationSlug,
      {
        ...explorerOptions,
        query,
        projectId: projectSlugOrId,
        aggregateFunctions: derivedAggregateFunctions,
        groupByFields: derivedGroupByFields,
      },
      protocol,
    );
  }

  if (isProfilesDataset(dataset)) {
    const derivedAggregateFunctions =
      explorerOptions?.aggregateFunctions ??
      fields?.filter((field) => field.includes("(") && field.includes(")"));
    const derivedGroupByFields =
      explorerOptions?.groupByFields ??
      fields?.filter((field) => !field.includes("(") && !field.includes(")"));

    return getProfilingExplorerUrl(
      host,
      organizationSlug,
      {
        query,
        projectId: projectSlugOrId,
        fields,
        sort: explorerOptions?.sort,
        statsPeriod: explorerOptions?.statsPeriod,
        start: explorerOptions?.start,
        end: explorerOptions?.end,
        aggregateFunctions: derivedAggregateFunctions,
        groupByFields: derivedGroupByFields,
      },
      protocol,
    );
  }

  let url = getSentryWebBaseUrl(host, organizationSlug, "/explore/", protocol);

  const params = new URLSearchParams();
  params.append("query", query);
  params.append("dataset", dataset);
  params.append("layout", "table");

  if (projectSlugOrId) {
    params.append("project", projectSlugOrId);
  }

  if (fields && fields.length > 0) {
    for (const field of fields) {
      params.append("field", field);
    }
  }

  url += `?${params.toString()}`;
  return url;
}

/**
 * Internal validation function that checks if a SENTRY_HOST value contains only hostname (no protocol).
 * Throws an error if validation fails instead of exiting the process.
 *
 * @param host The hostname to validate
 * @throws {Error} If the host contains a protocol
 */
function _validateSentryHostInternal(host: string): void {
  if (host.startsWith("http://") || host.startsWith("https://")) {
    throw new Error(
      "SENTRY_HOST should only contain a hostname (e.g., sentry.example.com). Use SENTRY_URL if you want to provide a full URL.",
    );
  }
}

/**
 * Internal validation function that checks if a SENTRY_URL value is a valid HTTPS URL and extracts the hostname.
 * Throws an error if validation fails instead of exiting the process.
 *
 * @param url The HTTPS URL to validate and parse
 * @returns The extracted hostname from the URL
 * @throws {Error} If the URL is invalid or not HTTPS
 */
function _validateAndParseSentryUrlInternal(url: string): string {
  if (!url.startsWith("https://")) {
    throw new Error(
      "SENTRY_URL must be a full HTTPS URL (e.g., https://sentry.example.com).",
    );
  }

  try {
    const parsedUrl = new URL(url);
    return parsedUrl.host;
  } catch (error) {
    throw new Error(
      "SENTRY_URL must be a valid HTTPS URL (e.g., https://sentry.example.com).",
    );
  }
}

/**
 * Validates that a SENTRY_HOST value contains only hostname (no protocol).
 * Exits the process with error code 1 if validation fails (CLI behavior).
 *
 * @param host The hostname to validate
 */
export function validateSentryHost(host: string): void {
  try {
    _validateSentryHostInternal(host);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * Validates that a SENTRY_URL value is a valid HTTPS URL and extracts the hostname.
 * Exits the process with error code 1 if validation fails (CLI behavior).
 *
 * @param url The HTTPS URL to validate and parse
 * @returns The extracted hostname from the URL
 */
export function validateAndParseSentryUrl(url: string): string {
  try {
    return _validateAndParseSentryUrlInternal(url);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * Validates that a SENTRY_HOST value contains only hostname (no protocol).
 * Throws an error instead of exiting the process (for testing).
 *
 * @param host The hostname to validate
 * @throws {Error} If the host contains a protocol
 */
export function validateSentryHostThrows(host: string): void {
  _validateSentryHostInternal(host);
}

/**
 * Validates that a SENTRY_URL value is a valid HTTPS URL and extracts the hostname.
 * Throws an error instead of exiting the process (for testing).
 *
 * @param url The HTTPS URL to validate and parse
 * @returns The extracted hostname from the URL
 * @throws {Error} If the URL is invalid or not HTTPS
 */
export function validateAndParseSentryUrlThrows(url: string): string {
  return _validateAndParseSentryUrlInternal(url);
}

/**
 * Validates that the provided OpenAI base URL is a valid HTTP(S) URL and returns a normalized string.
 *
 * @param url The URL to validate and normalize
 * @returns The normalized URL string
 * @throws {Error} If the URL is empty, invalid, or uses an unsupported protocol
 */
export function validateOpenAiBaseUrlThrows(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    throw new Error("OPENAI base URL must not be empty.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (error) {
    throw new Error(
      "OPENAI base URL must be a valid HTTP or HTTPS URL (e.g., https://example.com/v1).",
      { cause: error },
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      "OPENAI base URL must use http or https scheme (e.g., https://example.com/v1).",
    );
  }

  // Preserve the exact path to support Azure or proxy endpoints that include version/path segments
  return parsed.toString();
}
