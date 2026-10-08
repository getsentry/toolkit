import type { SentryApiService } from "../../../api-client";
import type {
  EventsTimeSeriesResponse,
  IngestionMeta,
} from "../../../api-client/schema";
import { formatToolCallInstruction } from "../../../internal/tool-helpers/tool-call-formatting";
import { formatUserGeoSummary } from "../../../internal/user-formatting";
import { logInfo } from "../../../telem/logging";
import { formatDuration } from "../profile/analyzer";
import {
  type FlexibleEventData,
  formatEventValue,
  formatKnownUserValue,
  getStringValue,
  isAggregateQuery,
} from "./utils";

/**
 * Format an explanation for how the input query was translated
 */
export function formatExplanation(explanation: string): string {
  return `## How I interpreted your query\n\n${explanation}`;
}

interface SearchTimeRange {
  statsPeriod?: string;
  start?: string;
  end?: string;
}

export interface ExecutedSearch {
  dataset: string;
  query: string;
  fields?: string[];
  sort?: string;
  timeRange?: SearchTimeRange;
}

function formatInlineCode(value: string): string {
  const backtickRuns = value.match(/`+/g) ?? [];
  const fenceLength =
    backtickRuns.reduce((max, run) => Math.max(max, run.length), 0) + 1;
  const fence = "`".repeat(fenceLength);
  const needsPadding = value.startsWith("`") || value.endsWith("`");
  return needsPadding
    ? `${fence} ${value} ${fence}`
    : `${fence}${value}${fence}`;
}

function formatExecutedTimeRange(timeRange?: SearchTimeRange): string {
  if (!timeRange) {
    return "Last 14d";
  }
  if (timeRange.statsPeriod) {
    return `Last ${timeRange.statsPeriod}`;
  }
  if (timeRange.start && timeRange.end) {
    return `${timeRange.start} to ${timeRange.end}`;
  }
  return "Last 14d";
}

export function formatExecutedSearch(executedSearch?: ExecutedSearch): string {
  if (!executedSearch) {
    return "";
  }

  const fields =
    executedSearch.fields === undefined
      ? undefined
      : executedSearch.fields.length > 0
        ? executedSearch.fields.map(formatInlineCode).join(", ")
        : "(none)";

  const lines = [
    "## Executed Search",
    `- Dataset: ${formatInlineCode(executedSearch.dataset)}`,
    `- Query: ${formatInlineCode(executedSearch.query || "(empty)")}`,
  ];

  if (fields !== undefined) {
    lines.push(`- Fields: ${fields}`);
  }
  if (executedSearch.sort) {
    lines.push(`- Sort: ${formatInlineCode(executedSearch.sort)}`);
  }
  lines.push(
    `- Time range: ${formatExecutedTimeRange(executedSearch.timeRange)}`,
  );

  return `${lines.join("\n")}\n\n`;
}

export function formatSearchPresentationHint(hint: string): string {
  return `**Suggested presentation:** ${hint}\n\n`;
}

export function formatSentryDashboardLink(url: string): string {
  return `**View these results in Sentry**:\n${url}\nPlease tell the user this dashboard link is available if they want to open the results in Sentry.\n\n`;
}

/**
 * Common parameters for event formatters
 */
export interface FormatEventResultsParams {
  eventData: FlexibleEventData[];
  inputQuery: string;
  includeExplanation?: boolean;
  apiService: SentryApiService;
  organizationSlug: string;
  explorerUrl: string;
  sentryQuery: string;
  fields: string[];
  explanation?: string;
  executedSearch?: ExecutedSearch;
  experimentalMode?: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
}

function formatUserFieldLines(
  value: Record<string, unknown>,
  options: { prefix?: string } = {},
): string[] {
  const prefix = options.prefix ?? "";
  const geoSummary = formatUserGeoSummary(value.geo);
  const userSummary = formatKnownUserValue(value, { includeGeo: false });
  const lines: string[] = [];

  if (userSummary) {
    lines.push(`${prefix}**user**: ${userSummary}`);
  } else if (!geoSummary) {
    lines.push(`${prefix}**user**: ${formatEventValue(value)}`);
  }

  if (geoSummary) {
    lines.push(`${prefix}**user.geo**: ${geoSummary}`);
  }

  return lines;
}

/**
 * Format error event results for display
 */
export function formatErrorResults(params: FormatEventResultsParams): string {
  const {
    eventData,
    inputQuery,
    includeExplanation,
    apiService,
    organizationSlug,
    explorerUrl,
    sentryQuery,
    fields,
    explanation,
  } = params;

  let output = `# Search Results for "${inputQuery}"\n\n`;

  // Check if this is an aggregate query and adjust display instructions
  if (isAggregateQuery(fields)) {
    output += formatSearchPresentationHint(
      "A compact table works well for these aggregate results.",
    );
  } else {
    output += formatSearchPresentationHint(
      "Useful details to surface include severity, event IDs, and links.",
    );
  }

  if (includeExplanation && explanation) {
    output += formatExplanation(explanation);
    output += `\n\n`;
  }

  output += formatExecutedSearch(params.executedSearch);

  output += formatSentryDashboardLink(explorerUrl);

  if (eventData.length === 0) {
    logInfo(`No error events found for query: ${inputQuery}`, {
      extra: {
        query: sentryQuery,
        fields: fields,
        organizationSlug: organizationSlug,
        dataset: "errors",
      },
    });
    output += `No results found.\n\n`;
    output += `Try being more specific or using different terms in your search.\n`;
    return output;
  }

  output += `Found ${eventData.length} ${isAggregateQuery(fields) ? "aggregate result" : "error"}${eventData.length === 1 ? "" : "s"}:\n\n`;

  // For aggregate queries, just output the raw data - the agent will format it as a table
  if (isAggregateQuery(fields)) {
    output += "```json\n";
    output += JSON.stringify(eventData, null, 2);
    output += "\n```\n\n";
  } else {
    // For individual errors, format with details
    // Define priority fields that should appear first if present
    const priorityFields = [
      "title",
      "issue",
      "project",
      "level",
      "error.type",
      "message",
      "culprit",
      "timestamp",
      "last_seen()", // Aggregate field - when the issue was last seen
      "count()", // Aggregate field - total occurrences of this issue
    ];

    for (const event of eventData) {
      // Try to get a title from various possible fields
      const title =
        getStringValue(event, "title") ||
        getStringValue(event, "message") ||
        getStringValue(event, "error.value") ||
        "Error Event";

      output += `## ${title}\n\n`;

      // Display priority fields first if they exist
      for (const field of priorityFields) {
        if (
          field in event &&
          event[field] !== null &&
          event[field] !== undefined
        ) {
          const value = event[field];

          if (field === "issue" && typeof value === "string") {
            output += `**Issue ID**: ${value}\n`;
            output += `**Issue URL**: ${apiService.getIssueUrl(organizationSlug, value)}\n`;
          } else if (field === "issue") {
            output += `**Issue ID**: ${formatEventValue(value)}\n`;
          } else {
            output += `**${field}**: ${formatEventValue(value)}\n`;
          }
        }
      }

      // Display any additional fields that weren't in the priority list
      const displayedFields = new Set([...priorityFields, "id"]);
      for (const [key, value] of Object.entries(event)) {
        if (
          !displayedFields.has(key) &&
          value !== null &&
          value !== undefined
        ) {
          if (key === "user" && typeof value === "object" && value !== null) {
            for (const line of formatUserFieldLines(
              value as Record<string, unknown>,
            )) {
              output += `${line}\n`;
            }
            continue;
          }

          output += `**${key}**: ${formatEventValue(value)}\n`;
        }
      }

      output += "\n";
    }
  }

  output += "## Next Steps\n\n";
  output += "- Get more details about a specific error: Use the Issue ID\n";
  output += "- View error groups: Navigate to the Issues page in Sentry\n";
  output += "- Set up alerts: Configure alert rules for these error patterns\n";

  return output;
}

/**
 * Format log event results for display
 */
export function formatLogResults(params: FormatEventResultsParams): string {
  const {
    eventData,
    inputQuery,
    includeExplanation,
    apiService,
    organizationSlug,
    explorerUrl,
    sentryQuery,
    fields,
    explanation,
  } = params;

  let output = `# Search Results for "${inputQuery}"\n\n`;

  // Check if this is an aggregate query and adjust display instructions
  if (isAggregateQuery(fields)) {
    output += formatSearchPresentationHint(
      "A compact table works well for these aggregate results.",
    );
  } else {
    output += formatSearchPresentationHint(
      "Console-style formatting works well for these logs, with timestamps preserved.",
    );
  }

  if (includeExplanation && explanation) {
    output += formatExplanation(explanation);
    output += `\n\n`;
  }

  output += formatExecutedSearch(params.executedSearch);

  output += formatSentryDashboardLink(explorerUrl);

  if (eventData.length === 0) {
    logInfo(`No log events found for query: ${inputQuery}`, {
      extra: {
        query: sentryQuery,
        fields: fields,
        organizationSlug: organizationSlug,
        dataset: "logs",
      },
    });
    output += `No results found.\n\n`;
    output += `Try being more specific or using different terms in your search.\n`;
    return output;
  }

  output += `Found ${eventData.length} ${isAggregateQuery(fields) ? "aggregate result" : "log"}${eventData.length === 1 ? "" : "s"}:\n\n`;

  // For aggregate queries, just output the raw data - the agent will format it as a table
  if (isAggregateQuery(fields)) {
    output += "```json\n";
    output += JSON.stringify(eventData, null, 2);
    output += "\n```\n\n";
  } else {
    // For individual logs, format as console output
    output += "```console\n";

    for (const event of eventData) {
      const timestamp = getStringValue(event, "timestamp", "N/A");
      const severity = getStringValue(event, "severity", "info");
      const message = getStringValue(event, "message", "No message");

      // Safely uppercase the severity
      const severityUpper = severity.toUpperCase();

      // Get severity emoji with proper typing
      const severityEmojis: Record<string, string> = {
        ERROR: "🔴",
        FATAL: "🔴",
        WARN: "🟡",
        WARNING: "🟡",
        INFO: "🔵",
        DEBUG: "⚫",
        TRACE: "⚫",
      };
      const severityEmoji = severityEmojis[severityUpper] || "🔵";

      // Standard log format with emoji and proper spacing
      output += `${timestamp} ${severityEmoji} [${severityUpper.padEnd(5)}] ${message}\n`;
    }

    output += "```\n\n";

    // Add detailed metadata for each log entry
    output += "## Log Details\n\n";

    // Define priority fields that should appear first if present
    const priorityFields = [
      "message",
      "severity",
      "severity_number",
      "timestamp",
      "project",
      "trace",
      "sentry.item_id",
    ];

    for (let i = 0; i < eventData.length; i++) {
      const event = eventData[i];

      output += `### Log ${i + 1}\n`;

      // Display priority fields first
      for (const field of priorityFields) {
        if (
          field in event &&
          event[field] !== null &&
          event[field] !== undefined
        ) {
          const value = event[field];

          if (field === "trace" && typeof value === "string") {
            output += `- **Trace ID**: ${value}\n`;
            output += `- **Trace URL**: ${apiService.getTraceUrl(organizationSlug, value)}\n`;
          } else {
            output += `- **${field}**: ${formatEventValue(value)}\n`;
          }
        }
      }

      // Display any additional fields
      const displayedFields = new Set([...priorityFields, "id"]);
      for (const [key, value] of Object.entries(event)) {
        if (
          !displayedFields.has(key) &&
          value !== null &&
          value !== undefined
        ) {
          if (key === "user" && typeof value === "object" && value !== null) {
            for (const line of formatUserFieldLines(
              value as Record<string, unknown>,
              { prefix: "- " },
            )) {
              output += `${line}\n`;
            }
            continue;
          }

          output += `- **${key}**: ${formatEventValue(value)}\n`;
        }
      }

      output += "\n";
    }
  }

  output += "## Next Steps\n\n";
  output += "- View related traces: Click on the Trace URL if available\n";
  output +=
    "- Filter by severity: Adjust your query to focus on specific log levels\n";
  output += "- Export logs: Use the Sentry web interface for bulk export\n";

  return output;
}

/**
 * Format span/trace event results for display
 */
export function formatSpanResults(params: FormatEventResultsParams): string {
  const {
    eventData,
    inputQuery,
    includeExplanation,
    apiService,
    organizationSlug,
    explorerUrl,
    sentryQuery,
    fields,
    explanation,
  } = params;

  let output = `# Search Results for "${inputQuery}"\n\n`;

  // Check if this is an aggregate query and adjust display instructions
  if (isAggregateQuery(fields)) {
    output += formatSearchPresentationHint(
      "A compact table works well for these aggregate results.",
    );
  } else {
    output += formatSearchPresentationHint(
      "A timeline works well for these traces, with durations and parent-child span relationships visible.",
    );
  }

  if (includeExplanation && explanation) {
    output += formatExplanation(explanation);
    output += `\n\n`;
  }

  output += formatExecutedSearch(params.executedSearch);

  output += formatSentryDashboardLink(explorerUrl);

  if (eventData.length === 0) {
    logInfo(`No span events found for query: ${inputQuery}`, {
      extra: {
        query: sentryQuery,
        fields: fields,
        organizationSlug: organizationSlug,
        dataset: "spans",
      },
    });
    output += `No results found.\n\n`;
    output += `Try being more specific or using different terms in your search.\n`;
    return output;
  }

  output += `Found ${eventData.length} ${isAggregateQuery(fields) ? `aggregate result${eventData.length === 1 ? "" : "s"}` : `trace${eventData.length === 1 ? "" : "s"}/span${eventData.length === 1 ? "" : "s"}`}:\n\n`;

  // For aggregate queries, just output the raw data - the agent will format it as a table
  if (isAggregateQuery(fields)) {
    output += "```json\n";
    output += JSON.stringify(eventData, null, 2);
    output += "\n```\n\n";
  } else {
    // For individual spans, format with details
    // Define priority fields that should appear first if present
    const priorityFields = [
      "id",
      "span.op",
      "span.description",
      "transaction",
      "span.duration",
      "span.status",
      "trace",
      "project",
      "timestamp",
    ];

    for (const event of eventData) {
      // Try to get a title from various possible fields
      const title =
        getStringValue(event, "span.description") ||
        getStringValue(event, "transaction") ||
        getStringValue(event, "span.op") ||
        "Span";

      output += `## ${title}\n\n`;

      // Display priority fields first
      for (const field of priorityFields) {
        if (
          field in event &&
          event[field] !== null &&
          event[field] !== undefined
        ) {
          const value = event[field];

          if (field === "trace" && typeof value === "string") {
            output += `**Trace ID**: ${value}\n`;
            output += `**Trace URL**: ${apiService.getTraceUrl(organizationSlug, value)}\n`;
          } else if (field === "span.duration" && typeof value === "number") {
            output += `**${field}**: ${value}ms\n`;
          } else {
            output += `**${field}**: ${formatEventValue(value)}\n`;
          }
        }
      }

      // Display any additional fields
      const displayedFields = new Set([...priorityFields, "id"]);
      for (const [key, value] of Object.entries(event)) {
        if (
          !displayedFields.has(key) &&
          value !== null &&
          value !== undefined
        ) {
          if (key === "user" && typeof value === "object" && value !== null) {
            for (const line of formatUserFieldLines(
              value as Record<string, unknown>,
            )) {
              output += `${line}\n`;
            }
            continue;
          }

          output += `**${key}**: ${formatEventValue(value)}\n`;
        }
      }

      output += "\n";
    }
  }

  output += "## Next Steps\n\n";
  output += "- View the full trace: Click on the Trace URL above\n";
  output +=
    "- Search for related spans: Modify your query to be more specific\n";
  output +=
    "- Export data: Use the Sentry web interface for advanced analysis\n";

  return output;
}

function getProfileDurationLabel(
  field: string,
  value: unknown,
): string | undefined {
  if (
    (field === "transaction.duration" || field === "profile.duration") &&
    typeof value === "number"
  ) {
    return formatDuration(value);
  }

  return undefined;
}

function getProfileProject(event: FlexibleEventData): string | null {
  return getStringValue(event, "project") || null;
}

function getProfileTimestampValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmedValue = value.trim();
    return trimmedValue.length > 0 ? trimmedValue : null;
  }

  return null;
}

function getProfileDetailUrl(
  apiService: SentryApiService,
  organizationSlug: string,
  event: FlexibleEventData,
): string | null {
  const project = getProfileProject(event);
  if (!project) {
    return null;
  }

  const profileId = getStringValue(event, "profile.id");
  if (profileId) {
    return apiService.getProfileUrl(organizationSlug, project, profileId);
  }

  const profilerId = getStringValue(event, "profiler.id");
  const start = getProfileTimestampValue(event["precise.start_ts"]);
  const end = getProfileTimestampValue(event["precise.finish_ts"]);
  if (profilerId && start && end) {
    return apiService.getContinuousProfileUrl(organizationSlug, project, {
      profilerId,
      start,
      end,
    });
  }

  return null;
}

export function formatProfileResults(params: FormatEventResultsParams): string {
  const {
    eventData,
    inputQuery,
    includeExplanation,
    apiService,
    organizationSlug,
    explorerUrl,
    sentryQuery,
    fields,
    explanation,
  } = params;

  let output = `# Search Results for "${inputQuery}"\n\n`;

  if (isAggregateQuery(fields)) {
    output += formatSearchPresentationHint(
      "A compact table with readable duration units works well for these profile aggregates.",
    );
  } else {
    output += formatSearchPresentationHint(
      "Concise summaries work well for these profiles, highlighting profile ID, transaction, duration, release, and trace context.",
    );
  }

  if (includeExplanation && explanation) {
    output += formatExplanation(explanation);
    output += `\n\n`;
  }

  output += formatExecutedSearch(params.executedSearch);

  output += formatSentryDashboardLink(explorerUrl);

  if (eventData.length === 0) {
    logInfo(`No profile events found for query: ${inputQuery}`, {
      extra: {
        query: sentryQuery,
        fields,
        organizationSlug,
        dataset: "profiles",
      },
    });
    output += "No results found.\n\n";
    output +=
      "Try narrowing the transaction, release, platform, or profile filters.\n";
    return output;
  }

  output += `Found ${eventData.length} ${isAggregateQuery(fields) ? `aggregate result${eventData.length === 1 ? "" : "s"}` : `profile${eventData.length === 1 ? "" : "s"}`}:\n\n`;

  if (isAggregateQuery(fields)) {
    output += "```json\n";
    output += JSON.stringify(eventData, null, 2);
    output += "\n```\n\n";
  } else {
    const priorityFields = [
      "profile.id",
      "profiler.id",
      "thread.id",
      "transaction",
      "timestamp",
      "transaction.duration",
      "release",
      "environment",
      "project",
      "trace",
      "precise.start_ts",
      "precise.finish_ts",
    ];

    for (const event of eventData) {
      const title =
        getStringValue(event, "transaction") ||
        getStringValue(event, "profile.id") ||
        getStringValue(event, "profiler.id") ||
        "Profile";
      const detailUrl = getProfileDetailUrl(
        apiService,
        organizationSlug,
        event,
      );

      output += `## ${title}\n\n`;

      if (detailUrl) {
        output += `**Profile URL**: ${detailUrl}\n`;
      }

      for (const field of priorityFields) {
        if (
          field in event &&
          event[field] !== null &&
          event[field] !== undefined
        ) {
          const value = event[field];
          const durationLabel = getProfileDurationLabel(field, value);

          if (field === "trace" && typeof value === "string") {
            output += `**Trace ID**: ${value}\n`;
            output += `**Trace URL**: ${apiService.getTraceUrl(organizationSlug, value)}\n`;
          } else if (durationLabel) {
            output += `**${field}**: ${durationLabel}\n`;
          } else {
            output += `**${field}**: ${formatEventValue(value)}\n`;
          }
        }
      }

      const displayedFields = new Set([...priorityFields, "id"]);
      for (const [key, value] of Object.entries(event)) {
        if (
          !displayedFields.has(key) &&
          value !== null &&
          value !== undefined
        ) {
          if (key === "user" && typeof value === "object" && value !== null) {
            for (const line of formatUserFieldLines(
              value as Record<string, unknown>,
            )) {
              output += `${line}\n`;
            }
            continue;
          }

          output += `**${key}**: ${formatEventValue(value)}\n`;
        }
      }

      output += "\n";
    }
  }

  output += "## Next Steps\n\n";
  if (params.experimentalMode === true) {
    output +=
      "- Open a Profile URL above when available, or use `get_sentry_resource` with the profile URL for the full detail view\n";
  } else {
    const profileDetailsInstruction = formatToolCallInstruction({
      toolName: "get_profile_details",
      arguments: {
        organizationSlug,
        projectSlugOrId: "<project>",
        profileId: "<profile_id>",
      },
      experimentalMode: false,
      availableToolNames: params.availableToolNames,
      directToolNames: params.directToolNames,
      fallbackInstruction:
        "Profile detail lookup is not available in this session",
      purpose: "for the full detail view",
    });
    output += `- Open a Profile URL above when available. ${profileDetailsInstruction}\n`;
  }
  output +=
    "- Open the Trace URL for an end-to-end view of the profiled request when available\n";
  output +=
    "- Refine the profiling search in Sentry by transaction, release, platform, or environment\n";

  return output;
}

/**
 * Format trace metric results for display
 */
export function formatTraceMetricsResults(
  params: FormatEventResultsParams,
): string {
  const {
    eventData,
    inputQuery,
    includeExplanation,
    apiService,
    organizationSlug,
    explorerUrl,
    sentryQuery,
    fields,
    explanation,
  } = params;

  let output = `# Search Results for "${inputQuery}"\n\n`;

  if (isAggregateQuery(fields)) {
    output += formatSearchPresentationHint(
      "A compact table with grouping labels and units works well for these metric aggregates.",
    );
  } else {
    output += formatSearchPresentationHint(
      "Concise summaries work well for these metric samples, highlighting metric name, type, value, and trace context.",
    );
  }

  if (includeExplanation && explanation) {
    output += formatExplanation(explanation);
    output += `\n\n`;
  }

  output += formatExecutedSearch(params.executedSearch);

  output += formatSentryDashboardLink(explorerUrl);

  if (eventData.length === 0) {
    logInfo(`No trace metric events found for query: ${inputQuery}`, {
      extra: {
        query: sentryQuery,
        fields,
        organizationSlug,
        dataset: "tracemetrics",
      },
    });
    output += "No results found.\n\n";
    output +=
      "Try being more specific about the metric name, type, or filters.\n";
    return output;
  }

  output += `Found ${eventData.length} ${isAggregateQuery(fields) ? `aggregate result${eventData.length === 1 ? "" : "s"}` : `metric sample${eventData.length === 1 ? "" : "s"}`}:\n\n`;

  if (isAggregateQuery(fields)) {
    output += "```json\n";
    output += JSON.stringify(eventData, null, 2);
    output += "\n```\n\n";
  } else {
    const priorityFields = [
      "metric.name",
      "metric.type",
      "metric.unit",
      "value",
      "project",
      "timestamp",
      "trace",
      "span_id",
    ];

    for (const event of eventData) {
      const title =
        getStringValue(event, "metric.name") ||
        getStringValue(event, "trace") ||
        "Metric Sample";

      output += `## ${title}\n\n`;

      for (const field of priorityFields) {
        if (
          field in event &&
          event[field] !== null &&
          event[field] !== undefined
        ) {
          const value = event[field];

          if (field === "trace" && typeof value === "string") {
            output += `**Trace ID**: ${value}\n`;
            output += `**Trace URL**: ${apiService.getTraceUrl(organizationSlug, value)}\n`;
          } else {
            output += `**${field}**: ${formatEventValue(value)}\n`;
          }
        }
      }

      const displayedFields = new Set([...priorityFields, "id"]);
      for (const [key, value] of Object.entries(event)) {
        if (
          !displayedFields.has(key) &&
          value !== null &&
          value !== undefined
        ) {
          if (key === "user" && typeof value === "object" && value !== null) {
            for (const line of formatUserFieldLines(
              value as Record<string, unknown>,
            )) {
              output += `${line}\n`;
            }
            continue;
          }

          output += `**${key}**: ${formatEventValue(value)}\n`;
        }
      }

      output += "\n";
    }
  }

  output += "## Next Steps\n\n";
  output +=
    "- Open the Metrics page link above to refine the selected metric\n";
  output +=
    "- Drill into a specific sample by opening its Trace URL or using `get_sentry_resource` with that trace ID\n";
  output +=
    "- Metrics do not expose a standalone detail resource here; use the related trace for deeper inspection\n";
  output +=
    "- Group by additional attributes to break down the metric further\n";
  output +=
    "- Switch between samples and aggregates in Sentry for deeper analysis\n";

  return output;
}

/**
 * Whether summing per-bucket values yields a meaningful series total.
 * Only `count()` and `sum(...)` are additive across time buckets;
 * `count_unique`, `avg`, percentiles, min/max, rates, etc. are not.
 */
function isAdditiveAggregate(yAxis: string): boolean {
  const fn = yAxis.trim().toLowerCase();
  return fn === "count()" || fn.startsWith("sum(");
}

function formatBucketTime(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * One line describing the measured ingestion delay, so the caller knows how
 * far behind the data is before reading a trailing dip as a real drop.
 */
function formatIngestionStatus(ingestion: IngestionMeta): string {
  const parts: string[] = [];
  if (ingestion.delaySeconds !== undefined) {
    const seconds = Math.round(ingestion.delaySeconds);
    const delay =
      seconds >= 60
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
        : `${seconds}s`;
    parts.push(`~${delay} behind`);
  }
  if (ingestion.completeThrough !== undefined) {
    parts.push(
      `data complete through ${formatBucketTime(ingestion.completeThrough)} UTC`,
    );
  }
  const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `- **Ingestion**: ${ingestion.status}${detail}`;
}

/**
 * Format an events-timeseries result: a metric bucketed over time.
 * `interval` is null when Sentry chose the bucket size for the range.
 * Buckets flagged `incomplete` by Sentry are marked in the table. Those still
 * receiving data are also excluded from the peak; those that start before the
 * retention window are permanently partial and will not change.
 */
export function formatTimeSeriesResults(params: {
  series: EventsTimeSeriesResponse;
  yAxis: string;
  interval: string | null;
  inputQuery: string;
  includeExplanation?: boolean;
  explanation?: string;
  timeRange?: SearchTimeRange;
  url?: string;
}): string {
  const {
    series,
    yAxis,
    interval,
    inputQuery,
    includeExplanation,
    explanation,
    timeRange,
    url,
  } = params;

  const points = (series.timeSeries[0]?.values ?? []).map((bucket) => {
    // OUTSIDE_RETENTION buckets start before the retention window: their data
    // is permanently partial. Every other reason means data is still arriving.
    const outsideRetention =
      bucket.incomplete && bucket.incompleteReason === "OUTSIDE_RETENTION";
    return {
      time: formatBucketTime(bucket.timestamp),
      value: bucket.value ?? 0,
      filling: bucket.incomplete && !outsideRetention,
      outsideRetention,
    };
  });
  const hasFilling = points.some((p) => p.filling);
  const ingestion = series.meta?.ingestion;

  // Total is only meaningful for additive aggregates; summing count_unique /
  // avg / percentile buckets would be wrong, so omit it for those.
  const total = isAdditiveAggregate(yAxis)
    ? points.reduce((sum, p) => sum + p.value, 0)
    : null;
  // Buckets still filling can't be the peak yet. Partial retention buckets are
  // final, so if one still tops the rest it is a real peak.
  const peak = points
    .filter((p) => !p.filling)
    .reduce<(typeof points)[number] | undefined>(
      (max, p) => (max === undefined || p.value > max.value ? p : max),
      undefined,
    );

  const MAX_ROWS = 48;
  const shown = points.length > MAX_ROWS ? points.slice(-MAX_ROWS) : points;
  const truncatedNote =
    points.length > MAX_ROWS
      ? ` (most recent ${MAX_ROWS} of ${points.length})`
      : "";

  const lines: string[] = [`# Search Results for "${inputQuery}"`];

  if (includeExplanation && explanation) {
    lines.push("", formatExplanation(explanation));
  }

  lines.push("", `## ${yAxis} over time`);
  lines.push(
    `- **Interval**: ${interval ? `\`${interval}\`` : "auto (chosen by Sentry for the range)"}`,
  );
  lines.push(`- **Time range**: ${formatExecutedTimeRange(timeRange)}`);
  if (total !== null) {
    lines.push(
      `- **Total**: ${total.toLocaleString()}${hasFilling ? " (so far)" : ""}`,
    );
  }
  if (peak) {
    lines.push(`- **Peak**: ${peak.value.toLocaleString()} at ${peak.time}`);
  }
  if (ingestion) {
    lines.push(formatIngestionStatus(ingestion));
  }

  if (shown.length > 0) {
    lines.push(
      "",
      `## Buckets${truncatedNote}`,
      "",
      "| Time (UTC) | Value |",
      "| --- | --- |",
    );
    for (const p of shown) {
      const marker = p.filling ? " *" : p.outsideRetention ? " †" : "";
      lines.push(`| ${p.time} | ${p.value.toLocaleString()}${marker} |`);
    }
    // Footnotes describe markers in the visible rows only; older retention
    // buckets may have been cut by MAX_ROWS.
    const shownFilling = shown.some((p) => p.filling);
    const shownOutsideRetention = shown.some((p) => p.outsideRetention);
    if (shownFilling || shownOutsideRetention) {
      lines.push("");
    }
    if (shownFilling) {
      lines.push(
        "\\* Incomplete bucket: data is still arriving, so the value may rise.",
      );
    }
    if (shownOutsideRetention) {
      lines.push(
        "† Partial bucket: it starts before the retention window, so older data is missing and the value will not change.",
      );
    }
  } else {
    lines.push("", "No data points in this range.");
  }

  if (url) {
    lines.push("", formatSentryDashboardLink(url).trimEnd());
  }

  return lines.join("\n");
}
