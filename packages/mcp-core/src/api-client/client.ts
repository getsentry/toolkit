import { z } from "zod";
import { DEFAULT_SEARCH_ISSUES_PERIOD } from "../constants";
import { ConfigurationError } from "../errors";
import { retryWithBackoff } from "../internal/fetch-utils";
import { logIssue, logWarn } from "../telem/logging";
import type { SentryProtocol } from "../types";
import {
  type EventsDataset,
  isMetricsDataset,
  isProfilesDataset,
  normalizeEventsDataset,
} from "../utils/events-datasets";
import { isNumericId } from "../utils/slug-validation";
import {
  type DashboardUrlOptions,
  getAIConversationsUrl as getAIConversationsUrlUtil,
  getAIConversationUrl as getAIConversationUrlUtil,
  getContinuousProfileUrl as getContinuousProfileUrlUtil,
  getDashboardUrl as getDashboardUrlUtil,
  getIssueUrl as getIssueUrlUtil,
  getMonitorUrl as getMonitorUrlUtil,
  getPreprodSnapshotUrl as getPreprodSnapshotUrlUtil,
  getProfileUrl as getProfileUrlUtil,
  getProfilingExplorerUrl,
  getReleaseUrl as getReleaseUrlUtil,
  getReplaysSearchUrl as getReplaysSearchUrlUtil,
  getReplayUrl as getReplayUrlUtil,
  getTraceMetricsExploreUrl,
  getTraceUrl as getTraceUrlUtil,
  getUptimeMonitorUrl as getUptimeMonitorUrlUtil,
  isPublicSentryHost,
  type TraceMetricIdentifier,
} from "../utils/url-utils";
import { USER_AGENT } from "../version";
import { apiPath } from "./api-path";
import {
  ApiNotFoundError,
  ApiServerError,
  ApiValidationError,
  createApiError,
} from "./errors";
import {
  AgenticOnboardingRunSchema,
  AIConversationDetailsResponseSchema,
  AIConversationSummaryListSchema,
  AlertActionOptionSchema,
  AlertConditionOptionSchema,
  AlertRuleProjectScopeSchema,
  ApiErrorSchema,
  AutofixRunSchema,
  AutofixRunStateSchema,
  ClientKeyListSchema,
  ClientKeySchema,
  CommitListSchema,
  CommittersResponseSchema,
  DashboardListSchema,
  DashboardSchema,
  DeployListSchema,
  DetectorSchema,
  ErrorsSearchResponseSchema,
  EventAttachmentListSchema,
  EventSchema,
  EventsStatsResponseSchema,
  ExternalIssueListSchema,
  ExternalIssueSchema,
  FlamegraphSchema,
  IssueActivityListResponseSchema,
  IssueAlertRuleListSchema,
  IssueAlertRuleSchema,
  IssueCommentListSchema,
  IssueCommentSchema,
  IssueIntegrationListSchema,
  IssueListSchema,
  IssueSchema,
  IssueTagValuesSchema,
  MetricAlertRuleListSchema,
  MetricAlertRuleSchema,
  MonitorCheckInListSchema,
  MonitorListSchema,
  MonitorSchema,
  MonitorStatsSchema,
  NativeExternalIssueSchema,
  OrganizationEnvironmentListSchema,
  OrganizationListSchema,
  OrganizationSchema,
  ProfileChunkResponseSchema,
  ProjectListSchema,
  ProjectRepositoryMappingSchema,
  ProjectSchema,
  ReleaseDetailsSchema,
  ReleaseListSchema,
  ReplayDetailsSchema,
  ReplayIdsByResourceSchema,
  ReplayListResponseSchema,
  ReplayRecordingSegmentsSchema,
  RepositoryListSchema,
  SearchAgentStartSchema,
  SearchAgentStateSchema,
  SentryAppComponentListSchema,
  SentryAppExternalRequestOptionsSchema,
  SentryAppInstallationListSchema,
  SpansSearchResponseSchema,
  StacktraceLinkSchema,
  TagListSchema,
  TeamListSchema,
  TeamSchema,
  TraceMetaSchema,
  TraceSchema,
  TransactionProfileSchema,
  UptimeCheckListSchema,
  UptimeMonitorListSchema,
  UptimeMonitorSchema,
  UserReportListSchema,
  UserSchema,
} from "./schema";
import type {
  AgenticOnboardingRun,
  AgenticOnboardingStatusUpdate,
  AIConversationDetails,
  AIConversationSpanList,
  AIConversationSummary,
  AlertActionOption,
  AlertConditionOption,
  AlertRuleCreate,
  AlertRuleProjectScope,
  AlertRuleUpdate,
  AutofixRun,
  AutofixRunState,
  SearchAgentStart,
  SearchAgentState,
  ClientKey,
  ClientKeyList,
  CommitList,
  CommitterList,
  Dashboard,
  DashboardListItem,
  DeployList,
  Detector,
  Event,
  EventAttachment,
  EventAttachmentList,
  ExternalIssue,
  ExternalIssueList,
  Flamegraph,
  Issue,
  IssueActivityList,
  IssueAlertRule,
  IssueAlertRuleList,
  IssueComment,
  IssueCommentList,
  IssueIntegrationList,
  IssueList,
  IssueTagValues,
  MetricAlertRule,
  MetricAlertRuleList,
  MetricMonitorCreate,
  MetricMonitorUpdate,
  Monitor,
  MonitorCheckInList,
  MonitorList,
  MonitorStats,
  NativeExternalIssue,
  OrganizationEnvironmentList,
  OrganizationList,
  ProfileChunk,
  Project,
  ProjectList,
  ReleaseDetails,
  ReleaseList,
  ReplayDetails,
  ReplayList,
  ReplayRecordingSegments,
  SentryAppComponentList,
  SentryAppExternalRequestOptions,
  SentryAppInstallationList,
  StacktraceLink,
  TagList,
  Team,
  TeamList,
  Trace,
  TraceMeta,
  TransactionProfile,
  UptimeCheckList,
  UptimeMonitor,
  UptimeMonitorList,
  User,
  UserReportList,
} from "./types";

// TODO: this is shared - so ideally, for safety, it uses @sentry/core, but currently
// logger isnt exposed (or rather, it is, but its not the right logger)
// import { logger } from "@sentry/node";

const SENTRY_MCP_SEARCH_EVENTS_REFERRER = "api.mcp.search-events";

/**
 * Filters on other events in the same trace, e.g. spans whose trace also has a
 * matching log. Only the spans and logs datasets support them.
 */
export type CrossEventQueries = {
  spanQuery?: string;
  logQuery?: string;
  metricQuery?: string;
};

type ExplorerAggregateParams = {
  fields?: string[];
  aggregateFunctions?: string[];
  groupByFields?: string[];
};

type ExplorerUrlParams = ExplorerAggregateParams & {
  organizationSlug: string;
  query: string;
  projectId?: string;
  sort?: string;
  statsPeriod?: string;
  start?: string;
  end?: string;
};

/**
 * Mapping of common network error codes to user-friendly messages.
 * These help users understand and resolve connection issues.
 */
const NETWORK_ERROR_MESSAGES: Record<string, string> = {
  EAI_AGAIN: "DNS temporarily unavailable. Check your internet connection.",
  ENOTFOUND: "Hostname not found. Verify the URL is correct.",
  ECONNREFUSED: "Connection refused. Ensure the service is accessible.",
  ETIMEDOUT: "Connection timed out. Check network connectivity.",
  ECONNRESET: "Connection reset. Try again in a moment.",
};

function normalizeStatsPeriod(statsPeriod?: string): string | undefined {
  const normalized = statsPeriod?.trim();
  return normalized || undefined;
}

function formatWorkflowNameQuery(query: string): string {
  const escapedQuery = query.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `name:"*${escapedQuery}*"`;
}

function parseStatsPeriod(statsPeriod: string): {
  amount: number;
  unit: string;
} {
  const match = /^(\d+)([smhdw])$/.exec(statsPeriod);
  if (!match) {
    throw new ApiValidationError(
      "statsPeriod must use a supported relative time format, such as `24h`, `7d`, or `2w`.",
    );
  }
  return {
    amount: Number(match[1]),
    unit: match[2],
  };
}

function getNextCursor(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }

  for (const link of linkHeader.split(",")) {
    if (!link.includes('rel="next"') || !link.includes('results="true"')) {
      continue;
    }

    const cursorMatch = link.match(/cursor="([^"]+)"/);
    if (cursorMatch?.[1]) {
      return cursorMatch[1];
    }
  }

  return null;
}

/**
 * Custom error class for Sentry API responses.
 *
 * Provides enhanced error messages for LLM consumption and handles
 * common API error scenarios with user-friendly messaging.
 *
 * @example
 * ```typescript
 * try {
 *   await apiService.listIssues({ organizationSlug: "invalid" });
 * } catch (error) {
 *   if (error instanceof ApiError) {
 *     console.log(`API Error ${error.status}: ${error.message}`);
 *   }
 * }
 * ```
 */

type RequestOptions = {
  host?: string;
  allowStatuses?: number[];
};

/**
 * Automatic retry policy for transient upstream gateway failures (502/503/504).
 *
 * Sentry's edge intermittently returns short-lived gateway errors (e.g.
 * "upstream connect error or disconnect/reset before headers") that clear on a
 * retry. We retry only idempotent GET requests so an automatic retry can never
 * replay a mutation, and keep the budget small so a still-failing tool call
 * resolves quickly under the Cloudflare Workers request lifetime.
 */
const RETRYABLE_REQUEST_MAX_RETRIES = 2;
const RETRYABLE_REQUEST_INITIAL_DELAY_MS = 250;

/**
 * Default cap for returning attachment bytes inline over the MCP transport.
 * A 30 MB attachment takes ~80 MB in memory once base64-encoded and serialized,
 * which fits the Cloudflare Worker's 128 MB isolate with room for the rest of the
 * request; above it, getEventAttachment returns a reference instead of the bytes.
 */
export const DEFAULT_MAX_INLINE_ATTACHMENT_BYTES = 30 * 1024 * 1024;

export type TraceItemType = "spans" | "logs" | "tracemetrics";

type ClientKeyRateLimit = {
  window: number;
  count: number;
};

type ClientKeyDynamicSdkLoaderOptions = {
  hasReplay?: boolean;
  hasPerformance?: boolean;
  hasDebug?: boolean;
  hasFeedback?: boolean;
  hasLogsAndMetrics?: boolean;
};

type CreateProjectRequest = {
  name: string;
  slug?: string;
  platform?: string;
};

type UpdateProjectRequest = {
  name?: string;
  slug?: string;
  platform?: string;
};

type UpdateClientKeyRequest = {
  name?: string;
  isActive?: boolean;
  rateLimit?: ClientKeyRateLimit | null;
  browserSdkVersion?: string;
  dynamicSdkLoaderOptions?: ClientKeyDynamicSdkLoaderOptions;
};
export type TraceItemAttributeType = "string" | "number" | "boolean";
export type TraceItemAttributeSourceType = "sentry" | "user";

export type TraceItemAttributeSource = {
  source_type: TraceItemAttributeSourceType;
  is_transformed_alias?: boolean;
};

export type TraceItemAttribute = {
  key: string;
  name: string;
  type: TraceItemAttributeType;
  attributeSource: TraceItemAttributeSource;
  secondaryAliases?: string[];
};

export type TraceItemAttributeValidationResult = {
  valid: boolean;
  type?: TraceItemAttributeType;
  error?: string;
};

export type EventsValidationIssue = {
  valid: boolean;
  error?: string;
};

export type EventsNamedValidationIssue = {
  name: string;
  valid: boolean;
  error?: string;
};

export type EventsAttributeValidationResult = {
  name: string;
  valid: boolean;
  type?: TraceItemAttributeType;
  error?: string;
};

export type EventsQueryValidation = {
  valid: boolean;
  error?: string;
  fields: EventsAttributeValidationResult[];
};

export type EventsValidationResult = {
  valid: boolean;
  projects: EventsValidationIssue[];
  dataset: EventsNamedValidationIssue[];
  environment: EventsValidationIssue[];
  field: EventsAttributeValidationResult[];
  query: EventsQueryValidation;
  orderby: EventsAttributeValidationResult[];
};

const TraceItemAttributeTypeSchema = z.enum(["string", "number", "boolean"]);
const TraceItemAttributeSourceSchema = z.object({
  source_type: z.enum(["sentry", "user"]),
  is_transformed_alias: z.boolean().optional(),
});

const ValidationErrorSchema = z.string().nullable();

const EventsValidationIssueSchema = z
  .object({
    valid: z.boolean(),
    error: ValidationErrorSchema,
  })
  .transform(
    ({ valid, error }): EventsValidationIssue => ({
      valid,
      ...(error ? { error } : {}),
    }),
  );

const EventsNamedValidationIssueSchema = z
  .object({
    name: z.string(),
    valid: z.boolean(),
    error: ValidationErrorSchema,
  })
  .transform(
    ({ name, valid, error }): EventsNamedValidationIssue => ({
      name,
      valid,
      ...(error ? { error } : {}),
    }),
  );

const EventsAttributeValidationSchema = z
  .object({
    name: z.string(),
    valid: z.boolean(),
    attrType: TraceItemAttributeTypeSchema.nullable(),
    error: ValidationErrorSchema,
  })
  .transform(
    ({ name, valid, attrType, error }): EventsAttributeValidationResult => ({
      name,
      valid,
      ...(attrType ? { type: attrType } : {}),
      ...(error ? { error } : {}),
    }),
  );

const EventsValidationIssueListSchema = z.array(EventsValidationIssueSchema);
const EventsNamedValidationIssueListSchema = z.array(
  EventsNamedValidationIssueSchema,
);
const EventsAttributeValidationListSchema = z.array(
  EventsAttributeValidationSchema,
);
const EventsQueryValidationSchema = z
  .object({
    valid: z.boolean(),
    error: ValidationErrorSchema,
    fields: EventsAttributeValidationListSchema,
  })
  .transform(
    ({ valid, error, fields }): EventsQueryValidation => ({
      valid,
      fields,
      ...(error ? { error } : {}),
    }),
  );

const EventsValidationResponseSchema = z
  .object({
    valid: z.boolean(),
    projects: EventsValidationIssueListSchema,
    dataset: EventsNamedValidationIssueListSchema,
    environment: EventsValidationIssueListSchema,
    field: EventsAttributeValidationListSchema,
    query: EventsQueryValidationSchema,
    orderby: EventsAttributeValidationListSchema,
  })
  .transform((result): EventsValidationResult => result);

const TraceItemAttributeSchema = z
  .object({
    key: z.string(),
    name: z.string(),
    attributeType: TraceItemAttributeTypeSchema,
    attributeSource: TraceItemAttributeSourceSchema,
    secondaryAliases: z.array(z.string()).optional(),
  })
  .transform(
    ({ key, name, attributeType, attributeSource, secondaryAliases }) => ({
      key,
      name,
      type: attributeType,
      attributeSource,
      ...(secondaryAliases ? { secondaryAliases } : {}),
    }),
  );

const TraceItemAttributeListSchema = z.array(TraceItemAttributeSchema);

/**
 * Sentry API client service for interacting with Sentry's REST API.
 *
 * This service provides a comprehensive interface to Sentry's API endpoints,
 * handling authentication, error processing, multi-region support, and
 * response validation through Zod schemas.
 *
 * Key Features:
 * - Multi-region support for Sentry SaaS and self-hosted instances
 * - Automatic schema validation with Zod
 * - Enhanced error handling with LLM-friendly messages
 * - URL generation for Sentry resources (issues, traces)
 * - Bearer token authentication
 * - Uses HTTPS by default, with opt-in HTTP for self-hosted stdio deployments
 *
 * @example Basic Usage
 * ```typescript
 * const apiService = new SentryApiService({
 *   accessToken: "your-token",
 *   host: "sentry.io"
 * });
 *
 * const orgs = await apiService.listOrganizations();
 * const issues = await apiService.listIssues({
 *   organizationSlug: "my-org",
 *   query: "is:unresolved"
 * });
 * ```
 *
 * @example Multi-Region Support
 * ```typescript
 * // Self-hosted instance with hostname
 * const selfHosted = new SentryApiService({
 *   accessToken: "token",
 *   host: "sentry.company.com"
 * });
 *
 * // Regional endpoint override
 * const issues = await apiService.listIssues(
 *   { organizationSlug: "org" },
 *   { host: "eu.sentry.io" }
 * );
 * ```
 */
export class SentryApiService {
  private accessToken: string | null;
  private clientId: string | null;
  private clientName: string | null;
  private clientFamily: string | null;
  private utmSource: string | null;
  protected host: string;
  protected protocol: SentryProtocol;
  protected apiPrefix: string;

  /**
   * Creates a new Sentry API service instance.
   *
   * Uses HTTPS by default. Stdio may opt into HTTP for self-hosted deployments.
   *
   * @param config Configuration object
   * @param config.accessToken OAuth access token for authentication (optional for some endpoints)
   * @param config.host Sentry hostname (e.g. "sentry.io", "sentry.example.com")
   * @param config.clientId DCR-registered OAuth client ID
   * @param config.clientName DCR-registered OAuth client name
   * @param config.clientFamily Bucketed client family (e.g. "claude-code", "cursor")
   * @param config.utmSource Sanitized MCP request attribution source
   */
  constructor({
    accessToken = null,
    host = "sentry.io",
    protocol = "https",
    clientId = null,
    clientName = null,
    clientFamily = null,
    utmSource = null,
  }: {
    accessToken?: string | null;
    host?: string;
    protocol?: SentryProtocol;
    clientId?: string | null;
    clientName?: string | null;
    clientFamily?: string | null;
    utmSource?: string | null;
  }) {
    this.accessToken = accessToken;
    this.clientId = clientId;
    this.clientName = clientName;
    this.clientFamily = clientFamily;
    this.utmSource = utmSource;
    this.host = host;
    this.protocol = protocol;
    this.apiPrefix = `${protocol}://${host}/api/0`;
  }

  /**
   * Updates the host for API requests.
   *
   * Used for multi-region support or switching between Sentry instances.
   * Preserves the configured URL scheme.
   *
   * @param host New hostname to use for API requests
   */
  setHost(host: string) {
    this.host = host;
    this.apiPrefix = `${this.protocol}://${this.host}/api/0`;
  }

  /**
   * Whether API control requests and web URLs use public SaaS routing.
   */
  private isPublicSaas(): boolean {
    return isPublicSentryHost(this.host);
  }

  /**
   * Validates and applies time parameters to a URLSearchParams object.
   *
   * Enforces mutual exclusivity between relative (statsPeriod) and
   * absolute (start/end) time ranges, and ensures start/end are paired.
   *
   * @param queryParams The URLSearchParams to modify
   * @param statsPeriod Relative time period (e.g., "24h", "7d")
   * @param start Absolute start time (ISO 8601)
   * @param end Absolute end time (ISO 8601)
   * @throws {ApiValidationError} If time parameters are invalid
   */
  private applyTimeParams(
    queryParams: URLSearchParams,
    statsPeriod?: string,
    start?: string,
    end?: string,
  ): void {
    if (statsPeriod && (start || end)) {
      throw new ApiValidationError(
        "Cannot use both statsPeriod and start/end parameters. Use either statsPeriod for relative time or start/end for absolute time.",
      );
    }
    if ((start && !end) || (!start && end)) {
      throw new ApiValidationError(
        "Both start and end parameters must be provided together for absolute time ranges.",
      );
    }
    if (statsPeriod) {
      queryParams.set("statsPeriod", statsPeriod);
    } else if (start && end) {
      queryParams.set("start", start);
      queryParams.set("end", end);
    }
  }

  private applyStatsMixinTimeParams(
    queryParams: URLSearchParams,
    statsPeriod?: string,
    start?: string,
    end?: string,
    resolutionSeconds?: number,
  ): void {
    if (statsPeriod && (start || end)) {
      throw new ApiValidationError(
        "Cannot use both statsPeriod and start/end parameters. Use either statsPeriod for relative time or start/end for absolute time.",
      );
    }
    if ((start && !end) || (!start && end)) {
      throw new ApiValidationError(
        "Both start and end parameters must be provided together for absolute time ranges.",
      );
    }

    let since: number;
    let until: number;

    if (start && end) {
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        throw new ApiValidationError(
          "start and end parameters must be valid ISO 8601 date strings.",
        );
      }
      since = Math.floor(startMs / 1000);
      until = Math.floor(endMs / 1000);
    } else {
      const period = statsPeriod ?? "24h";
      const { amount, unit } = parseStatsPeriod(period);
      let unitSeconds: number;
      switch (unit) {
        case "s":
          unitSeconds = 1;
          break;
        case "m":
          unitSeconds = 60;
          break;
        case "h":
          unitSeconds = 60 * 60;
          break;
        case "d":
          unitSeconds = 60 * 60 * 24;
          break;
        case "w":
          unitSeconds = 60 * 60 * 24 * 7;
          break;
        default:
          throw new ApiValidationError(
            "statsPeriod must use a supported relative time format, such as `24h`, `7d`, or `2w`.",
          );
      }
      until = Math.floor(Date.now() / 1000);
      since = until - amount * unitSeconds;
    }

    queryParams.set("since", String(since));
    queryParams.set("until", String(until));
    if (resolutionSeconds !== undefined) {
      queryParams.set("resolution", `${resolutionSeconds}s`);
    }
  }

  /**
   * Makes an authenticated request to the Sentry API, transparently retrying
   * transient upstream gateway failures (502/503/504).
   *
   * Retries are limited to idempotent GET requests so an automatic retry can
   * never replay a mutation, and are gated on `ApiServerError.isGatewayError()`
   * so persistent 500s, 4xx client errors, and network/configuration errors
   * fail fast without waiting. Callers that opt a 5xx into `allowStatuses`
   * receive the raw response from `requestOnce` and are never retried.
   *
   * @param path API endpoint path (without /api/0 prefix)
   * @param options Fetch options
   * @param requestOptions Additional request configuration
   * @returns Promise resolving to Response object
   * @throws {ApiError} Enhanced API errors with user-friendly messages
   * @throws {Error} Network or parsing errors
   */
  private async request(
    path: string,
    options: RequestInit = {},
    requestOptions: { host?: string; allowStatuses?: number[] } = {},
  ): Promise<Response> {
    const method = (options.method ?? "GET").toUpperCase();
    const isIdempotent = method === "GET";

    return retryWithBackoff(
      () => this.requestOnce(path, options, requestOptions),
      {
        maxRetries: isIdempotent ? RETRYABLE_REQUEST_MAX_RETRIES : 0,
        initialDelay: RETRYABLE_REQUEST_INITIAL_DELAY_MS,
        shouldRetry: (error) =>
          error instanceof ApiServerError && error.isGatewayError(),
      },
    );
  }

  /**
   * Internal method for making authenticated requests to Sentry API.
   *
   * Handles:
   * - Bearer token authentication
   * - Error response parsing and enhancement
   * - Multi-region host overrides
   * - Fetch availability validation
   *
   * @param path API endpoint path (without /api/0 prefix)
   * @param options Fetch options
   * @param requestOptions Additional request configuration
   * @returns Promise resolving to Response object
   * @throws {ApiError} Enhanced API errors with user-friendly messages
   * @throws {Error} Network or parsing errors
   */
  private async requestOnce(
    path: string,
    options: RequestInit = {},
    { host, allowStatuses }: { host?: string; allowStatuses?: number[] } = {},
  ): Promise<Response> {
    const url = host
      ? `${this.protocol}://${host}/api/0${path}`
      : `${this.apiPrefix}${path}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    };
    if (this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    if (this.clientId) {
      headers["X-Sentry-MCP-Client-Id"] = this.clientId;
    }
    if (this.clientName) {
      headers["X-Sentry-MCP-Client-Name"] = this.clientName;
    }
    if (this.clientFamily) {
      headers["X-Sentry-MCP-Client-Family"] = this.clientFamily;
    }
    if (this.utmSource) {
      headers["X-Sentry-MCP-Utm-Source"] = this.utmSource;
    }

    // Check if fetch is available, otherwise provide a helpful error message
    if (typeof globalThis.fetch === "undefined") {
      throw new ConfigurationError(
        "fetch is not available. Please use Node.js >= 18 or ensure fetch is available in your environment.",
      );
    }

    // logger.info(logger.fmt`[sentryApi] ${options.method || "GET"} ${url}`);
    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        headers,
      });
    } catch (error) {
      // Extract the root cause from the error chain
      let rootCause = error;
      while (rootCause instanceof Error && rootCause.cause) {
        rootCause = rootCause.cause;
      }

      const errorMessage =
        rootCause instanceof Error ? rootCause.message : String(rootCause);

      let friendlyMessage = `Unable to connect to ${url}`;

      // Check if we have a specific message for this error
      const errorCode = Object.keys(NETWORK_ERROR_MESSAGES).find((code) =>
        errorMessage.includes(code),
      );

      if (errorCode) {
        friendlyMessage += ` - ${NETWORK_ERROR_MESSAGES[errorCode]}`;
      } else {
        friendlyMessage += ` - ${errorMessage}`;
      }

      // DNS resolution failures and connection timeouts to custom hosts are configuration issues
      if (
        errorCode === "ENOTFOUND" ||
        errorCode === "EAI_AGAIN" ||
        errorCode === "ECONNREFUSED" ||
        errorCode === "ETIMEDOUT" ||
        errorMessage.includes("Connect Timeout Error")
      ) {
        throw new ConfigurationError(friendlyMessage, { cause: error });
      }

      throw new Error(friendlyMessage, { cause: error });
    }

    // Handle error responses generically
    if (!response.ok) {
      if (allowStatuses?.includes(response.status)) {
        return response;
      }
      const errorText = await response.text();
      let parsed: unknown | undefined;
      try {
        parsed = JSON.parse(errorText);
      } catch (error) {
        // If we can't parse JSON, check if it's HTML (server error)
        if (errorText.includes("<!DOCTYPE") || errorText.includes("<html")) {
          logWarn("Received HTML error page instead of JSON", {
            loggerScope: ["api", "client"],
            extra: {
              status: response.status,
              statusText: response.statusText,
              host: this.host,
              path,
              parseErrorMessage:
                error instanceof Error ? error.message : String(error),
            },
          });
          // HTML response instead of JSON typically indicates a server configuration issue
          throw createApiError(
            `Server error: Received HTML instead of JSON (${response.status} ${response.statusText}). This may indicate an invalid URL or server issue.`,
            response.status,
            errorText,
            undefined,
          );
        }
        logWarn("Failed to parse JSON error response", {
          loggerScope: ["api", "client"],
          extra: {
            status: response.status,
            statusText: response.statusText,
            host: this.host,
            path,
            bodyPreview:
              errorText.length > 256
                ? `${errorText.slice(0, 253)}…`
                : errorText,
            parseErrorMessage:
              error instanceof Error ? error.message : String(error),
          },
        });
      }

      if (parsed) {
        const { data, success, error } = ApiErrorSchema.safeParse(parsed);

        if (success) {
          // Use the new error factory to create the appropriate error type
          throw createApiError(
            data.detail,
            response.status,
            data.detail,
            parsed,
          );
        }

        logWarn("Failed to parse validated API error response", {
          loggerScope: ["api", "client"],
          extra: {
            status: response.status,
            statusText: response.statusText,
            host: this.host,
            path,
            bodyPreview:
              errorText.length > 256
                ? `${errorText.slice(0, 253)}…`
                : errorText,
            validationErrorMessage:
              error instanceof Error ? error.message : String(error),
          },
        });
      }

      // Use the error factory to create the appropriate error type based on status
      throw createApiError(
        `API request failed: ${response.statusText}\n${errorText}`,
        response.status,
        errorText,
        undefined,
      );
    }

    return response;
  }

  /**
   * Safely parses a JSON response, checking Content-Type header first.
   *
   * @param response The Response object from fetch
   * @returns Promise resolving to the parsed JSON object
   * @throws {Error} If response is not JSON or parsing fails
   */
  private async parseJsonResponse(response: Response): Promise<unknown> {
    // Handle case where response might not have all properties (e.g., in tests or promise chains)
    if (!response.headers?.get) {
      return response.json();
    }

    const contentType = response.headers.get("content-type");

    // Check if the response is JSON
    if (!contentType || !contentType.includes("application/json")) {
      const responseText = await response.text();

      // Check if it's HTML
      if (
        contentType?.includes("text/html") ||
        responseText.includes("<!DOCTYPE") ||
        responseText.includes("<html")
      ) {
        // HTML when expecting JSON usually indicates authentication or routing issues
        throw new Error(
          `Expected JSON response but received HTML (${response.status} ${response.statusText}). This may indicate you're not authenticated, the URL is incorrect, or there's a server issue.`,
        );
      }

      // Generic non-JSON error
      throw new Error(
        `Expected JSON response but received ${contentType || "unknown content type"} ` +
          `(${response.status} ${response.statusText})`,
      );
    }

    try {
      return await response.json();
    } catch (error) {
      // JSON parsing failure after successful response
      throw new Error(
        `Failed to parse JSON response: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Makes a request to the Sentry API and parses the JSON response.
   *
   * This is the primary method for API calls that expect JSON responses.
   * It automatically validates Content-Type and provides helpful error messages
   * for common issues like authentication failures or server errors.
   *
   * @param path API endpoint path (without /api/0 prefix)
   * @param options Fetch options
   * @param requestOptions Additional request configuration
   * @returns Promise resolving to the parsed JSON response
   * @throws {ApiError} Enhanced API errors with user-friendly messages
   * @throws {Error} Network, parsing, or validation errors
   */
  private async requestJSON(
    path: string,
    options: RequestInit = {},
    requestOptions?: { host?: string },
  ): Promise<unknown> {
    const response = await this.request(path, options, requestOptions);
    return this.parseJsonResponse(response);
  }

  /**
   * Generates a Sentry issue URL for browser navigation.
   *
   * Handles both SaaS (subdomain-based) and self-hosted URL formats.
   * Uses the configured protocol.
   *
   * @param organizationSlug Organization identifier
   * @param issueId Issue identifier (short ID or numeric ID)
   * @returns Full URL to the issue in Sentry UI
   *
   * @example
   * ```typescript
   * // SaaS: https://my-org.sentry.io/issues/PROJ-123
   * apiService.getIssueUrl("my-org", "PROJ-123")
   *
   * // Self-hosted: https://sentry.company.com/organizations/my-org/issues/PROJ-123
   * apiService.getIssueUrl("my-org", "PROJ-123")
   * ```
   */
  getIssueUrl(organizationSlug: string, issueId: string): string {
    return getIssueUrlUtil(this.host, organizationSlug, issueId, this.protocol);
  }

  /**
   * Generates a Sentry trace URL for performance investigation.
   *
   * Uses the configured protocol.
   *
   * @param organizationSlug Organization identifier
   * @param traceId Trace identifier (hex string)
   * @returns Full URL to the trace in Sentry UI
   *
   * @example
   * ```typescript
   * const traceUrl = apiService.getTraceUrl("my-org", "6a477f5b0f31ef7b6b9b5e1dea66c91d");
   * // https://my-org.sentry.io/explore/traces/trace/6a477f5b0f31ef7b6b9b5e1dea66c91d
   * ```
   */
  getTraceUrl(organizationSlug: string, traceId: string): string {
    return getTraceUrlUtil(this.host, organizationSlug, traceId, this.protocol);
  }

  getReplayUrl(organizationSlug: string, replayId: string): string {
    return getReplayUrlUtil(
      this.host,
      organizationSlug,
      replayId,
      this.protocol,
    );
  }

  getAIConversationUrl(
    organizationSlug: string,
    conversationId: string,
  ): string {
    return getAIConversationUrlUtil(
      this.host,
      organizationSlug,
      conversationId,
      this.protocol,
    );
  }

  /** Builds the Sentry UI URL for the AI Conversations list with optional filters. */
  getAIConversationsUrl(
    organizationSlug: string,
    options?: {
      query?: string;
      project?: string[];
      environment?: string | string[];
      statsPeriod?: string;
      start?: string;
      end?: string;
    },
  ): string {
    return getAIConversationsUrlUtil(
      this.host,
      organizationSlug,
      options,
      this.protocol,
    );
  }

  getProfileUrl(
    organizationSlug: string,
    projectSlug: string,
    profileId: string,
  ): string {
    return getProfileUrlUtil(
      this.host,
      organizationSlug,
      projectSlug,
      profileId,
      this.protocol,
    );
  }

  getContinuousProfileUrl(
    organizationSlug: string,
    projectSlug: string,
    options: {
      profilerId: string;
      start: string;
      end: string;
    },
  ): string {
    return getContinuousProfileUrlUtil(
      this.host,
      organizationSlug,
      projectSlug,
      options,
      this.protocol,
    );
  }

  getReplaysSearchUrl(
    organizationSlug: string,
    options: Parameters<typeof getReplaysSearchUrlUtil>[2] = {},
  ): string {
    return getReplaysSearchUrlUtil(
      this.host,
      organizationSlug,
      options,
      this.protocol,
    );
  }

  getMonitorUrl(
    organizationSlug: string,
    monitorSlug: string,
    projectSlug?: string,
  ): string {
    return getMonitorUrlUtil(
      this.host,
      organizationSlug,
      monitorSlug,
      this.protocol,
      projectSlug,
    );
  }

  getUptimeMonitorUrl(
    organizationSlug: string,
    uptimeMonitorId: string | number,
  ): string {
    return this.getDetectorUrl(organizationSlug, uptimeMonitorId);
  }

  getDetectorUrl(
    organizationSlug: string,
    detectorId: string | number,
  ): string {
    return getUptimeMonitorUrlUtil(
      this.host,
      organizationSlug,
      detectorId,
      this.protocol,
    );
  }

  getReleaseUrl(organizationSlug: string, releaseVersion: string): string {
    return getReleaseUrlUtil(
      this.host,
      organizationSlug,
      releaseVersion,
      this.protocol,
    );
  }

  getDashboardUrl(
    organizationSlug: string,
    dashboardId: string,
    options: DashboardUrlOptions = {},
  ): string {
    return getDashboardUrlUtil(
      this.host,
      organizationSlug,
      dashboardId,
      options,
      this.protocol,
    );
  }

  getIssueAlertRuleUrl(
    organizationSlug: string,
    ruleId: string | number,
  ): string {
    const encodedRuleId = encodeURIComponent(String(ruleId));
    if (this.isPublicSaas()) {
      return `${this.protocol}://${organizationSlug}.sentry.io/monitors/alerts/${encodedRuleId}/`;
    }
    return `${this.protocol}://${this.host}/organizations/${organizationSlug}/monitors/alerts/${encodedRuleId}/`;
  }

  getMetricAlertRuleUrl(
    organizationSlug: string,
    ruleId: string | number,
  ): string {
    const encodedRuleId = encodeURIComponent(String(ruleId));
    if (this.isPublicSaas()) {
      return `${this.protocol}://${organizationSlug}.sentry.io/issues/alerts/rules/details/${encodedRuleId}/`;
    }
    return `${this.protocol}://${this.host}/organizations/${organizationSlug}/issues/alerts/rules/details/${encodedRuleId}/`;
  }

  // ================================================================================
  // URL BUILDERS FOR DIFFERENT SENTRY APIS
  // ================================================================================

  /**
   * Builds a URL for the legacy Discover API (used by errors dataset).
   *
   * The Discover API is the older query interface that includes aggregate
   * functions directly in the field list.
   *
   * @example
   * // URL format: /explore/discover/homepage/?field=title&field=count_unique(user)
   * buildDiscoverUrl("my-org", "level:error", "123", ["title", "count_unique(user)"], "-timestamp")
   */
  private buildDiscoverUrl(params: {
    organizationSlug: string;
    query: string;
    projectId?: string;
    fields?: string[];
    sort?: string;
    statsPeriod?: string;
    start?: string;
    end?: string;
    aggregateFunctions?: string[];
    groupByFields?: string[];
  }): string {
    const {
      organizationSlug,
      query,
      projectId,
      fields,
      sort,
      statsPeriod,
      start,
      end,
      aggregateFunctions,
      groupByFields,
    } = params;

    const urlParams = new URLSearchParams();

    // Discover API specific parameters
    urlParams.set("dataset", "errors");
    urlParams.set("queryDataset", "error-events");
    urlParams.set("query", query);

    if (projectId) {
      urlParams.set("project", projectId);
    }

    // Discover API includes aggregate functions directly in field list
    if (fields && fields.length > 0) {
      for (const field of fields) {
        urlParams.append("field", field);
      }
    } else {
      // Default fields for Discover
      urlParams.append("field", "title");
      urlParams.append("field", "project");
      urlParams.append("field", "user.display");
      urlParams.append("field", "timestamp");
    }

    urlParams.set("sort", sort || "-timestamp");

    // Add time parameters - either statsPeriod or start/end
    if (start && end) {
      urlParams.set("start", start);
      urlParams.set("end", end);
    } else {
      urlParams.set("statsPeriod", statsPeriod || "24h");
    }

    // Check if this is an aggregate query
    const isAggregate = (aggregateFunctions?.length ?? 0) > 0;
    if (isAggregate) {
      urlParams.set("mode", "aggregate");
      // For aggregate queries in Discover, set yAxis to the first aggregate function
      if (aggregateFunctions && aggregateFunctions.length > 0) {
        urlParams.set("yAxis", aggregateFunctions[0]);
      }
    } else {
      urlParams.set("yAxis", "count()");
    }

    // Public SaaS uses sentry.io for web UI URLs regardless of region.
    // Regional subdomains (e.g., us.sentry.io) are only for API endpoints
    const webHost = this.isPublicSaas() ? "sentry.io" : this.host;
    const path = this.isPublicSaas()
      ? `${this.protocol}://${organizationSlug}.${webHost}/explore/discover/homepage/`
      : `${this.protocol}://${this.host}/organizations/${organizationSlug}/explore/discover/homepage/`;

    return `${path}?${urlParams.toString()}`;
  }

  private isAggregateExplorerQuery(params: ExplorerAggregateParams): boolean {
    return Boolean(
      params.aggregateFunctions?.length ||
        params.fields?.some(
          (field) => field.includes("(") && field.includes(")"),
        ),
    );
  }

  /**
   * Adds the structured aggregate fields shared by the Spans and Logs Explorer
   * URL formats. Each group-by and collection of y-axes is encoded as a
   * separate JSON-valued `aggregateField` parameter.
   *
   * @example
   * aggregateField={"groupBy":"span.op"}&aggregateField={"yAxes":["count()"]}
   */
  private appendAggregateFields(
    urlParams: URLSearchParams,
    params: ExplorerAggregateParams,
  ): void {
    const { fields, aggregateFunctions, groupByFields } = params;

    if (aggregateFunctions?.length || groupByFields?.length) {
      // Prefer the structured aggregate metadata returned by search_events.
      for (const field of groupByFields ?? []) {
        urlParams.append("aggregateField", JSON.stringify({ groupBy: field }));
      }

      if (aggregateFunctions?.length) {
        urlParams.append(
          "aggregateField",
          JSON.stringify({ yAxes: aggregateFunctions }),
        );
      }
      return;
    }

    // Fall back to deriving aggregate metadata from the selected fields.
    const parsedGroupByFields =
      fields?.filter((field) => !field.includes("(") && !field.includes(")")) ??
      [];
    const parsedAggregateFunctions =
      fields?.filter((field) => field.includes("(") && field.includes(")")) ??
      [];

    for (const field of parsedGroupByFields) {
      urlParams.append("aggregateField", JSON.stringify({ groupBy: field }));
    }

    if (parsedAggregateFunctions.length > 0) {
      urlParams.append(
        "aggregateField",
        JSON.stringify({ yAxes: parsedAggregateFunctions }),
      );
    }
  }

  private appendExplorerTimeParams(
    urlParams: URLSearchParams,
    params: { statsPeriod?: string; start?: string; end?: string },
  ): void {
    if (params.start && params.end) {
      urlParams.set("start", params.start);
      urlParams.set("end", params.end);
    } else {
      urlParams.set("statsPeriod", params.statsPeriod || "24h");
    }
  }

  private buildExplorePath(
    organizationSlug: string,
    page: "logs" | "traces",
  ): string {
    // Public SaaS uses sentry.io for web UI URLs regardless of region.
    // Regional subdomains (e.g., us.sentry.io) are only for API endpoints.
    if (this.isPublicSaas()) {
      return `${this.protocol}://${organizationSlug}.sentry.io/explore/${page}/`;
    }
    return `${this.protocol}://${this.host}/organizations/${organizationSlug}/explore/${page}/`;
  }

  /** Builds a Spans Explorer URL using its `query`, `field`, and `sort` contract. */
  private buildSpansExplorerUrl(params: ExplorerUrlParams): string {
    const { organizationSlug, query, projectId, fields, sort } = params;

    const urlParams = new URLSearchParams();
    urlParams.set("query", query);

    if (projectId) {
      urlParams.set("project", projectId);
    }

    const isAggregateQuery = this.isAggregateExplorerQuery(params);

    if (isAggregateQuery) {
      this.appendAggregateFields(urlParams, params);
      urlParams.set("mode", "aggregate");
    } else {
      for (const field of fields ?? []) {
        urlParams.append("field", field);
      }
    }

    // Add sort parameter for all queries
    if (sort) {
      urlParams.set("sort", sort);
    }

    this.appendExplorerTimeParams(urlParams, params);
    urlParams.set("table", "span");

    return `${this.buildExplorePath(organizationSlug, "traces")}?${urlParams.toString()}`;
  }

  /**
   * Builds a Logs Explorer URL using its logs-specific page parameters.
   * Sample and aggregate views use distinct field and sort parameters, and an
   * omitted project is represented by `project=-1` to preserve all-project scope.
   */
  private buildLogsExplorerUrl(params: ExplorerUrlParams): string {
    const { organizationSlug, query, projectId, fields, sort } = params;
    const urlParams = new URLSearchParams();

    urlParams.set("logsQuery", query);
    urlParams.set("project", projectId ?? "-1");

    const isAggregateQuery = this.isAggregateExplorerQuery(params);
    if (isAggregateQuery) {
      this.appendAggregateFields(urlParams, params);
    } else {
      for (const field of fields ?? []) {
        urlParams.append("logsFields", field);
      }
    }

    urlParams.set("mode", isAggregateQuery ? "aggregate" : "samples");
    if (sort) {
      urlParams.set(
        isAggregateQuery ? "logsAggregateSortBys" : "logsSortBys",
        sort,
      );
    }

    this.appendExplorerTimeParams(urlParams, params);
    return `${this.buildExplorePath(organizationSlug, "logs")}?${urlParams.toString()}`;
  }

  private extractTraceMetricsFromResults(
    eventData?: Record<string, unknown>[],
  ): TraceMetricIdentifier[] {
    const metrics = new Map<string, TraceMetricIdentifier>();

    for (const event of eventData ?? []) {
      const name = event["metric.name"];
      const type = event["metric.type"];
      const rawUnit = event["metric.unit"];

      if (typeof name !== "string" || typeof type !== "string") {
        continue;
      }

      const unit =
        typeof rawUnit === "string" && rawUnit !== "-" ? rawUnit : undefined;
      const key = `${name}|${type}|${unit ?? ""}`;

      if (!metrics.has(key)) {
        metrics.set(key, { name, type, unit });
      }
    }

    return [...metrics.values()];
  }

  /**
   * Generates a Sentry events explorer URL for viewing search results.
   *
   * Routes to the appropriate API based on dataset:
   * - Errors: Uses legacy Discover API
   * - Spans/Logs: Uses modern EAP (Event Analytics Platform) API
   * - Metrics: Uses the Metrics page URL format
   *
   * @param organizationSlug Organization identifier
   * @param query Sentry search query
   * @param projectId Optional project filter
   * @param dataset Dataset type (spans, errors, logs, or metrics)
   * @param fields Array of fields to include in results
   * @param sort Sort parameter (e.g., "-timestamp", "-count()")
   * @param aggregateFunctions Array of aggregate functions for aggregate queries
   * @param groupByFields Array of fields to group by for aggregate queries
   * @param statsPeriod Relative time period (e.g., "24h", "7d")
   * @param start Absolute start time (ISO 8601)
   * @param end Absolute end time (ISO 8601)
   * @param eventData Optional event rows used to derive trace metric identity for metrics sample URLs
   * @returns Full URL to the events explorer in Sentry UI
   */
  getEventsExplorerUrl(
    organizationSlug: string,
    query: string,
    projectId?: string,
    dataset: EventsDataset = "spans",
    fields?: string[],
    sort?: string,
    aggregateFunctions?: string[],
    groupByFields?: string[],
    statsPeriod?: string,
    start?: string,
    end?: string,
    eventData?: Record<string, unknown>[],
  ): string {
    if (dataset === "errors") {
      // Route to legacy Discover API
      return this.buildDiscoverUrl({
        organizationSlug,
        query,
        projectId,
        fields,
        sort,
        statsPeriod,
        start,
        end,
        aggregateFunctions,
        groupByFields,
      });
    }

    if (isMetricsDataset(dataset)) {
      return getTraceMetricsExploreUrl(
        this.host,
        organizationSlug,
        {
          query,
          projectId,
          sort,
          statsPeriod,
          start,
          end,
          aggregateFunctions,
          groupByFields,
          traceMetrics: this.extractTraceMetricsFromResults(eventData),
        },
        this.protocol,
      );
    }

    if (isProfilesDataset(dataset)) {
      return getProfilingExplorerUrl(
        this.host,
        organizationSlug,
        {
          query,
          projectId,
          fields,
          sort,
          statsPeriod,
          start,
          end,
          aggregateFunctions,
          groupByFields,
        },
        this.protocol,
      );
    }

    const explorerParams = {
      organizationSlug,
      query,
      projectId,
      fields,
      sort,
      statsPeriod,
      start,
      end,
      aggregateFunctions,
      groupByFields,
    };

    return dataset === "logs"
      ? this.buildLogsExplorerUrl(explorerParams)
      : this.buildSpansExplorerUrl(explorerParams);
  }

  /**
   * Retrieves the authenticated user's profile information.
   *
   * @param opts Request options including host override
   * @returns User profile data
   * @throws {ApiError} If authentication fails or user not found
   */
  async getAuthenticatedUser(opts?: RequestOptions): Promise<User> {
    // User identity belongs to the deployment's control host.
    let authHost: string | undefined;

    if (this.isPublicSaas()) {
      authHost = "sentry.io";
    }
    // Single-tenant and self-hosted deployments keep their configured host.

    const body = await this.requestJSON("/auth/", undefined, {
      ...opts,
      host: authHost,
    });
    return UserSchema.parse(body);
  }

  /**
   * Lists a page of organizations accessible to the authenticated user.
   *
   * Queries the `/organizations/` endpoint on the root host.
   *
   * @param params Query parameters
   * @param params.query Search query to filter organizations by name/slug
   * @param params.limit Maximum number of organizations to return (defaults to 25)
   * @param params.cursor Pagination cursor from a previous call's nextCursor
   * @returns A page of organizations across all accessible regions, plus a cursor for the next page (null once exhausted)
   *
   * @example
   * ```typescript
   * const { organizations } = await apiService.listOrganizations();
   * organizations.forEach(org => {
   *   // regionUrl present for Cloud Service, empty for self-hosted
   *   console.log(`${org.name} (${org.slug}) - ${org.links?.regionUrl || 'No region URL'}`);
   * });
   * ```
   */
  async listOrganizations(params?: {
    query?: string;
    limit?: number;
    cursor?: string | null;
  }): Promise<{ organizations: OrganizationList; nextCursor: string | null }> {
    const limit = params?.limit ?? 25;

    // Build query parameters
    const queryParams = new URLSearchParams();
    queryParams.set("per_page", String(limit));
    if (params?.query) {
      queryParams.set("query", params.query);
    }
    if (params?.cursor) {
      queryParams.set("cursor", params.cursor);
    }
    const queryString = queryParams.toString();
    const path = `/organizations/?${queryString}`;

    let host = undefined;
    // Public SaaS lists across regions on sentry.io; single-tenant instances
    // must keep organization discovery on their configured host.
    if (this.isPublicSaas()) {
      host = "sentry.io";
    }

    const response = await this.request(path, undefined, { host });
    const body = await this.parseJsonResponse(response);

    return {
      organizations: OrganizationListSchema.parse(body),
      nextCursor: getNextCursor(response.headers.get("link")),
    };
  }

  /**
   * Gets a single organization by slug.
   *
   * @param organizationSlug Organization identifier
   * @param params Query parameters
   * @param params.includeFeatureFlags Include `features` in the response (omitted by Sentry otherwise)
   * @param params.detailed Include projects and teams (Sentry defaults to true)
   * @param opts Request options including host override
   * @returns Organization data
   */
  async getOrganization(
    organizationSlug: string,
    params?: { includeFeatureFlags?: boolean; detailed?: boolean },
    opts?: RequestOptions,
  ) {
    const queryParams = new URLSearchParams();
    if (params?.includeFeatureFlags) {
      queryParams.set("include_feature_flags", "1");
    }
    if (params?.detailed === false) {
      queryParams.set("detailed", "0");
    }
    const queryString = queryParams.toString();
    const organizationPath = apiPath`/organizations/${organizationSlug}/`;
    const body = await this.requestJSON(
      `${organizationPath}${queryString ? `?${queryString}` : ""}`,
      undefined,
      opts,
    );
    return OrganizationSchema.parse(body);
  }

  /**
   * Lists a page of teams within an organization.
   *
   * @param organizationSlug Organization identifier
   * @param params Query parameters
   * @param params.query Search query to filter teams by name/slug
   * @param params.limit Maximum number of teams to return
   * @param params.cursor Pagination cursor from a previous call's nextCursor
   * @param opts Request options including host override
   * @returns A page of teams in the organization, plus a cursor for the next page (null once exhausted)
   */
  async listTeams(
    organizationSlug: string,
    params?: { query?: string; limit?: number; cursor?: string | null },
    opts?: RequestOptions,
  ): Promise<{ teams: TeamList; nextCursor: string | null }> {
    const queryParams = new URLSearchParams();
    queryParams.set("per_page", String(params?.limit ?? 25));
    if (params?.query) {
      queryParams.set("query", params.query);
    }
    if (params?.cursor) {
      queryParams.set("cursor", params.cursor);
    }
    const queryString = queryParams.toString();
    const teamsPath = apiPath`/organizations/${organizationSlug}/teams/`;
    const path = `${teamsPath}?${queryString}`;

    const response = await this.request(path, undefined, opts);
    const body = await this.parseJsonResponse(response);

    return {
      teams: TeamListSchema.parse(body),
      nextCursor: getNextCursor(response.headers.get("link")),
    };
  }

  /**
   * Creates a new team within an organization.
   *
   * @param params Team creation parameters
   * @param params.organizationSlug Organization identifier
   * @param params.name Team name
   * @param opts Request options
   * @returns Created team data
   * @throws {ApiError} If team creation fails (e.g., name conflicts)
   */
  async createTeam(
    {
      organizationSlug,
      name,
    }: {
      organizationSlug: string;
      name: string;
    },
    opts?: RequestOptions,
  ): Promise<Team> {
    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/teams/`,
      {
        method: "POST",
        body: JSON.stringify({ name }),
      },
      opts,
    );
    return TeamSchema.parse(body);
  }

  /**
   * Lists projects within an organization.
   *
   * @param organizationSlug Organization identifier
   * @param params Query parameters
   * @param params.query Search query to filter projects by name/slug
   * @param params.limit Maximum number of projects to return
   * @param params.cursor Pagination cursor from a previous call's nextCursor
   * @param opts Request options
   * @returns Projects in the organization, plus a cursor for the next page (null once exhausted)
   */
  async listProjects(
    organizationSlug: string,
    params?: { query?: string; limit?: number; cursor?: string | null },
    opts?: RequestOptions,
  ): Promise<{ projects: ProjectList; nextCursor: string | null }> {
    const queryParams = new URLSearchParams();
    queryParams.set("per_page", String(params?.limit ?? 25));
    if (params?.query) {
      queryParams.set("query", params.query);
    }
    if (params?.cursor) {
      queryParams.set("cursor", params.cursor);
    }
    const queryString = queryParams.toString();
    const projectsPath = apiPath`/organizations/${organizationSlug}/projects/`;
    const path = `${projectsPath}?${queryString}`;

    const response = await this.request(path, undefined, opts);
    const body = await this.parseJsonResponse(response);

    return {
      projects: ProjectListSchema.parse(body),
      nextCursor: getNextCursor(response.headers.get("link")),
    };
  }

  async listDashboards(
    {
      organizationSlug,
      query,
      sortBy,
      limit = 10,
      cursor,
    }: {
      organizationSlug: string;
      query?: string | null;
      sortBy?: "title" | "-title" | "dateCreated" | "-dateCreated";
      limit?: number;
      cursor?: string | null;
    },
    opts?: RequestOptions,
  ): Promise<{ dashboards: DashboardListItem[]; nextCursor: string | null }> {
    const queryParams = new URLSearchParams();
    queryParams.set("per_page", String(limit));
    if (query) {
      queryParams.set("query", query);
    }
    if (sortBy) {
      queryParams.set("sort", sortBy);
    }
    if (cursor) {
      queryParams.set("cursor", cursor);
    }

    const response = await this.request(
      apiPath`/organizations/${organizationSlug}/dashboards/` +
        `?${queryParams.toString()}`,
      undefined,
      opts,
    );
    const body = await this.parseJsonResponse(response);

    return {
      dashboards: DashboardListSchema.parse(body),
      nextCursor: getNextCursor(response.headers.get("link")),
    };
  }

  async getDashboard(
    {
      organizationSlug,
      dashboardId,
    }: {
      organizationSlug: string;
      dashboardId: string;
    },
    opts?: RequestOptions,
  ): Promise<Dashboard> {
    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/dashboards/${dashboardId}/`,
      undefined,
      opts,
    );
    return DashboardSchema.parse(body);
  }

  /**
   * Gets a single project by slug or ID.
   *
   * @param params Project fetch parameters
   * @param params.organizationSlug Organization identifier
   * @param params.projectSlugOrId Project slug or numeric ID
   * @param opts Request options
   * @returns Project data
   */
  async getProject(
    {
      organizationSlug,
      projectSlugOrId,
    }: {
      organizationSlug: string;
      projectSlugOrId: string;
    },
    opts?: RequestOptions,
  ): Promise<Project> {
    const body = await this.requestJSON(
      apiPath`/projects/${organizationSlug}/${projectSlugOrId}/`,
      undefined,
      opts,
    );
    return ProjectSchema.parse(body);
  }

  /**
   * Creates a new project within a team.
   *
   * @param params Project creation parameters
   * @param params.organizationSlug Organization identifier
   * @param params.teamSlug Team identifier
   * @param params.name Project name
   * @param params.slug Optional project slug
   * @param params.platform Platform identifier (e.g., "javascript", "python")
   * @param opts Request options
   * @returns Created project data
   */
  async createProject(
    {
      organizationSlug,
      teamSlug,
      name,
      slug,
      platform,
    }: {
      organizationSlug: string;
      teamSlug: string;
      name: string;
      slug?: string | null;
      platform?: string | null;
    },
    opts?: RequestOptions,
  ): Promise<Project> {
    const createData: CreateProjectRequest = { name };
    // Only include optional fields when they have meaningful values.
    if (slug) {
      createData.slug = slug;
    }
    if (platform) {
      createData.platform = platform;
    }

    const body = await this.requestJSON(
      apiPath`/teams/${organizationSlug}/${teamSlug}/projects/`,
      {
        method: "POST",
        body: JSON.stringify(createData),
      },
      opts,
    );
    return ProjectSchema.parse(body);
  }

  /**
   * Updates an existing project's configuration.
   *
   * @param params Project update parameters
   * @param params.organizationSlug Organization identifier
   * @param params.projectSlug Current project identifier
   * @param params.name New project name (optional)
   * @param params.slug New project slug (optional)
   * @param params.platform New platform identifier (optional)
   * @param opts Request options
   * @returns Updated project data
   */
  async updateAgenticOnboardingStatus(
    {
      organizationSlug,
      update,
    }: {
      organizationSlug: string;
      update: AgenticOnboardingStatusUpdate;
    },
    opts?: RequestOptions,
  ): Promise<AgenticOnboardingRun> {
    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/onboarding/agent/status/`,
      {
        method: "POST",
        body: JSON.stringify(update),
      },
      opts,
    );

    return AgenticOnboardingRunSchema.parse(body);
  }

  async updateProject(
    {
      organizationSlug,
      projectSlug,
      name,
      slug,
      platform,
    }: {
      organizationSlug: string;
      projectSlug: string;
      name?: string | null;
      slug?: string | null;
      platform?: string | null;
    },
    opts?: RequestOptions,
  ): Promise<Project> {
    const updateData: UpdateProjectRequest = {};
    // Only include fields that have meaningful values (truthy strings)
    if (name) updateData.name = name;
    if (slug) updateData.slug = slug;
    if (platform) updateData.platform = platform;

    const body = await this.requestJSON(
      apiPath`/projects/${organizationSlug}/${projectSlug}/`,
      {
        method: "PUT",
        body: JSON.stringify(updateData),
      },
      opts,
    );
    return ProjectSchema.parse(body);
  }

  async listRepos(
    {
      organizationSlug,
      query,
    }: {
      organizationSlug: string;
      query?: string;
    },
    opts?: RequestOptions,
  ) {
    let cursor: string | null = null;
    const repos: z.infer<typeof RepositoryListSchema> = [];

    do {
      const params = new URLSearchParams();
      params.set("per_page", "100");
      if (query) {
        params.set("query", query);
      }
      if (cursor) {
        params.set("cursor", cursor);
      }

      const response = await this.request(
        apiPath`/organizations/${organizationSlug}/repos/` +
          `?${params.toString()}`,
        { method: "GET" },
        opts,
      );
      const body = await this.parseJsonResponse(response);
      repos.push(...RepositoryListSchema.parse(body));
      cursor = getNextCursor(response.headers.get("link"));
    } while (cursor);

    return repos;
  }

  async linkProjectRepository(
    {
      organizationSlug,
      projectSlug,
      repository,
      provider,
    }: {
      organizationSlug: string;
      projectSlug: string;
      repository: string;
      provider?: string | null;
    },
    opts?: RequestOptions,
  ) {
    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/code-mappings/bulk/`,
      {
        method: "POST",
        body: JSON.stringify({
          project: projectSlug,
          repository,
          provider,
          mappings: [
            {
              stackRoot: "",
              sourceRoot: "",
            },
          ],
        }),
      },
      opts,
    );
    return ProjectRepositoryMappingSchema.parse(body);
  }

  async listIssueAlertRules(
    params: {
      organizationSlug: string;
      projectSlug?: string;
      query?: string;
      cursor?: string;
      limit?: number;
    },
    opts?: RequestOptions,
  ): Promise<IssueAlertRuleList> {
    const page = await this.listIssueAlertRulesPage(params, opts);
    return page.rules;
  }

  async listIssueAlertRulesPage(
    {
      organizationSlug,
      projectSlug,
      query,
      cursor,
      limit,
    }: {
      organizationSlug: string;
      projectSlug?: string;
      query?: string;
      cursor?: string;
      limit?: number;
    },
    opts?: RequestOptions,
  ): Promise<{ rules: IssueAlertRuleList; nextCursor: string | null }> {
    const searchQuery = new URLSearchParams({ sortBy: "-id" });
    if (projectSlug) {
      searchQuery.set("projectSlug", projectSlug);
    }
    if (query) {
      searchQuery.set("query", formatWorkflowNameQuery(query));
    }
    if (cursor) {
      searchQuery.set("cursor", cursor);
    }
    if (limit !== undefined) {
      searchQuery.set("per_page", String(limit));
    }

    const response = await this.request(
      apiPath`/organizations/${organizationSlug}/workflows/` +
        `?${searchQuery.toString()}`,
      undefined,
      opts,
    );
    const rules = IssueAlertRuleListSchema.parse(
      await this.parseJsonResponse(response),
    );
    const targetLimit = limit ?? 100;
    return {
      rules: rules.slice(0, targetLimit),
      nextCursor:
        rules.length > targetLimit
          ? null
          : getNextCursor(response.headers.get("link")),
    };
  }

  async getIssueAlertRule(
    {
      organizationSlug,
      projectSlug,
      ruleId,
    }: {
      organizationSlug: string;
      projectSlug?: string;
      ruleId: string | number;
    },
    opts?: RequestOptions,
  ): Promise<IssueAlertRule> {
    // Workflow list ID filters override project filters. Verify the association explicitly.
    if (projectSlug) {
      const [project, scope] = await Promise.all([
        this.getProject(
          { organizationSlug, projectSlugOrId: projectSlug },
          opts,
        ),
        this.getAlertRuleProjectScope({ organizationSlug, ruleId }, opts),
      ]);
      if (
        !scope.includesAllProjects &&
        !scope.projectIds.includes(String(project.id))
      ) {
        throw new ApiNotFoundError(
          "Workflow not found in this project",
          undefined,
          undefined,
          "workflow",
          String(ruleId),
        );
      }
    }

    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/workflows/${ruleId}/`,
      undefined,
      opts,
    );
    return IssueAlertRuleSchema.parse(body);
  }

  /** Private Sentry endpoint: keep the complete association check separate from filtered lists. */
  async getAlertRuleProjectScope(
    {
      organizationSlug,
      ruleId,
    }: { organizationSlug: string; ruleId: string | number },
    opts?: RequestOptions,
  ): Promise<AlertRuleProjectScope> {
    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/workflows/${ruleId}/project-scope/`,
      undefined,
      opts,
    );
    return AlertRuleProjectScopeSchema.parse(body);
  }

  async getDetectorForAlertRule(
    {
      organizationSlug,
      alertRuleId,
    }: { organizationSlug: string; alertRuleId: string | number },
    opts?: RequestOptions,
  ): Promise<string> {
    const query = new URLSearchParams({ alert_rule_id: String(alertRuleId) });
    const body = await this.requestJSON(
      `${apiPath`/organizations/${organizationSlug}/alert-rule-detector/`}?${query}`,
      undefined,
      opts,
    );
    return z.object({ detectorId: z.string() }).parse(body).detectorId;
  }

  async getDetector(
    {
      organizationSlug,
      detectorId,
    }: { organizationSlug: string; detectorId: string | number },
    opts?: RequestOptions,
  ): Promise<Detector> {
    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/detectors/${detectorId}/`,
      undefined,
      opts,
    );
    return DetectorSchema.parse(body);
  }

  async createMetricMonitor(
    {
      organizationSlug,
      projectSlug,
      body,
    }: {
      organizationSlug: string;
      projectSlug: string;
      body: MetricMonitorCreate;
    },
    opts?: RequestOptions,
  ): Promise<Detector> {
    const response = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/projects/${projectSlug}/detectors/`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      opts,
    );
    return DetectorSchema.parse(response);
  }

  async updateMetricMonitor(
    {
      organizationSlug,
      monitorId,
      body,
    }: {
      organizationSlug: string;
      monitorId: string | number;
      body: MetricMonitorUpdate;
    },
    opts?: RequestOptions,
  ): Promise<Detector> {
    const response = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/detectors/${monitorId}/`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
      opts,
    );
    return DetectorSchema.parse(response);
  }

  async deleteMetricMonitor(
    {
      organizationSlug,
      monitorId,
    }: {
      organizationSlug: string;
      monitorId: string | number;
    },
    opts?: RequestOptions,
  ): Promise<void> {
    await this.request(
      apiPath`/organizations/${organizationSlug}/detectors/${monitorId}/`,
      { method: "DELETE" },
      opts,
    );
  }

  async listDetectorsPage(
    {
      organizationSlug,
      projectId,
      types,
      query,
      cursor,
      limit = 25,
    }: {
      organizationSlug: string;
      projectId?: string;
      types?: string[];
      query?: string;
      cursor?: string;
      limit?: number;
    },
    opts?: RequestOptions,
  ): Promise<{ detectors: Detector[]; nextCursor: string | null }> {
    const search = new URLSearchParams({
      project: projectId ?? "-1",
      per_page: String(limit),
    });
    for (const type of types ?? []) {
      search.append("type", type);
    }
    if (query) search.set("query", query);
    if (cursor) search.set("cursor", cursor);
    const response = await this.request(
      `${apiPath`/organizations/${organizationSlug}/detectors/`}?${search}`,
      undefined,
      opts,
    );
    return {
      detectors: z
        .array(DetectorSchema)
        .parse(await this.parseJsonResponse(response)),
      nextCursor: getNextCursor(response.headers.get("link")),
    };
  }

  async listAvailableAlertActionsPage(
    {
      organizationSlug,
      types,
      cursor,
      limit = 25,
    }: {
      organizationSlug: string;
      types?: string[];
      cursor?: string;
      limit?: number;
    },
    opts?: RequestOptions,
  ): Promise<{ actions: AlertActionOption[]; nextCursor: string | null }> {
    const search = new URLSearchParams({ per_page: String(limit) });
    for (const type of types ?? []) {
      search.append("type", type);
    }
    if (cursor) search.set("cursor", cursor);
    const response = await this.request(
      `${apiPath`/organizations/${organizationSlug}/available-actions/`}?${search}`,
      undefined,
      opts,
    );
    return {
      actions: z
        .array(AlertActionOptionSchema)
        .parse(await this.parseJsonResponse(response)),
      nextCursor: getNextCursor(response.headers.get("link")),
    };
  }

  async listAlertConditionsPage(
    {
      organizationSlug,
      group,
      cursor,
      limit = 25,
    }: {
      organizationSlug: string;
      group: "workflow_trigger" | "action_filter";
      cursor?: string;
      limit?: number;
    },
    opts?: RequestOptions,
  ): Promise<{
    conditions: AlertConditionOption[];
    nextCursor: string | null;
  }> {
    const search = new URLSearchParams({ group, per_page: String(limit) });
    if (cursor) search.set("cursor", cursor);
    const response = await this.request(
      `${apiPath`/organizations/${organizationSlug}/data-conditions/`}?${search}`,
      undefined,
      opts,
    );
    return {
      conditions: z
        .array(AlertConditionOptionSchema)
        .parse(await this.parseJsonResponse(response)),
      nextCursor: getNextCursor(response.headers.get("link")),
    };
  }

  async createAlertRule(
    {
      organizationSlug,
      body,
    }: {
      organizationSlug: string;
      body: AlertRuleCreate;
    },
    opts?: RequestOptions,
  ): Promise<IssueAlertRule> {
    const response = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/workflows/`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      opts,
    );
    return IssueAlertRuleSchema.parse(response);
  }

  async updateAlertRule(
    {
      organizationSlug,
      ruleId,
      body,
    }: {
      organizationSlug: string;
      ruleId: string | number;
      body: AlertRuleUpdate;
    },
    opts?: RequestOptions,
  ): Promise<IssueAlertRule> {
    const response = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/workflows/${ruleId}/`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
      opts,
    );
    return IssueAlertRuleSchema.parse(response);
  }

  async deleteAlertRule(
    {
      organizationSlug,
      ruleId,
    }: {
      organizationSlug: string;
      ruleId: string | number;
    },
    opts?: RequestOptions,
  ): Promise<void> {
    await this.request(
      apiPath`/organizations/${organizationSlug}/workflows/${ruleId}/`,
      { method: "DELETE" },
      opts,
    );
  }

  async listMetricAlertRules(
    params: {
      organizationSlug: string;
      projectSlug?: string;
      query?: string;
      cursor?: string;
      limit?: number;
    },
    opts?: RequestOptions,
  ): Promise<MetricAlertRuleList> {
    const page = await this.listMetricAlertRulesPage(params, opts);
    return page.rules;
  }

  async listMetricAlertRulesPage(
    {
      organizationSlug,
      projectSlug,
      query,
      cursor,
      limit,
    }: {
      organizationSlug: string;
      projectSlug?: string;
      query?: string;
      cursor?: string;
      limit?: number;
    },
    opts?: RequestOptions,
  ): Promise<{ rules: MetricAlertRuleList; nextCursor: string | null }> {
    const project = projectSlug
      ? await this.getProject(
          {
            organizationSlug,
            projectSlugOrId: projectSlug,
          },
          opts,
        )
      : undefined;

    if (query) {
      const body = await this.listCombinedAlertRules(
        {
          organizationSlug,
          name: query,
          alertType: "alert_rule",
          projectId: project?.id,
          cursor,
          limit,
        },
        opts,
      );
      return {
        rules: MetricAlertRuleListSchema.parse(body.data),
        nextCursor: body.nextCursor,
      };
    }

    const searchQuery = new URLSearchParams();
    if (cursor) {
      searchQuery.set("cursor", cursor);
    }
    if (limit !== undefined) {
      searchQuery.set("per_page", String(limit));
    }
    if (project) {
      searchQuery.set("project", String(project.id));
    }

    const queryString = searchQuery.toString();
    const path = apiPath`/organizations/${organizationSlug}/alert-rules/`;
    const response = await this.request(
      `${path}${queryString ? `?${queryString}` : ""}`,
      undefined,
      opts,
    );
    const body = await this.parseJsonResponse(response);
    return {
      rules: MetricAlertRuleListSchema.parse(body),
      nextCursor: getNextCursor(response.headers.get("link")),
    };
  }

  async getMetricAlertRule(
    {
      organizationSlug,
      ruleId,
    }: {
      organizationSlug: string;
      ruleId: string | number;
    },
    opts?: RequestOptions,
  ): Promise<MetricAlertRule> {
    const path = apiPath`/organizations/${organizationSlug}/alert-rules/${ruleId}/`;
    const body = await this.requestJSON(path, undefined, opts);
    return MetricAlertRuleSchema.parse(body);
  }

  /**
   * Uses Sentry's combined-rules endpoint for metric alert name search.
   */
  private async listCombinedAlertRules(
    {
      organizationSlug,
      name,
      alertType,
      projectId,
      cursor,
      limit,
    }: {
      organizationSlug: string;
      name: string;
      alertType: "alert_rule";
      projectId?: string | number;
      cursor?: string;
      limit?: number;
    },
    opts?: RequestOptions,
  ): Promise<{ data: unknown; nextCursor: string | null }> {
    const searchQuery = new URLSearchParams();
    searchQuery.set("name", name);
    searchQuery.append("alertType", alertType);
    if (projectId !== undefined) {
      searchQuery.append("project", String(projectId));
    }
    if (cursor) {
      searchQuery.set("cursor", cursor);
    }
    if (limit !== undefined) {
      searchQuery.set("per_page", String(limit));
    }

    const response = await this.request(
      apiPath`/organizations/${organizationSlug}/combined-rules/` +
        `?${searchQuery.toString()}`,
      undefined,
      opts,
    );
    return {
      data: await this.parseJsonResponse(response),
      nextCursor: getNextCursor(response.headers.get("link")),
    };
  }

  /**
   * Lists teams assigned to a project.
   *
   * @param params Query parameters
   * @param params.organizationSlug Organization identifier
   * @param params.projectSlug Project identifier
   * @param opts Request options
   * @returns Array of teams assigned to the project
   */
  async listProjectTeams(
    {
      organizationSlug,
      projectSlug,
    }: {
      organizationSlug: string;
      projectSlug: string;
    },
    opts?: RequestOptions,
  ): Promise<TeamList> {
    const teams: TeamList = [];
    let cursor: string | null = null;

    do {
      const queryParams = new URLSearchParams();
      queryParams.set("per_page", "100");
      if (cursor) {
        queryParams.set("cursor", cursor);
      }

      const response = await this.request(
        apiPath`/projects/${organizationSlug}/${projectSlug}/teams/` +
          `?${queryParams.toString()}`,
        undefined,
        opts,
      );
      const body = await this.parseJsonResponse(response);
      teams.push(...TeamListSchema.parse(body));
      cursor = getNextCursor(response.headers.get("link"));
    } while (cursor);

    return teams;
  }

  /**
   * Assigns a team to a project.
   *
   * @param params Assignment parameters
   * @param params.organizationSlug Organization identifier
   * @param params.projectSlug Project identifier
   * @param params.teamSlug Team identifier to assign
   * @param opts Request options
   */
  async addTeamToProject(
    {
      organizationSlug,
      projectSlug,
      teamSlug,
    }: {
      organizationSlug: string;
      projectSlug: string;
      teamSlug: string;
    },
    opts?: RequestOptions,
  ): Promise<void> {
    await this.request(
      apiPath`/projects/${organizationSlug}/${projectSlug}/teams/${teamSlug}/`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      opts,
    );
  }

  /**
   * Removes a team from a project.
   *
   * @param params Assignment parameters
   * @param params.organizationSlug Organization identifier
   * @param params.projectSlug Project identifier
   * @param params.teamSlug Team identifier to remove
   * @param opts Request options
   */
  async removeTeamFromProject(
    {
      organizationSlug,
      projectSlug,
      teamSlug,
    }: {
      organizationSlug: string;
      projectSlug: string;
      teamSlug: string;
    },
    opts?: RequestOptions,
  ): Promise<void> {
    await this.request(
      apiPath`/projects/${organizationSlug}/${projectSlug}/teams/${teamSlug}/`,
      {
        method: "DELETE",
      },
      opts,
    );
  }

  /**
   * Creates a new client key (DSN) for a project.
   *
   * Client keys are used to identify and authenticate SDK requests to Sentry.
   *
   * @param params Key creation parameters
   * @param params.organizationSlug Organization identifier
   * @param params.projectSlug Project identifier
   * @param params.name Human-readable name for the key (optional)
   * @param opts Request options
   * @returns Created client key with DSN information
   *
   * @example
   * ```typescript
   * const key = await apiService.createClientKey({
   *   organizationSlug: "my-org",
   *   projectSlug: "my-project",
   *   name: "Production"
   * });
   * console.log(`DSN: ${key.dsn.public}`);
   * ```
   */
  async createClientKey(
    {
      organizationSlug,
      projectSlug,
      name,
    }: {
      organizationSlug: string;
      projectSlug: string;
      name?: string;
    },
    opts?: RequestOptions,
  ): Promise<ClientKey> {
    const body = await this.requestJSON(
      apiPath`/projects/${organizationSlug}/${projectSlug}/keys/`,
      {
        method: "POST",
        body: JSON.stringify({
          name,
        }),
      },
      opts,
    );
    return ClientKeySchema.parse(body);
  }

  /**
   * Updates a client key (DSN) for a project.
   *
   * @param params Key update parameters
   * @param params.organizationSlug Organization identifier
   * @param params.projectSlug Project identifier
   * @param params.keyId The ID of the key to update
   * @param params.name Human-readable name for the key (optional)
   * @param params.isActive Activate or deactivate the client key (optional)
   * @param params.rateLimit Applies a rate limit to cap the number of errors accepted during a given time window (optional, null to disable)
   * @param params.browserSdkVersion Sentry Javascript SDK version to use (optional)
   * @param params.dynamicSdkLoaderOptions Configures options for the Javascript Loader Script (optional)
   * @param opts Request options
   * @returns Updated client key with DSN information
   */
  async updateClientKey(
    {
      organizationSlug,
      projectSlug,
      keyId,
      name,
      isActive,
      rateLimit,
      browserSdkVersion,
      dynamicSdkLoaderOptions,
    }: {
      organizationSlug: string;
      projectSlug: string;
      keyId: string | number;
    } & UpdateClientKeyRequest,
    opts?: RequestOptions,
  ): Promise<ClientKey> {
    const updateData: UpdateClientKeyRequest = {};
    if (name !== undefined) {
      updateData.name = name;
    }
    if (isActive !== undefined) {
      updateData.isActive = isActive;
    }
    if (rateLimit !== undefined) {
      updateData.rateLimit = rateLimit;
    }
    if (browserSdkVersion !== undefined) {
      updateData.browserSdkVersion = browserSdkVersion;
    }
    if (dynamicSdkLoaderOptions !== undefined) {
      updateData.dynamicSdkLoaderOptions = dynamicSdkLoaderOptions;
    }

    const body = await this.requestJSON(
      apiPath`/projects/${organizationSlug}/${projectSlug}/keys/${keyId}/`,
      {
        method: "PUT",
        body: JSON.stringify(updateData),
      },
      opts,
    );
    return ClientKeySchema.parse(body);
  }

  /**
   * Lists all client keys (DSNs) for a project.
   *
   * @param params Query parameters
   * @param params.organizationSlug Organization identifier
   * @param params.projectSlug Project identifier
   * @param opts Request options
   * @returns Array of client keys with DSN information
   */
  async listClientKeys(
    {
      organizationSlug,
      projectSlug,
    }: {
      organizationSlug: string;
      projectSlug: string;
    },
    opts?: RequestOptions,
  ): Promise<ClientKeyList> {
    const body = await this.requestJSON(
      apiPath`/projects/${organizationSlug}/${projectSlug}/keys/`,
      undefined,
      opts,
    );
    return ClientKeyListSchema.parse(body);
  }

  /**
   * Lists releases for an organization or specific project.
   *
   * @param params Query parameters
   * @param params.organizationSlug Organization identifier
   * @param params.projectSlug Project identifier (optional, scopes to specific project)
   * @param params.query Search query for filtering releases
   * @param opts Request options
   * @returns Array of releases with deployment and commit information
   *
   * @example
   * ```typescript
   * // All releases for organization
   * const releases = await apiService.listReleases({
   *   organizationSlug: "my-org"
   * });
   *
   * // Search for specific version
   * const filtered = await apiService.listReleases({
   *   organizationSlug: "my-org",
   *   query: "v1.2.3"
   * });
   * ```
   */
  async listReleases(
    {
      organizationSlug,
      projectSlug,
      query,
      limit,
    }: {
      organizationSlug: string;
      projectSlug?: string;
      query?: string;
      limit?: number;
    },
    opts?: RequestOptions,
  ): Promise<ReleaseList> {
    const searchQuery = new URLSearchParams();
    if (query) {
      searchQuery.set("query", query);
    }
    if (limit !== undefined) {
      searchQuery.set("per_page", String(limit));
    }

    const path = projectSlug
      ? apiPath`/projects/${organizationSlug}/${projectSlug}/releases/`
      : apiPath`/organizations/${organizationSlug}/releases/`;

    const body = await this.requestJSON(
      searchQuery.toString() ? `${path}?${searchQuery.toString()}` : path,
      undefined,
      opts,
    );
    return ReleaseListSchema.parse(body);
  }

  async getReleaseDetails(
    {
      organizationSlug,
      releaseVersion,
      projectSlugOrId,
      includeHealth,
    }: {
      organizationSlug: string;
      releaseVersion: string;
      projectSlugOrId?: string;
      includeHealth?: boolean;
    },
    opts?: RequestOptions,
  ): Promise<ReleaseDetails> {
    const searchQuery = new URLSearchParams();
    if (includeHealth) {
      searchQuery.set("health", "1");
    }

    const path = projectSlugOrId
      ? apiPath`/projects/${organizationSlug}/${projectSlugOrId}/releases/${releaseVersion}/`
      : apiPath`/organizations/${organizationSlug}/releases/${releaseVersion}/`;
    const body = await this.requestJSON(
      searchQuery.toString() ? `${path}?${searchQuery.toString()}` : path,
      undefined,
      opts,
    );
    return ReleaseDetailsSchema.parse(body);
  }

  async listReleaseDeploys(
    {
      organizationSlug,
      releaseVersion,
      projectSlugOrId,
      limit,
    }: {
      organizationSlug: string;
      releaseVersion: string;
      projectSlugOrId?: string;
      limit?: number;
    },
    opts?: RequestOptions,
  ): Promise<DeployList> {
    const searchQuery = new URLSearchParams();
    if (projectSlugOrId) {
      searchQuery.set(
        isNumericId(projectSlugOrId) ? "project" : "projectSlug",
        projectSlugOrId,
      );
    }
    if (limit !== undefined) {
      searchQuery.set("per_page", String(limit));
    }

    const path = apiPath`/organizations/${organizationSlug}/releases/${releaseVersion}/deploys/`;
    const body = await this.requestJSON(
      searchQuery.toString() ? `${path}?${searchQuery.toString()}` : path,
      undefined,
      opts,
    );
    return DeployListSchema.parse(body);
  }

  async listReleaseCommits(
    {
      organizationSlug,
      releaseVersion,
      projectSlugOrId,
      limit,
    }: {
      organizationSlug: string;
      releaseVersion: string;
      projectSlugOrId?: string;
      limit?: number;
    },
    opts?: RequestOptions,
  ): Promise<CommitList> {
    const searchQuery = new URLSearchParams();
    if (limit !== undefined) {
      searchQuery.set("per_page", String(limit));
    }

    const path = projectSlugOrId
      ? apiPath`/projects/${organizationSlug}/${projectSlugOrId}/releases/${releaseVersion}/commits/`
      : apiPath`/organizations/${organizationSlug}/releases/${releaseVersion}/commits/`;
    const body = await this.requestJSON(
      searchQuery.toString() ? `${path}?${searchQuery.toString()}` : path,
      undefined,
      opts,
    );
    return CommitListSchema.parse(body);
  }

  /**
   * Retrieves the current suspect commit for the event's issue, grouped by committer.
   * This reflects the issue's current suspect commit, not its state when the event occurred.
   * Unlike release commits, this response actually populates `suspectCommitType`.
   */
  async getEventCommitters(
    {
      organizationSlug,
      projectSlug,
      eventId,
    }: {
      organizationSlug: string;
      projectSlug: string;
      eventId: string;
    },
    opts?: RequestOptions,
  ): Promise<CommitterList> {
    const body = await this.requestJSON(
      apiPath`/projects/${organizationSlug}/${projectSlug}/events/${eventId}/committers/`,
      undefined,
      opts,
    );
    return CommittersResponseSchema.parse(body).committers;
  }

  async listMonitors(
    {
      organizationSlug,
      projectSlug,
      environment,
      owner,
      query,
      limit,
    }: {
      organizationSlug: string;
      projectSlug?: string;
      environment?: string;
      owner?: string;
      query?: string;
      limit?: number;
    },
    opts?: RequestOptions,
  ): Promise<MonitorList> {
    const searchQuery = new URLSearchParams();
    if (projectSlug) {
      searchQuery.append("projectSlug", projectSlug);
    }
    if (environment) {
      searchQuery.append("environment", environment);
    }
    if (owner) {
      searchQuery.append("owner", owner);
    }
    if (query) {
      searchQuery.set("query", query);
    }
    if (limit !== undefined) {
      searchQuery.set("per_page", String(limit));
    }

    const body = await this.requestJSON(
      searchQuery.toString()
        ? apiPath`/organizations/${organizationSlug}/monitors/` +
            `?${searchQuery.toString()}`
        : apiPath`/organizations/${organizationSlug}/monitors/`,
      undefined,
      opts,
    );
    return MonitorListSchema.parse(body);
  }

  async getMonitorDetails(
    {
      organizationSlug,
      projectSlug,
      monitorSlug,
      environment,
    }: {
      organizationSlug: string;
      projectSlug?: string;
      monitorSlug: string;
      environment?: string;
    },
    opts?: RequestOptions,
  ): Promise<Monitor> {
    const searchQuery = new URLSearchParams();
    if (environment) {
      searchQuery.append("environment", environment);
    }

    const path = projectSlug
      ? apiPath`/projects/${organizationSlug}/${projectSlug}/monitors/${monitorSlug}/`
      : apiPath`/organizations/${organizationSlug}/monitors/${monitorSlug}/`;
    const body = await this.requestJSON(
      searchQuery.toString() ? `${path}?${searchQuery.toString()}` : path,
      undefined,
      opts,
    );
    return MonitorSchema.parse(body);
  }

  async listMonitorCheckIns(
    {
      organizationSlug,
      projectSlug,
      monitorSlug,
      environment,
      statsPeriod,
      start,
      end,
      limit,
    }: {
      organizationSlug: string;
      projectSlug?: string;
      monitorSlug: string;
      environment?: string;
      statsPeriod?: string;
      start?: string;
      end?: string;
      limit?: number;
    },
    opts?: RequestOptions,
  ): Promise<MonitorCheckInList> {
    const searchQuery = new URLSearchParams();
    if (environment) {
      searchQuery.append("environment", environment);
    }
    if (limit !== undefined) {
      searchQuery.set("per_page", String(limit));
    }
    const normalizedStatsPeriod = normalizeStatsPeriod(statsPeriod);
    const effectiveStatsPeriod =
      start || end ? normalizedStatsPeriod : (normalizedStatsPeriod ?? "24h");
    if (effectiveStatsPeriod) {
      parseStatsPeriod(effectiveStatsPeriod);
    }
    this.applyTimeParams(searchQuery, effectiveStatsPeriod, start, end);

    const path = projectSlug
      ? apiPath`/projects/${organizationSlug}/${projectSlug}/monitors/${monitorSlug}/checkins/`
      : apiPath`/organizations/${organizationSlug}/monitors/${monitorSlug}/checkins/`;
    const body = await this.requestJSON(
      searchQuery.toString() ? `${path}?${searchQuery.toString()}` : path,
      undefined,
      opts,
    );
    return MonitorCheckInListSchema.parse(body);
  }

  async getMonitorStats(
    {
      organizationSlug,
      projectSlug,
      monitorSlug,
      environment,
      statsPeriod,
      start,
      end,
      rollup,
    }: {
      organizationSlug: string;
      projectSlug?: string;
      monitorSlug: string;
      environment?: string;
      statsPeriod?: string;
      start?: string;
      end?: string;
      rollup?: number;
    },
    opts?: RequestOptions,
  ): Promise<MonitorStats> {
    const searchQuery = new URLSearchParams();
    if (environment) {
      searchQuery.append("environment", environment);
    }
    const normalizedStatsPeriod = normalizeStatsPeriod(statsPeriod);
    const effectiveStatsPeriod =
      start || end ? normalizedStatsPeriod : (normalizedStatsPeriod ?? "24h");
    this.applyStatsMixinTimeParams(
      searchQuery,
      effectiveStatsPeriod,
      start,
      end,
      rollup,
    );

    const path = projectSlug
      ? apiPath`/projects/${organizationSlug}/${projectSlug}/monitors/${monitorSlug}/stats/`
      : apiPath`/organizations/${organizationSlug}/monitors/${monitorSlug}/stats/`;
    const body = await this.requestJSON(
      searchQuery.toString() ? `${path}?${searchQuery.toString()}` : path,
      undefined,
      opts,
    );
    return MonitorStatsSchema.parse(body);
  }

  /**
   * List uptime monitors for an organization.
   *
   * GET /organizations/{org}/uptime/
   * Source: src/sentry/uptime/endpoints/organiation_uptime_alert_index.py
   */
  async listUptimeMonitors(
    {
      organizationSlug,
      projectSlug,
      environment,
      owner,
      query,
      limit,
    }: {
      organizationSlug: string;
      projectSlug?: string;
      environment?: string;
      owner?: string;
      query?: string;
      limit?: number;
    },
    opts?: RequestOptions,
  ): Promise<UptimeMonitorList> {
    const searchQuery = new URLSearchParams();
    if (projectSlug) {
      // OrganizationEndpoint filter params accept project IDs via `project`.
      const project = await this.getProject(
        {
          organizationSlug,
          projectSlugOrId: projectSlug,
        },
        opts,
      );
      searchQuery.append("project", String(project.id));
    }
    if (environment) {
      searchQuery.append("environment", environment);
    }
    if (owner) {
      searchQuery.append("owner", owner);
    }
    if (query) {
      searchQuery.set("query", query);
    }
    if (limit !== undefined) {
      searchQuery.set("per_page", String(limit));
    }

    const path = apiPath`/organizations/${organizationSlug}/uptime/`;
    const body = await this.requestJSON(
      searchQuery.toString() ? `${path}?${searchQuery.toString()}` : path,
      undefined,
      opts,
    );
    return UptimeMonitorListSchema.parse(body);
  }

  /**
   * Get a single uptime monitor.
   *
   * GET /projects/{org}/{project}/uptime/{id}/
   * Source: src/sentry/uptime/endpoints/project_uptime_alert_details.py
   */
  async getUptimeMonitorDetails(
    {
      organizationSlug,
      projectSlug,
      uptimeMonitorId,
    }: {
      organizationSlug: string;
      projectSlug: string;
      uptimeMonitorId: string;
    },
    opts?: RequestOptions,
  ): Promise<UptimeMonitor> {
    const body = await this.requestJSON(
      apiPath`/projects/${organizationSlug}/${projectSlug}/uptime/${uptimeMonitorId}/`,
      undefined,
      opts,
    );
    return UptimeMonitorSchema.parse(body);
  }

  /**
   * List recent uptime checks for a monitor.
   *
   * GET /projects/{org}/{project}/uptime/{id}/checks/
   * Source: src/sentry/uptime/endpoints/project_uptime_alert_checks_index.py
   */
  async listUptimeMonitorChecks(
    {
      organizationSlug,
      projectSlug,
      uptimeMonitorId,
      statsPeriod,
      start,
      end,
      limit,
    }: {
      organizationSlug: string;
      projectSlug: string;
      uptimeMonitorId: string;
      statsPeriod?: string;
      start?: string;
      end?: string;
      limit?: number;
    },
    opts?: RequestOptions,
  ): Promise<UptimeCheckList> {
    const searchQuery = new URLSearchParams();
    if (limit !== undefined) {
      searchQuery.set("per_page", String(limit));
    }
    const normalizedStatsPeriod = normalizeStatsPeriod(statsPeriod);
    const effectiveStatsPeriod =
      start || end ? normalizedStatsPeriod : (normalizedStatsPeriod ?? "24h");
    if (effectiveStatsPeriod) {
      parseStatsPeriod(effectiveStatsPeriod);
    }
    this.applyTimeParams(searchQuery, effectiveStatsPeriod, start, end);

    const path = apiPath`/projects/${organizationSlug}/${projectSlug}/uptime/${uptimeMonitorId}/checks/`;
    const body = await this.requestJSON(
      searchQuery.toString() ? `${path}?${searchQuery.toString()}` : path,
      undefined,
      opts,
    );
    return UptimeCheckListSchema.parse(body);
  }

  /**
   * Create an uptime monitor.
   *
   * POST /projects/{org}/{project}/uptime/
   * Source: src/sentry/uptime/endpoints/project_uptime_alert_index.py
   * Body fields verified from UptimeMonitorValidator (camelCase via CamelSnakeSerializer).
   */
  async createUptimeMonitor(
    {
      organizationSlug,
      projectSlug,
      name,
      url,
      intervalSeconds,
      timeoutMs,
      method,
      headers,
      body,
      assertion,
      status,
      owner,
      environment,
      traceSampling,
      responseCaptureEnabled,
      recoveryThreshold,
      downtimeThreshold,
    }: {
      organizationSlug: string;
      projectSlug: string;
      name: string;
      url: string;
      intervalSeconds: number;
      timeoutMs: number;
      method?: string;
      headers?: Array<[string, string]>;
      body?: string | null;
      assertion?: unknown | null;
      status?: "active" | "disabled";
      owner?: string | null;
      environment?: string | null;
      traceSampling?: boolean;
      responseCaptureEnabled?: boolean;
      recoveryThreshold?: number;
      downtimeThreshold?: number;
    },
    opts?: RequestOptions,
  ): Promise<UptimeMonitor> {
    const payload: Record<string, unknown> = {
      name,
      url,
      intervalSeconds,
      timeoutMs,
    };
    if (method !== undefined) payload.method = method;
    if (headers !== undefined) payload.headers = headers;
    if (body !== undefined) payload.body = body;
    if (assertion !== undefined) payload.assertion = assertion;
    if (status !== undefined) payload.status = status;
    if (owner !== undefined) payload.owner = owner;
    if (environment !== undefined) payload.environment = environment;
    if (traceSampling !== undefined) payload.traceSampling = traceSampling;
    if (responseCaptureEnabled !== undefined) {
      payload.responseCaptureEnabled = responseCaptureEnabled;
    }
    if (recoveryThreshold !== undefined) {
      payload.recoveryThreshold = recoveryThreshold;
    }
    if (downtimeThreshold !== undefined) {
      payload.downtimeThreshold = downtimeThreshold;
    }

    const responseBody = await this.requestJSON(
      apiPath`/projects/${organizationSlug}/${projectSlug}/uptime/`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      opts,
    );
    return UptimeMonitorSchema.parse(responseBody);
  }

  /**
   * Update an uptime monitor.
   *
   * PUT /projects/{org}/{project}/uptime/{id}/
   * Source: src/sentry/uptime/endpoints/project_uptime_alert_details.py
   */
  async updateUptimeMonitor(
    {
      organizationSlug,
      projectSlug,
      uptimeMonitorId,
      name,
      url,
      intervalSeconds,
      timeoutMs,
      method,
      headers,
      body,
      assertion,
      status,
      owner,
      environment,
      traceSampling,
      responseCaptureEnabled,
      recoveryThreshold,
      downtimeThreshold,
    }: {
      organizationSlug: string;
      projectSlug: string;
      uptimeMonitorId: string;
      name?: string;
      url?: string;
      intervalSeconds?: number;
      timeoutMs?: number;
      method?: string;
      headers?: Array<[string, string]>;
      body?: string | null;
      assertion?: unknown | null;
      status?: "active" | "disabled";
      owner?: string | null;
      environment?: string | null;
      traceSampling?: boolean;
      responseCaptureEnabled?: boolean;
      recoveryThreshold?: number;
      downtimeThreshold?: number;
    },
    opts?: RequestOptions,
  ): Promise<UptimeMonitor> {
    const payload: Record<string, unknown> = {};
    if (name !== undefined) payload.name = name;
    if (url !== undefined) payload.url = url;
    if (intervalSeconds !== undefined)
      payload.intervalSeconds = intervalSeconds;
    if (timeoutMs !== undefined) payload.timeoutMs = timeoutMs;
    if (method !== undefined) payload.method = method;
    if (headers !== undefined) payload.headers = headers;
    if (body !== undefined) payload.body = body;
    if (assertion !== undefined) payload.assertion = assertion;
    if (status !== undefined) payload.status = status;
    if (owner !== undefined) payload.owner = owner;
    if (environment !== undefined) payload.environment = environment;
    if (traceSampling !== undefined) payload.traceSampling = traceSampling;
    if (responseCaptureEnabled !== undefined) {
      payload.responseCaptureEnabled = responseCaptureEnabled;
    }
    if (recoveryThreshold !== undefined) {
      payload.recoveryThreshold = recoveryThreshold;
    }
    if (downtimeThreshold !== undefined) {
      payload.downtimeThreshold = downtimeThreshold;
    }

    const responseBody = await this.requestJSON(
      apiPath`/projects/${organizationSlug}/${projectSlug}/uptime/${uptimeMonitorId}/`,
      {
        method: "PUT",
        body: JSON.stringify(payload),
      },
      opts,
    );
    return UptimeMonitorSchema.parse(responseBody);
  }

  /**
   * Delete an uptime monitor.
   *
   * DELETE /projects/{org}/{project}/uptime/{id}/
   * Source: src/sentry/uptime/endpoints/project_uptime_alert_details.py
   * Returns 202 with empty body.
   */
  async deleteUptimeMonitor(
    {
      organizationSlug,
      projectSlug,
      uptimeMonitorId,
    }: {
      organizationSlug: string;
      projectSlug: string;
      uptimeMonitorId: string;
    },
    opts?: RequestOptions,
  ): Promise<void> {
    // Treat 404 as success so repeated deletes are idempotent.
    await this.request(
      apiPath`/projects/${organizationSlug}/${projectSlug}/uptime/${uptimeMonitorId}/`,
      {
        method: "DELETE",
      },
      { ...opts, allowStatuses: [404] },
    );
  }

  /**
   * Lists available tags for search queries.
   *
   * Tags represent indexed fields that can be used in Sentry search queries.
   *
   * @param params Query parameters
   * @param params.organizationSlug Organization identifier
   * @param params.dataset Dataset to query tags for ("events", "errors", "replays", or "search_issues")
   * @param params.project Numeric project ID to filter tags
   * @param params.statsPeriod Time range for tag statistics (e.g., "24h", "7d")
   * @param params.useCache Whether to use cached results
   * @param params.useFlagsBackend Whether to use flags backend features
   * @param opts Request options
   * @returns Array of available tags with metadata
   *
   * @example
   * ```typescript
   * const tags = await apiService.listTags({
   *   organizationSlug: "my-org",
   *   dataset: "events",
   *   project: "123456",
   *   statsPeriod: "24h",
   *   useCache: true
   * });
   * tags.forEach(tag => console.log(`${tag.key}: ${tag.name}`));
   * ```
   */
  async listTags(
    {
      organizationSlug,
      dataset,
      project,
      statsPeriod,
      start,
      end,
      useCache,
      useFlagsBackend,
    }: {
      organizationSlug: string;
      dataset?: "events" | "errors" | "replays" | "search_issues";
      project?: string;
      statsPeriod?: string;
      start?: string;
      end?: string;
      useCache?: boolean;
      useFlagsBackend?: boolean;
    },
    opts?: RequestOptions,
  ): Promise<TagList> {
    const searchQuery = new URLSearchParams();
    if (dataset) {
      searchQuery.set("dataset", dataset);
    }
    if (project) {
      searchQuery.set("project", project);
    }
    this.applyTimeParams(searchQuery, statsPeriod, start, end);
    if (useCache !== undefined) {
      searchQuery.set("useCache", useCache ? "1" : "0");
    }
    if (useFlagsBackend !== undefined) {
      searchQuery.set("useFlagsBackend", useFlagsBackend ? "1" : "0");
    }

    const body = await this.requestJSON(
      searchQuery.toString()
        ? apiPath`/organizations/${organizationSlug}/tags/` +
            `?${searchQuery.toString()}`
        : apiPath`/organizations/${organizationSlug}/tags/`,
      undefined,
      opts,
    );
    return TagListSchema.parse(body);
  }

  async searchReplays(
    {
      organizationSlug,
      query,
      limit,
      projectId,
      sort,
      environment,
      statsPeriod,
      start,
      end,
      fields,
    }: {
      organizationSlug: string;
      query?: string;
      limit?: number;
      projectId?: string;
      sort?: string;
      environment?: string | string[];
      statsPeriod?: string;
      start?: string;
      end?: string;
      fields?: string[];
    },
    opts?: RequestOptions,
  ): Promise<ReplayList> {
    const searchQuery = new URLSearchParams();

    if (query) {
      searchQuery.set("query", query);
    }
    if (limit !== undefined) {
      searchQuery.set("per_page", String(limit));
    }
    if (projectId) {
      searchQuery.append("project", projectId);
    }
    if (sort) {
      searchQuery.set("sort", sort);
    }
    if (environment) {
      const environments = Array.isArray(environment)
        ? environment
        : [environment];
      for (const value of environments) {
        searchQuery.append("environment", value);
      }
    }
    if (fields && fields.length > 0) {
      for (const field of fields) {
        searchQuery.append("field", field);
      }
    }
    this.applyTimeParams(searchQuery, statsPeriod, start, end);

    const body = await this.requestJSON(
      searchQuery.toString()
        ? apiPath`/organizations/${organizationSlug}/replays/` +
            `?${searchQuery.toString()}`
        : apiPath`/organizations/${organizationSlug}/replays/`,
      undefined,
      opts,
    );

    return ReplayListResponseSchema.parse(body).data;
  }

  /**
   * Lists trace item attributes available for search queries.
   *
   * Returns all available fields/attributes that can be used in event searches,
   * including both built-in fields and custom tags.
   *
   * @param params Query parameters
   * @param params.organizationSlug Organization identifier
   * @param params.itemType Item type to query attributes for ("spans", "logs", or "tracemetrics")
   * @param params.project Numeric project ID to filter attributes
   * @param params.statsPeriod Time range for attribute statistics (e.g., "24h", "7d")
   * @param params.attributeTypes Optional attribute types to keep in the response
   * @param opts Request options
   * @returns Array of available attributes with metadata including type
   */
  async listTraceItemAttributes(
    {
      organizationSlug,
      itemType = "spans",
      project,
      statsPeriod,
      start,
      end,
      attributeTypes,
      substringMatch,
      query,
      context,
    }: {
      organizationSlug: string;
      itemType?: TraceItemType;
      project?: string;
      statsPeriod?: string;
      start?: string;
      end?: string;
      attributeTypes?: TraceItemAttributeType[];
      substringMatch?: string;
      query?: string;
      context?: boolean;
    },
    opts?: RequestOptions,
  ): Promise<TraceItemAttribute[]> {
    const attributes = await this.fetchTraceItemAttributes(
      organizationSlug,
      itemType,
      project,
      statsPeriod,
      start,
      end,
      substringMatch,
      query,
      context,
      opts,
    );

    if (!attributeTypes || attributeTypes.length === 0) {
      return attributes;
    }

    const allowedTypes = new Set(attributeTypes);
    return attributes.filter((attribute) => allowedTypes.has(attribute.type));
  }

  async validateEvents(
    {
      organizationSlug,
      dataset = "spans",
      fields,
      query,
      orderby,
      project,
      environment,
      statsPeriod,
      start,
      end,
    }: {
      organizationSlug: string;
      dataset?: EventsDataset;
      fields?: string[];
      query?: string;
      orderby?: string[];
      project?: string;
      environment?: string | string[];
      statsPeriod?: string;
      start?: string;
      end?: string;
    },
    opts?: RequestOptions,
  ): Promise<EventsValidationResult> {
    const queryParams = new URLSearchParams();
    queryParams.set("dataset", normalizeEventsDataset(dataset));
    if (project) {
      queryParams.set("project", project);
    }
    if (query) {
      queryParams.set("query", query);
    }
    if (environment) {
      const environments = Array.isArray(environment)
        ? environment
        : [environment];
      for (const value of environments) {
        queryParams.append("environment", value);
      }
    }
    this.applyTimeParams(queryParams, statsPeriod, start, end);
    for (const field of fields ?? []) {
      queryParams.append("field", field);
    }
    for (const value of orderby ?? []) {
      queryParams.append("orderby", value);
    }

    const response = await this.request(
      apiPath`/organizations/${organizationSlug}/events/validate/` +
        `?${queryParams.toString()}`,
      undefined,
      { ...opts, allowStatuses: [400] },
    );
    const body = await this.parseJsonResponse(response);
    return EventsValidationResponseSchema.parse(body);
  }

  /**
   * List the organization's visible environments, optionally scoped to a
   * project. The endpoint (`GET /organizations/{org}/environments/`) already
   * filters to visible environments and excludes the empty-name "No Environment"
   * pseudo-env; passing `project` narrows the list (verified against
   * getsentry/sentry `OrganizationEnvironmentsEndpoint`).
   */
  async listEnvironments(
    {
      organizationSlug,
      projectId,
    }: {
      organizationSlug: string;
      projectId?: string;
    },
    opts?: RequestOptions,
  ): Promise<OrganizationEnvironmentList> {
    const queryParams = new URLSearchParams();
    if (projectId) {
      queryParams.set("project", projectId);
    }
    const suffix = queryParams.toString();
    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/environments/` +
        (suffix ? `?${suffix}` : ""),
      undefined,
      opts,
    );
    return OrganizationEnvironmentListSchema.parse(body);
  }

  private async fetchTraceItemAttributes(
    organizationSlug: string,
    itemType: TraceItemType,
    project?: string,
    statsPeriod?: string,
    start?: string,
    end?: string,
    substringMatch?: string,
    query?: string,
    context?: boolean,
    opts?: RequestOptions,
  ): Promise<TraceItemAttribute[]> {
    const queryParams = new URLSearchParams();
    queryParams.set("itemType", itemType);
    if (project) {
      queryParams.set("project", project);
    }
    if (substringMatch) {
      queryParams.set("substringMatch", substringMatch);
    }
    if (query) {
      queryParams.set("query", query);
    }
    if (context) {
      queryParams.set("expand", "context");
    }
    this.applyTimeParams(queryParams, statsPeriod, start, end);

    const url =
      apiPath`/organizations/${organizationSlug}/trace-items/attributes/` +
      `?${queryParams.toString()}`;

    const body = await this.requestJSON(url, undefined, opts);
    return TraceItemAttributeListSchema.parse(body);
  }

  /**
   * Lists issues within an organization or project.
   *
   * Issues represent groups of similar errors or problems in your application.
   * Supports Sentry's powerful query syntax for filtering and sorting.
   *
   * @param params Query parameters
   * @param params.organizationSlug Organization identifier
   * @param params.projectSlug Project identifier (optional, scopes to specific project)
   * @param params.query Sentry search query (e.g., "is:unresolved browser:chrome")
   * @param params.sortBy Sort order ("user", "freq", "date", "new", "recommended")
   * @param opts Request options
   * @returns Array of issues with metadata and statistics
   *
   * @example
   * ```typescript
   * // Recent unresolved issues
   * const issues = await apiService.listIssues({
   *   organizationSlug: "my-org",
   *   query: "is:unresolved",
   *   sortBy: "date"
   * });
   *
   * // High-frequency errors in specific project
   * const critical = await apiService.listIssues({
   *   organizationSlug: "my-org",
   *   projectId: "123456",
   *   query: "level:error",
   *   sortBy: "freq"
   * });
   * ```
   */
  async listIssues(
    {
      organizationSlug,
      projectId,
      query,
      sortBy,
      limit = 10,
      statsPeriod = DEFAULT_SEARCH_ISSUES_PERIOD,
    }: {
      organizationSlug: string;
      projectId?: string;
      query?: string | null;
      sortBy?: "user" | "freq" | "date" | "new" | "recommended";
      limit?: number;
      /**
       * Controls the search time window - which issues are included in results.
       * Note: this is NOT the sparkline/stats period (that would be groupStatsPeriod).
       * The Sentry API accepts any Nh/Nd/Nw format and defaults to 90d when omitted,
       * but large windows risk timeouts on busy orgs.
       */
      statsPeriod?: string;
    },
    opts?: RequestOptions,
  ): Promise<IssueList> {
    const sentryQuery: string[] = [];
    if (query) {
      sentryQuery.push(query);
    }

    const queryParams = new URLSearchParams();
    queryParams.set("limit", String(limit));
    if (sortBy) queryParams.set("sort", sortBy);
    queryParams.set("statsPeriod", statsPeriod ?? DEFAULT_SEARCH_ISSUES_PERIOD);
    queryParams.set("query", sentryQuery.join(" "));

    if (projectId) {
      queryParams.append("project", projectId);
    }
    queryParams.append("collapse", "unhandled");

    const apiUrl =
      apiPath`/organizations/${organizationSlug}/issues/` +
      `?${queryParams.toString()}`;

    const body = await this.requestJSON(apiUrl, undefined, opts);
    return IssueListSchema.parse(body);
  }

  async getIssue(
    {
      organizationSlug,
      issueId,
    }: {
      organizationSlug: string;
      issueId: string;
    },
    opts?: RequestOptions,
  ): Promise<Issue> {
    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/issues/${issueId}/`,
      undefined,
      opts,
    );
    return IssueSchema.parse(body);
  }

  /**
   * Retrieves tag value distribution for a specific issue.
   *
   * Returns aggregate counts of unique tag values, useful for understanding
   * how an issue is distributed across different tag values (e.g., URLs,
   * browsers, environments).
   *
   * @param params Query parameters
   * @param params.organizationSlug Organization identifier
   * @param params.issueId Issue identifier (short ID or numeric ID)
   * @param params.tagKey Tag key to get values for (e.g., "url", "browser", "environment")
   * @param opts Request options
   * @returns Tag value distribution with counts and percentages
   *
   * @example
   * ```typescript
   * const tagValues = await apiService.getIssueTagValues({
   *   organizationSlug: "my-org",
   *   issueId: "PROJECT-123",
   *   tagKey: "url"
   * });
   * console.log(`Total unique values: ${tagValues.totalValues}`);
   * tagValues.topValues.forEach(v => console.log(`${v.value}: ${v.count}`));
   * ```
   */
  async getIssueTagValues(
    {
      organizationSlug,
      issueId,
      tagKey,
    }: {
      organizationSlug: string;
      issueId: string;
      tagKey: string;
    },
    opts?: RequestOptions,
  ): Promise<IssueTagValues> {
    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/issues/${issueId}/tags/${tagKey}/`,
      undefined,
      opts,
    );
    return IssueTagValuesSchema.parse(body);
  }

  /**
   * Retrieves Sentry App issue associations. Native links come from listIssueIntegrations.
   *
   * @param params Query parameters
   * @param params.organizationSlug Organization identifier
   * @param params.issueId Issue identifier (short ID or numeric ID)
   * @param opts Request options
   * @returns Array of external issue links with service type and URL
   */
  async getIssueExternalLinks(
    {
      organizationSlug,
      issueId,
    }: {
      organizationSlug: string;
      issueId: string;
    },
    opts?: RequestOptions,
  ): Promise<ExternalIssueList> {
    return this.listIssueLinkPages(
      apiPath`/organizations/${organizationSlug}/issues/${issueId}/external-issues/`,
      ExternalIssueListSchema,
      opts,
    );
  }

  private async listIssueLinkPages<T>(
    path: string,
    schema: z.ZodType<T[]>,
    opts?: RequestOptions,
  ): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ per_page: "100" });
      if (cursor) query.set("cursor", cursor);
      const response = await this.request(
        `${path}${path.includes("?") ? "&" : "?"}${query.toString()}`,
        undefined,
        opts,
      );
      items.push(...schema.parse(await this.parseJsonResponse(response)));
      cursor = getNextCursor(response.headers.get("link"));
    } while (cursor);
    return items;
  }

  async listIssueIntegrations(
    {
      organizationSlug,
      issueId,
    }: { organizationSlug: string; issueId: string },
    opts?: RequestOptions,
  ): Promise<IssueIntegrationList> {
    return this.listIssueLinkPages(
      apiPath`/organizations/${organizationSlug}/issues/${issueId}/integrations/`,
      IssueIntegrationListSchema,
      opts,
    );
  }

  /** Send a complete provider URL; HTTP 201 distinguishes a new association from a retry. */
  async linkNativeExternalIssue(
    {
      organizationSlug,
      issueId,
      integrationId,
      externalIssueUrl,
    }: {
      organizationSlug: string;
      issueId: string;
      integrationId: string;
      externalIssueUrl: string;
    },
    opts?: RequestOptions,
  ): Promise<{ issue: NativeExternalIssue; changed: boolean }> {
    const response = await this.request(
      apiPath`/organizations/${organizationSlug}/issues/${issueId}/integrations/${integrationId}/`,
      {
        method: "PUT",
        body: JSON.stringify({ externalIssue: externalIssueUrl }),
      },
      opts,
    );
    return {
      issue: NativeExternalIssueSchema.parse(
        await this.parseJsonResponse(response),
      ),
      changed: response.status === 201,
    };
  }

  /** Delete using Sentry's ExternalIssue ID, not the provider's issue number. */
  async unlinkNativeExternalIssue(
    {
      organizationSlug,
      issueId,
      integrationId,
      externalIssueId,
    }: {
      organizationSlug: string;
      issueId: string;
      integrationId: string;
      externalIssueId: string;
    },
    opts?: RequestOptions,
  ): Promise<void> {
    const query = new URLSearchParams({ externalIssue: externalIssueId });
    await this.request(
      apiPath`/organizations/${organizationSlug}/issues/${issueId}/integrations/${integrationId}/` +
        `?${query.toString()}`,
      { method: "DELETE" },
      opts,
    );
  }

  async listSentryAppInstallations(
    { organizationSlug }: { organizationSlug: string },
    opts?: RequestOptions,
  ): Promise<SentryAppInstallationList> {
    return this.listIssueLinkPages(
      apiPath`/organizations/${organizationSlug}/sentry-app-installations/`,
      SentryAppInstallationListSchema,
      { ...opts, host: this.isPublicSaas() ? "sentry.io" : opts?.host },
    );
  }

  async listSentryAppComponents(
    { organizationSlug }: { organizationSlug: string },
    opts?: RequestOptions,
  ): Promise<SentryAppComponentList> {
    return this.listIssueLinkPages(
      apiPath`/organizations/${organizationSlug}/sentry-app-components/` +
        "?filter=issue-link",
      SentryAppComponentListSchema,
      { ...opts, host: this.isPublicSaas() ? "sentry.io" : opts?.host },
    );
  }

  async getSentryAppExternalRequestOptions(
    {
      installationUuid,
      uri,
      query,
      projectId,
      dependentData,
    }: {
      installationUuid: string;
      uri: string;
      query?: string;
      projectId?: string;
      dependentData?: Record<string, string | number>;
    },
    opts?: RequestOptions,
  ): Promise<SentryAppExternalRequestOptions> {
    const params = new URLSearchParams({ uri });
    if (query !== undefined) params.set("query", query);
    if (projectId !== undefined) params.set("projectId", projectId);
    if (dependentData !== undefined)
      params.set("dependentData", JSON.stringify(dependentData));
    const body = await this.requestJSON(
      apiPath`/sentry-app-installations/${installationUuid}/external-requests/` +
        `?${params.toString()}`,
      undefined,
      { ...opts, host: this.isPublicSaas() ? "sentry.io" : opts?.host },
    );
    return SentryAppExternalRequestOptionsSchema.parse(body);
  }

  /** Invoke the App callback with an exact canonical-URL guard, preserving HTTP 200/201. */
  async linkSentryAppExternalIssue(
    {
      installationUuid,
      issueId,
      uri,
      fields,
      expectedExternalIssueUrl,
    }: {
      installationUuid: string;
      issueId: string;
      uri: string;
      fields: Record<string, string | number>;
      expectedExternalIssueUrl: string;
    },
    opts?: RequestOptions,
  ): Promise<{ issue: ExternalIssue; changed: boolean }> {
    const query = new URLSearchParams({ expectedExternalIssueUrl });
    const response = await this.request(
      apiPath`/sentry-app-installations/${installationUuid}/external-issue-actions/` +
        `?${query.toString()}`,
      {
        method: "POST",
        body: JSON.stringify({
          ...fields,
          groupId: issueId,
          action: "link",
          uri,
        }),
      },
      { ...opts, host: this.isPublicSaas() ? "sentry.io" : opts?.host },
    );
    return {
      issue: ExternalIssueSchema.parse(await this.parseJsonResponse(response)),
      changed: response.status === 201,
    };
  }

  /** Delete a group-scoped App association with event:write permissions. */
  async unlinkSentryAppExternalIssue(
    {
      organizationSlug,
      issueId,
      externalIssueId,
    }: {
      organizationSlug: string;
      issueId: string;
      externalIssueId: string;
    },
    opts?: RequestOptions,
  ): Promise<void> {
    await this.request(
      apiPath`/organizations/${organizationSlug}/issues/${issueId}/external-issues/${externalIssueId}/`,
      { method: "DELETE" },
      opts,
    );
  }

  /**
   * Retrieves issue user reports and returns the next Sentry cursor when another page exists.
   */
  async getIssueUserReports(
    {
      organizationSlug,
      issueId,
      cursor,
      limit,
    }: {
      organizationSlug: string;
      issueId: string;
      cursor?: string | null;
      limit?: number;
    },
    opts?: RequestOptions,
  ): Promise<{ reports: UserReportList; nextCursor: string | null }> {
    const searchQuery = new URLSearchParams();
    if (cursor) {
      searchQuery.set("cursor", cursor);
    }
    if (limit !== undefined) {
      searchQuery.set("per_page", String(limit));
    }

    const path = apiPath`/organizations/${organizationSlug}/issues/${issueId}/user-reports/`;
    const response = await this.request(
      searchQuery.toString() ? `${path}?${searchQuery.toString()}` : path,
      undefined,
      opts,
    );
    const body = await this.parseJsonResponse(response);
    return {
      reports: UserReportListSchema.parse(body),
      nextCursor: getNextCursor(response.headers.get("link")),
    };
  }

  async getEventForIssue(
    {
      organizationSlug,
      issueId,
      eventId,
    }: {
      organizationSlug: string;
      issueId: string;
      eventId: string;
    },
    opts?: RequestOptions,
  ): Promise<Event> {
    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/issues/${issueId}/events/${eventId}/` +
        `?llmFormat=json`,
      undefined,
      opts,
    );

    // Try to parse with known event schemas first
    const parseResult = EventSchema.safeParse(body);

    if (parseResult.success) {
      const rawEvent = parseResult.data;

      // Return known event types with proper type discrimination
      // "default" type represents error events without exception data
      if (rawEvent.type === "error" || rawEvent.type === "default") {
        return rawEvent;
      }
      if (rawEvent.type === "transaction") {
        return rawEvent;
      }
      // "generic" type represents performance regression events and other metric-based issues
      if (rawEvent.type === "generic") {
        return rawEvent;
      }
      // "csp" type represents Content Security Policy violations
      if (rawEvent.type === "csp") {
        return rawEvent;
      }

      // Unknown event type that passed schema validation
      // This means Sentry added a new event type we don't support yet
      const eventType =
        typeof rawEvent.type === "string"
          ? rawEvent.type
          : String(rawEvent.type);

      // Log to Sentry so we can track new event types and add support
      logIssue(`Unsupported event type: ${eventType}`, {
        extra: {
          eventType,
          eventId: rawEvent.id,
        },
      });

      return rawEvent; // Return as UnknownEvent
    }

    // Schema validation failed - this is a serious problem
    // The API response doesn't match our expected structure at all
    const bodyObj = body as Record<string, unknown>;
    const eventType =
      typeof bodyObj.type === "string" ? bodyObj.type : String(bodyObj.type);

    logIssue(`Event failed schema validation: ${eventType}`, {
      extra: {
        eventType,
        eventId: bodyObj.id,
        validationError: parseResult.error.message,
        validationIssues: parseResult.error.issues,
        // Log the container type, not user-provided extra data.
        contextType:
          bodyObj.context === null
            ? "null"
            : Array.isArray(bodyObj.context)
              ? "array"
              : typeof bodyObj.context,
      },
    });

    // Throw error - schema failures mean broken API contract
    throw new ApiValidationError(
      `Event failed schema validation: ${parseResult.error.message}`,
      undefined,
      undefined,
      body,
    );
  }

  async getLatestEventForIssue(
    {
      organizationSlug,
      issueId,
    }: {
      organizationSlug: string;
      issueId: string;
    },
    opts?: RequestOptions,
  ): Promise<Event> {
    return this.getEventForIssue(
      {
        organizationSlug,
        issueId,
        eventId: "latest",
      },
      opts,
    );
  }

  /**
   * Resolves a stack frame through the project's configured source code mapping.
   * The upstream endpoint verifies the mapped path with the SCM integration.
   */
  async getStacktraceLink(
    {
      organizationSlug,
      projectSlug,
      file,
      platform,
      lineNo,
      absPath,
      module,
      package: framePackage,
      commitId,
      groupId,
      sdkName,
      signal,
    }: {
      organizationSlug: string;
      projectSlug: string;
      file: string;
      platform?: string;
      lineNo?: number;
      absPath?: string;
      module?: string;
      package?: string;
      commitId?: string;
      groupId?: string;
      sdkName?: string;
      signal?: AbortSignal;
    },
    opts?: RequestOptions,
  ): Promise<StacktraceLink> {
    const query = new URLSearchParams({ file });
    if (platform) query.set("platform", platform);
    if (lineNo !== undefined) query.set("lineNo", String(lineNo));
    if (absPath) query.set("absPath", absPath);
    if (module) query.set("module", module);
    if (framePackage) query.set("package", framePackage);
    if (commitId) query.set("commitId", commitId);
    if (groupId) query.set("groupId", groupId);
    if (sdkName) query.set("sdkName", sdkName);

    const body = await this.requestJSON(
      apiPath`/projects/${organizationSlug}/${projectSlug}/stacktrace-link/` +
        `?${query.toString()}`,
      { signal },
      opts,
    );
    return StacktraceLinkSchema.parse(body);
  }

  /**
   * Lists events for a specific issue.
   * Uses the issue-specific endpoint which already filters by issue ID.
   *
   * @see https://docs.sentry.io/api/events/list-an-issues-events/
   */
  async listEventsForIssue(
    {
      organizationSlug,
      issueId,
      query,
      limit = 50,
      sort,
      statsPeriod,
      start,
      end,
      full = false,
    }: {
      organizationSlug: string;
      issueId: string;
      query?: string;
      limit?: number;
      sort?: string;
      statsPeriod?: string;
      start?: string;
      end?: string;
      full?: boolean;
    },
    opts?: RequestOptions,
  ) {
    const params = new URLSearchParams();

    if (query) {
      params.append("query", query);
    }

    params.append("per_page", String(limit));

    if (sort) {
      params.append("sort", sort);
    }

    if (statsPeriod) {
      params.append("statsPeriod", statsPeriod);
    } else if (start && end) {
      params.append("start", start);
      params.append("end", end);
    }

    if (full) {
      params.append("full", "true");
    }

    const apiUrl =
      apiPath`/organizations/${organizationSlug}/issues/${issueId}/events/` +
      `?${params.toString()}`;
    return await this.requestJSON(apiUrl, undefined, opts);
  }

  async listEventAttachments(
    {
      organizationSlug,
      projectSlug,
      eventId,
    }: {
      organizationSlug: string;
      projectSlug: string;
      eventId: string;
    },
    opts?: RequestOptions,
  ): Promise<EventAttachmentList> {
    const body = await this.requestJSON(
      apiPath`/projects/${organizationSlug}/${projectSlug}/events/${eventId}/attachments/`,
      undefined,
      opts,
    );
    return EventAttachmentListSchema.parse(body);
  }

  async getEventAttachment(
    {
      organizationSlug,
      projectSlug,
      eventId,
      attachmentId,
      maxInlineBytes = DEFAULT_MAX_INLINE_ATTACHMENT_BYTES,
    }: {
      organizationSlug: string;
      projectSlug: string;
      eventId: string;
      attachmentId: string;
      /**
       * Attachments larger than this (by metadata `size`) skip download —
       * `getEventAttachment` returns `bytes: null`. Defaults to
       * {@link DEFAULT_MAX_INLINE_ATTACHMENT_BYTES}.
       */
      maxInlineBytes?: number;
    },
    opts?: RequestOptions,
  ): Promise<{
    attachment: EventAttachment;
    /** Authenticated API download URL (requires credentials). */
    downloadUrl: string;
    /**
     * Presigned URL that downloads the file directly without credentials, or
     * `null` when unavailable. Only set on the skipped-download path.
     */
    directDownloadUrl: string | null;
    filename: string;
    /** Raw file bytes, or `null` when the download was skipped. */
    bytes: Uint8Array | null;
    contentType: string;
  }> {
    // Get the attachment metadata first
    const attachmentsData = await this.requestJSON(
      apiPath`/projects/${organizationSlug}/${projectSlug}/events/${eventId}/attachments/`,
      undefined,
      opts,
    );

    const attachments = EventAttachmentListSchema.parse(attachmentsData);
    const attachment = attachments.find((att) => att.id === attachmentId);

    if (!attachment) {
      throw new ApiNotFoundError(
        `Attachment with ID ${attachmentId} not found for event ${eventId}`,
      );
    }

    const downloadPath =
      apiPath`/projects/${organizationSlug}/${projectSlug}/events/${eventId}/attachments/${attachmentId}/` +
      `?download=1`;

    // Skip the download for oversized attachments — buffering and base64
    // encoding them can exhaust the worker's memory. Decide from the metadata
    // size so we never issue the request.
    if (attachment.size > maxInlineBytes) {
      const directDownloadUrl = await this.resolveDirectDownloadUrl(
        downloadPath,
        opts,
      );
      return {
        attachment,
        downloadUrl: `${this.apiPrefix}${downloadPath}`,
        directDownloadUrl,
        filename: attachment.name,
        bytes: null,
        contentType: attachment.mimetype || "application/octet-stream",
      };
    }

    // Download the actual file content
    const downloadResponse = await this.request(
      downloadPath,
      { method: "GET" },
      opts,
    );

    // Prefer Content-Type from the download response over the metadata mimetype:
    // the two share the same DB source but the download header reflects any
    // server-side correction (getsentry/sentry#115977) applied at request time.
    const contentType =
      downloadResponse.headers.get("content-type")?.split(";")[0].trim() ||
      attachment.mimetype ||
      "application/octet-stream";

    // Read the body once as bytes; arrayBuffer() avoids the extra copy that
    // blob() + blob.arrayBuffer() would hold at the same time.
    const bytes = new Uint8Array(await downloadResponse.arrayBuffer());

    return {
      attachment,
      downloadUrl: downloadResponse.url,
      directDownloadUrl: null,
      filename: attachment.name,
      bytes,
      contentType,
    };
  }

  /**
   * Probe the download endpoint for a presigned URL without buffering the file.
   *
   * Objectstore attachments redirect to a presigned URL (returned here); legacy
   * ones stream a 200 with no redirect, so there is no direct URL. The body is
   * discarded either way — we only need the URL.
   */
  private async resolveDirectDownloadUrl(
    downloadPath: string,
    opts?: RequestOptions,
  ): Promise<string | null> {
    try {
      const response = await this.request(
        downloadPath,
        { method: "GET" },
        opts,
      );
      const directUrl = response.redirected ? response.url : null;
      // Don't await cancel(): we already have the URL, and awaiting it can
      // stall on some runtimes.
      void response.body?.cancel().catch(() => {});
      return directUrl;
    } catch {
      return null;
    }
  }

  async getReplayDetails(
    {
      organizationSlug,
      replayId,
    }: {
      organizationSlug: string;
      replayId: string;
    },
    opts?: RequestOptions,
  ): Promise<ReplayDetails> {
    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/replays/${replayId}/`,
      undefined,
      opts,
    );
    return z.object({ data: ReplayDetailsSchema }).parse(body).data;
  }

  async listReplayIdsForIssue(
    {
      organizationSlug,
      issueId,
      dataSource,
    }: {
      organizationSlug: string;
      issueId: string | number;
      dataSource: "discover" | "search_issues";
    },
    opts?: RequestOptions,
  ): Promise<string[]> {
    const normalizedIssueId = String(issueId);
    const queryParams = new URLSearchParams();
    queryParams.set("returnIds", "true");
    queryParams.set("query", `issue.id:[${normalizedIssueId}]`);
    queryParams.set("data_source", dataSource);
    queryParams.set("statsPeriod", "90d");
    queryParams.append("project", "-1");

    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/replay-count/` +
        `?${queryParams.toString()}`,
      undefined,
      opts,
    );

    const replayIdsByResource = ReplayIdsByResourceSchema.parse(body);
    return replayIdsByResource[normalizedIssueId] ?? [];
  }

  async getReplayRecordingSegments(
    {
      organizationSlug,
      projectSlugOrId,
      replayId,
    }: {
      organizationSlug: string;
      projectSlugOrId: string;
      replayId: string;
    },
    opts?: RequestOptions,
  ): Promise<ReplayRecordingSegments> {
    const body = await this.requestJSON(
      apiPath`/projects/${organizationSlug}/${projectSlugOrId}/replays/${replayId}/recording-segments/` +
        `?download=true`,
      undefined,
      opts,
    );
    return ReplayRecordingSegmentsSchema.parse(body);
  }

  async updateIssue(
    {
      organizationSlug,
      issueId,
      status,
      assignedTo,
      substatus,
      ignoreDuration,
      ignoreCount,
      ignoreWindow,
      ignoreUserCount,
      ignoreUserWindow,
    }: {
      organizationSlug: string;
      issueId: string;
      status?: string;
      assignedTo?: string | null;
      substatus?: string;
      ignoreDuration?: number;
      ignoreCount?: number;
      ignoreWindow?: number;
      ignoreUserCount?: number;
      ignoreUserWindow?: number;
    },
    opts?: RequestOptions,
  ): Promise<Issue> {
    const updateData: {
      status?: string;
      assignedTo?: string;
      substatus?: string;
      ignoreDuration?: number;
      ignoreCount?: number;
      ignoreWindow?: number;
      ignoreUserCount?: number;
      ignoreUserWindow?: number;
    } = {};
    if (status !== undefined) updateData.status = status;
    if (assignedTo !== undefined) updateData.assignedTo = assignedTo ?? "";
    if (substatus !== undefined) updateData.substatus = substatus;
    if (ignoreDuration !== undefined)
      updateData.ignoreDuration = ignoreDuration;
    if (ignoreCount !== undefined) updateData.ignoreCount = ignoreCount;
    if (ignoreWindow !== undefined) updateData.ignoreWindow = ignoreWindow;
    if (ignoreUserCount !== undefined) {
      updateData.ignoreUserCount = ignoreUserCount;
    }
    if (ignoreUserWindow !== undefined) {
      updateData.ignoreUserWindow = ignoreUserWindow;
    }

    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/issues/${issueId}/`,
      {
        method: "PUT",
        body: JSON.stringify(updateData),
      },
      opts,
    );
    return IssueSchema.parse(body);
  }

  async createIssueComment(
    {
      organizationSlug,
      issueId,
      text,
    }: {
      organizationSlug: string;
      issueId: string;
      text: string;
    },
    opts?: RequestOptions,
  ): Promise<IssueComment> {
    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/issues/${issueId}/notes/`,
      {
        method: "POST",
        body: JSON.stringify({ text }),
      },
      opts,
    );
    return IssueCommentSchema.parse(body);
  }

  async getIssueActivity(
    {
      organizationSlug,
      issueId,
    }: {
      organizationSlug: string;
      issueId: string;
    },
    opts?: RequestOptions,
  ): Promise<IssueActivityList> {
    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/issues/${issueId}/activities/`,
      undefined,
      opts,
    );
    return IssueActivityListResponseSchema.parse(body).activity;
  }

  async listIssueComments(
    {
      organizationSlug,
      issueId,
      limit,
    }: {
      organizationSlug: string;
      issueId: string;
      limit?: number;
    },
    opts?: RequestOptions,
  ): Promise<IssueCommentList> {
    const searchQuery = new URLSearchParams();
    if (limit !== undefined) {
      searchQuery.set("per_page", String(limit));
    }

    const path = apiPath`/organizations/${organizationSlug}/issues/${issueId}/notes/`;
    const body = await this.requestJSON(
      searchQuery.toString() ? `${path}?${searchQuery.toString()}` : path,
      undefined,
      opts,
    );
    return IssueCommentListSchema.parse(body);
  }

  // TODO: Sentry is not yet exposing a reasonable API to fetch trace data
  // async getTrace({
  //   organizationSlug,
  //   traceId,
  // }: {
  //   organizationSlug: string;
  //   traceId: string;
  // }): Promise<z.infer<typeof SentryIssueSchema>> {
  //   const response = await this.request(
  //     `/organizations/${organizationSlug}/issues/${traceId}/`,
  //   );

  //   const body = await response.json();
  //   return SentryIssueSchema.parse(body);
  // }

  async searchErrors(
    {
      organizationSlug,
      projectSlug,
      filename,
      transaction,
      query,
      sortBy = "last_seen",
    }: {
      organizationSlug: string;
      projectSlug?: string;
      filename?: string;
      transaction?: string;
      query?: string;
      sortBy?: "last_seen" | "count";
    },
    opts?: RequestOptions,
  ) {
    const sentryQuery: string[] = [];
    if (filename) {
      sentryQuery.push(`stack.filename:"*${filename.replace(/"/g, '\\"')}"`);
    }
    if (transaction) {
      sentryQuery.push(`transaction:"${transaction.replace(/"/g, '\\"')}"`);
    }
    if (query) {
      sentryQuery.push(query);
    }
    if (projectSlug) {
      sentryQuery.push(`project:${projectSlug}`);
    }

    const queryParams = new URLSearchParams();
    queryParams.set("dataset", "errors");
    queryParams.set("per_page", "10");
    queryParams.set(
      "sort",
      `-${sortBy === "last_seen" ? "last_seen" : "count"}`,
    );
    queryParams.set("statsPeriod", "24h");
    queryParams.append("field", "issue");
    queryParams.append("field", "title");
    queryParams.append("field", "project");
    queryParams.append("field", "last_seen()");
    queryParams.append("field", "count()");
    queryParams.set("query", sentryQuery.join(" "));
    // if (projectSlug) queryParams.set("project", projectSlug);

    const apiUrl =
      apiPath`/organizations/${organizationSlug}/events/` +
      `?${queryParams.toString()}`;

    const body = await this.requestJSON(apiUrl, undefined, opts);
    // TODO(dcramer): If you're using an older version of Sentry this API had a breaking change
    // meaning this endpoint will error.
    return ErrorsSearchResponseSchema.parse(body).data;
  }

  async searchSpans(
    {
      organizationSlug,
      projectSlug,
      transaction,
      query,
      sortBy = "timestamp",
    }: {
      organizationSlug: string;
      projectSlug?: string;
      transaction?: string;
      query?: string;
      sortBy?: "timestamp" | "duration";
    },
    opts?: RequestOptions,
  ) {
    const sentryQuery: string[] = ["is_transaction:true"];
    if (transaction) {
      sentryQuery.push(`transaction:"${transaction.replace(/"/g, '\\"')}"`);
    }
    if (query) {
      sentryQuery.push(query);
    }
    if (projectSlug) {
      sentryQuery.push(`project:${projectSlug}`);
    }

    const queryParams = new URLSearchParams();
    queryParams.set("dataset", "spans");
    queryParams.set("per_page", "10");
    queryParams.set(
      "sort",
      `-${sortBy === "timestamp" ? "timestamp" : "span.duration"}`,
    );
    queryParams.set("allowAggregateConditions", "0");
    queryParams.set("useRpc", "1");
    queryParams.append("field", "id");
    queryParams.append("field", "trace");
    queryParams.append("field", "span.op");
    queryParams.append("field", "span.description");
    queryParams.append("field", "span.duration");
    queryParams.append("field", "transaction");
    queryParams.append("field", "project");
    queryParams.append("field", "timestamp");
    queryParams.set("query", sentryQuery.join(" "));
    // if (projectSlug) queryParams.set("project", projectSlug);

    const apiUrl =
      apiPath`/organizations/${organizationSlug}/events/` +
      `?${queryParams.toString()}`;

    const body = await this.requestJSON(apiUrl, undefined, opts);
    return SpansSearchResponseSchema.parse(body).data;
  }

  // ================================================================================
  // API QUERY BUILDERS FOR DIFFERENT SENTRY APIS
  // ================================================================================

  /**
   * Builds query parameters for the legacy Discover API (primarily used by errors dataset).
   *
   * Note: While the API endpoint is the same for all datasets, we maintain separate
   * builders to make future divergence easier and to keep the code organized.
   */
  private buildDiscoverApiQuery(params: {
    query: string;
    fields: string[];
    limit: number;
    projectId?: string;
    dataset?: "errors" | "tracemetrics" | "profiles";
    statsPeriod?: string;
    start?: string;
    end?: string;
    sort: string;
  }): URLSearchParams {
    const queryParams = new URLSearchParams();

    // Basic parameters
    queryParams.set("per_page", params.limit.toString());
    queryParams.set("query", params.query);
    queryParams.set("dataset", params.dataset ?? "errors");

    this.applyTimeParams(
      queryParams,
      params.statsPeriod,
      params.start,
      params.end,
    );

    if (params.projectId) {
      queryParams.set("project", params.projectId);
    }

    queryParams.set("sort", params.sort);

    // Add fields
    for (const field of params.fields) {
      queryParams.append("field", field);
    }

    queryParams.set("referrer", SENTRY_MCP_SEARCH_EVENTS_REFERRER);

    return queryParams;
  }

  /**
   * Builds query parameters for the modern EAP API (used by spans/logs datasets).
   *
   * Includes dataset-specific parameters like sampling for spans.
   */
  private buildEapApiQuery(params: {
    query: string;
    fields: string[];
    limit: number;
    projectId?: string;
    dataset: "spans" | "logs";
    statsPeriod?: string;
    start?: string;
    end?: string;
    sort: string;
    crossEventQueries?: CrossEventQueries;
  }): URLSearchParams {
    const queryParams = new URLSearchParams();

    // Basic parameters
    queryParams.set("per_page", params.limit.toString());
    queryParams.set("query", params.query);
    queryParams.set("dataset", params.dataset);

    this.applyTimeParams(
      queryParams,
      params.statsPeriod,
      params.start,
      params.end,
    );

    if (params.projectId) {
      queryParams.set("project", params.projectId);
    }

    // Dataset-specific parameters
    if (params.dataset === "spans") {
      queryParams.set("sampling", "NORMAL");
    }

    const { spanQuery, logQuery, metricQuery } = params.crossEventQueries ?? {};
    if (spanQuery) queryParams.set("spanQuery", spanQuery);
    if (logQuery) queryParams.set("logQuery", logQuery);
    if (metricQuery) queryParams.set("metricQuery", metricQuery);

    queryParams.set("sort", params.sort);

    // Add fields
    for (const field of params.fields) {
      queryParams.append("field", field);
    }

    queryParams.set("referrer", SENTRY_MCP_SEARCH_EVENTS_REFERRER);

    return queryParams;
  }

  /**
   * Searches for events in Sentry using the unified events API.
   * This method is used by the search_events tool for semantic search.
   *
   * Routes to the appropriate query builder based on dataset, even though
   * the underlying API endpoint is the same. This separation makes the code
   * cleaner and allows for future API divergence.
   */
  async searchEvents(
    {
      organizationSlug,
      query,
      fields,
      limit = 10,
      projectId,
      dataset = "spans",
      statsPeriod,
      start,
      end,
      sort = "-timestamp",
      crossEventQueries,
    }: {
      organizationSlug: string;
      query: string;
      fields: string[];
      limit?: number;
      projectId?: string;
      dataset?: EventsDataset;
      statsPeriod?: string;
      start?: string;
      end?: string;
      sort?: string;
      crossEventQueries?: CrossEventQueries;
    },
    opts?: RequestOptions,
  ) {
    let queryParams: URLSearchParams;
    const normalizedDataset = normalizeEventsDataset(dataset);

    if (
      normalizedDataset === "errors" ||
      normalizedDataset === "tracemetrics" ||
      normalizedDataset === "profiles"
    ) {
      // Use Discover API query builder
      queryParams = this.buildDiscoverApiQuery({
        query,
        fields,
        limit,
        projectId,
        dataset: normalizedDataset,
        statsPeriod,
        start,
        end,
        sort,
      });
    } else {
      // Use EAP API query builder for spans and logs
      queryParams = this.buildEapApiQuery({
        query,
        fields,
        limit,
        projectId,
        dataset: normalizedDataset,
        statsPeriod,
        start,
        end,
        sort,
        crossEventQueries,
      });
    }

    const apiUrl =
      apiPath`/organizations/${organizationSlug}/events/` +
      `?${queryParams.toString()}`;
    return await this.requestJSON(apiUrl, undefined, opts);
  }

  /**
   * Fetch a timeseries (events-stats) for a single yAxis, bucketed over time.
   *
   * `interval` is optional: omit it to let Sentry pick a sensible bucket size
   * for the range (mirrors get_interval_from_range in the Sentry source).
   * Environment and other filters travel in `query`, same as searchEvents.
   */
  async getEventsTimeSeries(
    {
      organizationSlug,
      query,
      yAxis,
      interval,
      projectId,
      dataset = "errors",
      statsPeriod,
      start,
      end,
    }: {
      organizationSlug: string;
      query: string;
      yAxis: string;
      interval?: string;
      projectId?: string;
      dataset?: EventsDataset;
      statsPeriod?: string;
      start?: string;
      end?: string;
    },
    opts?: RequestOptions,
  ) {
    const queryParams = new URLSearchParams();
    queryParams.set("dataset", normalizeEventsDataset(dataset));
    queryParams.set("query", query);
    queryParams.set("yAxis", yAxis);
    // Omit interval to let Sentry pick a sensible bucket size for the range.
    if (interval) {
      queryParams.set("interval", interval);
    }
    this.applyTimeParams(queryParams, statsPeriod, start, end);
    if (projectId) {
      queryParams.set("project", projectId);
    }
    // partial=1 keeps the current (in-progress) bucket, matching Sentry's charts.
    queryParams.set("partial", "1");
    queryParams.set("referrer", SENTRY_MCP_SEARCH_EVENTS_REFERRER);

    const apiUrl =
      apiPath`/organizations/${organizationSlug}/events-stats/` +
      `?${queryParams.toString()}`;
    const body = await this.requestJSON(apiUrl, undefined, opts);
    return EventsStatsResponseSchema.parse(body);
  }

  // POST https://us.sentry.io/api/0/issues/5485083130/autofix/
  async startAutofix(
    {
      organizationSlug,
      issueId,
      eventId,
      instruction = "",
    }: {
      organizationSlug: string;
      issueId: string;
      eventId?: string;
      instruction?: string;
    },
    opts?: RequestOptions,
  ): Promise<AutofixRun> {
    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/issues/${issueId}/autofix/`,
      {
        method: "POST",
        body: JSON.stringify({
          event_id: eventId,
          instruction,
        }),
      },
      opts,
    );
    return AutofixRunSchema.parse(body);
  }

  // GET https://us.sentry.io/api/0/issues/5485083130/autofix/
  async getAutofixState(
    {
      organizationSlug,
      issueId,
    }: {
      organizationSlug: string;
      issueId: string;
    },
    opts?: RequestOptions,
  ): Promise<AutofixRunState> {
    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/issues/${issueId}/autofix/` +
        `?llmFormat=markdown`,
      undefined,
      opts,
    );
    return AutofixRunStateSchema.parse(body);
  }

  // POST https://us.sentry.io/api/0/organizations/my-org/search-agent/start/
  async startSearchAgent(
    {
      organizationSlug,
      projectIds,
      naturalLanguageQuery,
      strategy,
    }: {
      organizationSlug: string;
      projectIds: number[];
      naturalLanguageQuery: string;
      strategy: "Traces" | "Issues" | "Logs" | "Errors" | "Metrics";
    },
    opts?: RequestOptions,
  ): Promise<SearchAgentStart> {
    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/search-agent/start/`,
      {
        method: "POST",
        body: JSON.stringify({
          project_ids: projectIds,
          natural_language_query: naturalLanguageQuery,
          strategy,
        }),
      },
      opts,
    );
    return SearchAgentStartSchema.parse(body);
  }

  // GET https://us.sentry.io/api/0/organizations/my-org/search-agent/state/{runId}/
  async getSearchAgentState(
    {
      organizationSlug,
      runId,
    }: {
      organizationSlug: string;
      runId: string;
    },
    opts?: RequestOptions,
  ): Promise<SearchAgentState> {
    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/search-agent/state/${runId}/`,
      undefined,
      opts,
    );
    return SearchAgentStateSchema.parse(body);
  }

  /**
   * Retrieves high-level metadata about a trace.
   *
   * Returns statistics including span counts, error counts, transaction
   * breakdown, and operation type distribution for the specified trace.
   *
   * @param params Query parameters
   * @param params.organizationSlug Organization identifier
   * @param params.traceId Trace identifier (32-character hex string)
   * @param params.statsPeriod Optional stats period (e.g., "14d", "7d")
   * @param opts Request options
   * @returns Trace metadata with statistics
   *
   * @example
   * ```typescript
   * const traceMeta = await apiService.getTraceMeta({
   *   organizationSlug: "my-org",
   *   traceId: "a4d1aae7216b47ff8117cf4e09ce9d0a"
   * });
   * console.log(`Trace has ${traceMeta.span_count} spans`);
   * ```
   */
  async getTraceMeta(
    {
      organizationSlug,
      traceId,
      statsPeriod = "14d",
    }: {
      organizationSlug: string;
      traceId: string;
      statsPeriod?: string;
    },
    opts?: RequestOptions,
  ): Promise<TraceMeta> {
    const queryParams = new URLSearchParams();
    queryParams.set("statsPeriod", statsPeriod);

    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/trace-meta/${traceId}/` +
        `?${queryParams.toString()}`,
      undefined,
      opts,
    );
    return TraceMetaSchema.parse(body);
  }

  /**
   * Retrieves the complete trace structure with all spans.
   *
   * Returns the hierarchical trace data including all spans, their timing
   * information, operation details, and nested relationships.
   *
   * @param params Query parameters
   * @param params.organizationSlug Organization identifier
   * @param params.traceId Trace identifier (32-character hex string)
   * @param params.limit Requested span-count hint (default: 1000). The server currently paginates trace data internally and may ignore this value.
   * @param params.project Project filter hint (-1 for all projects). The current organization trace endpoint ignores this value server-side.
   * @param params.statsPeriod Optional stats period (e.g., "14d", "7d")
   * @param opts Request options
   * @returns Complete trace tree structure
   *
   * @example
   * ```typescript
   * const trace = await apiService.getTrace({
   *   organizationSlug: "my-org",
   *   traceId: "a4d1aae7216b47ff8117cf4e09ce9d0a",
   *   limit: 1000
   * });
   * console.log(`Root spans: ${trace.length}`);
   * ```
   */
  async getTrace(
    {
      organizationSlug,
      traceId,
      limit = 1000,
      project = "-1",
      statsPeriod = "14d",
    }: {
      organizationSlug: string;
      traceId: string;
      limit?: number;
      project?: string;
      statsPeriod?: string;
    },
    opts?: RequestOptions,
  ): Promise<Trace> {
    const queryParams = new URLSearchParams();
    // Keep sending the endpoint's declared query parameters even though the
    // current server implementation ignores `project` and paginates internally.
    queryParams.set("limit", String(limit));
    queryParams.set("project", project);
    queryParams.set("statsPeriod", statsPeriod);

    const body = await this.requestJSON(
      apiPath`/organizations/${organizationSlug}/trace/${traceId}/` +
        `?${queryParams.toString()}`,
      undefined,
      opts,
    );
    return TraceSchema.parse(body);
  }

  /**
   * Fetches all spans for one AI conversation within a relative or absolute time window.
   */
  async getAIConversation(
    {
      organizationSlug,
      conversationId,
      project = "-1",
      statsPeriod = "30d",
      start,
      end,
      perPage = 1000,
      maxPages = 10,
    }: {
      organizationSlug: string;
      conversationId: string;
      project?: string | string[];
      statsPeriod?: string;
      start?: string;
      end?: string;
      perPage?: number;
      maxPages?: number;
    },
    opts?: RequestOptions,
  ): Promise<AIConversationDetails> {
    const spans: AIConversationSpanList = [];
    let title: string | null = null;
    let cursor: string | null = null;

    for (let page = 0; page < maxPages; page++) {
      const queryParams = new URLSearchParams();
      queryParams.set("per_page", String(perPage));
      this.applyTimeParams(
        queryParams,
        start || end ? undefined : statsPeriod,
        start,
        end,
      );
      const projects = Array.isArray(project) ? project : [project];
      for (const projectId of projects) {
        queryParams.append("project", projectId);
      }
      if (cursor) {
        queryParams.set("cursor", cursor);
      }

      const response = await this.request(
        apiPath`/organizations/${organizationSlug}/agents/conversations/${conversationId}/` +
          `?${queryParams.toString()}`,
        undefined,
        opts,
      );
      const body = await this.parseJsonResponse(response);
      const details = AIConversationDetailsResponseSchema.parse(body);
      // Pages repeat the same conversation-scoped title.
      title = details.title;
      spans.push(...details.spans);

      cursor = getNextCursor(response.headers.get("link"));
      if (!cursor) {
        break;
      }
    }

    return {
      conversationId,
      title,
      spans,
    };
  }

  /**
   * Searches Sentry AI Conversations using the conversation list endpoint and
   * returns the current page plus cursor metadata from the response headers.
   */
  async searchAIConversations(
    {
      organizationSlug,
      query,
      project,
      environment,
      statsPeriod,
      start,
      end,
      limit,
      cursor,
    }: {
      organizationSlug: string;
      query?: string;
      project?: string | string[];
      environment?: string | string[];
      statsPeriod?: string;
      start?: string;
      end?: string;
      limit?: number;
      cursor?: string;
    },
    opts?: RequestOptions,
  ): Promise<{
    conversations: AIConversationSummary[];
    nextCursor: string | null;
  }> {
    const queryParams = new URLSearchParams();
    if (query) {
      queryParams.set("query", query);
    }
    if (project) {
      const projects = Array.isArray(project) ? project : [project];
      for (const projectId of projects) {
        queryParams.append("project", projectId);
      }
    }
    if (environment) {
      const environments = Array.isArray(environment)
        ? environment
        : [environment];
      for (const environmentName of environments) {
        queryParams.append("environment", environmentName);
      }
    }
    this.applyTimeParams(queryParams, statsPeriod, start, end);
    if (limit !== undefined) {
      queryParams.set("per_page", String(limit));
    }
    if (cursor) {
      queryParams.set("cursor", cursor);
    }

    const response = await this.request(
      apiPath`/organizations/${organizationSlug}/agents/conversations/` +
        `?${queryParams.toString()}`,
      undefined,
      opts,
    );
    const body = await this.parseJsonResponse(response);

    return {
      conversations: AIConversationSummaryListSchema.parse(body),
      nextCursor: getNextCursor(response.headers.get("link")),
    };
  }

  /**
   * Retrieves flamegraph data for a transaction.
   *
   * Flamegraphs provide pre-aggregated CPU profiling data including:
   * - Unique call stack patterns (samples)
   * - Performance statistics (counts, durations, percentiles)
   * - Frame metadata (file, function, is_application)
   *
   * This is the primary data source for profile analysis as it includes
   * aggregated hot paths and percentile calculations (p75, p95, p99).
   *
   * @param params Query parameters
   * @param params.organizationSlug Organization identifier
   * @param params.projectId Project ID or slug
   * @param params.transactionName Transaction name to analyze (e.g., "/api/users")
   * @param params.statsPeriod Time period for analysis (e.g., "7d", "14d", "30d")
   * @param opts Request options
   * @returns Flamegraph with pre-aggregated profiling data
   *
   * @example
   * ```typescript
   * const flamegraph = await apiService.getFlamegraph({
   *   organizationSlug: "my-org",
   *   projectId: 1,
   *   transactionName: "/api/users",
   *   statsPeriod: "7d"
   * });
   * console.log(`Analyzed ${flamegraph.profiles.length} profiles`);
   * ```
   */
  async getFlamegraph(
    {
      organizationSlug,
      projectId,
      transactionName,
      statsPeriod = "7d",
    }: {
      organizationSlug: string;
      projectId: string | number;
      transactionName: string;
      statsPeriod?: string;
    },
    opts?: RequestOptions,
  ): Promise<Flamegraph> {
    const queryParams = new URLSearchParams();
    queryParams.set("project", projectId.toString());
    // Escape backslashes first, then quotes for proper string escaping
    const escapedTransaction = transactionName
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    queryParams.set(
      "query",
      `event.type:transaction transaction:"${escapedTransaction}"`,
    );
    queryParams.set("statsPeriod", statsPeriod);

    const path =
      apiPath`/organizations/${organizationSlug}/profiling/flamegraph/` +
      `?${queryParams.toString()}`;
    const body = await this.requestJSON(path, undefined, opts);
    return FlamegraphSchema.parse(body);
  }

  async getTransactionProfile(
    {
      organizationSlug,
      projectSlugOrId,
      profileId,
    }: {
      organizationSlug: string;
      projectSlugOrId: string | number;
      profileId: string;
    },
    opts?: RequestOptions,
  ): Promise<TransactionProfile> {
    const path = apiPath`/projects/${organizationSlug}/${projectSlugOrId}/profiling/profiles/${profileId}/`;
    const body = await this.requestJSON(path, undefined, opts);
    return TransactionProfileSchema.parse(body);
  }

  /**
   * Retrieves raw profile chunk data for detailed analysis.
   *
   * Profile chunks contain:
   * - frames: All unique stack frames
   * - samples: Individual sample points with timestamps
   * - stacks: Arrays of frame indices forming call stacks
   * - thread_metadata: Information about profiled threads
   *
   * This is used for deep-dive analysis when flamegraph data isn't sufficient.
   * Most use cases should use getFlamegraph() instead, as it provides
   * pre-aggregated data that's easier to work with.
   *
   * @param params Query parameters
   * @param params.organizationSlug Organization identifier
   * @param params.profilerId Profiler ID from flamegraph output
   * @param params.projectId Project ID or slug
   * @param params.start Start time (ISO format)
   * @param params.end End time (ISO format)
   * @param opts Request options
   * @returns Raw profile chunk data
   * @throws ApiNotFoundError if no profile chunk is found
   *
   * @example
   * ```typescript
   * const chunk = await apiService.getProfileChunk({
   *   organizationSlug: "my-org",
   *   profilerId: "041bde57b9844e36b8b7e5734efae5f7",
   *   projectId: 1,
   *   start: "2024-01-01T00:00:00Z",
   *   end: "2024-01-01T01:00:00Z"
   * });
   * console.log(`Chunk has ${chunk.profile.samples.length} samples`);
   * ```
   */
  async getProfileChunk(
    {
      organizationSlug,
      profilerId,
      projectId,
      start,
      end,
    }: {
      organizationSlug: string;
      profilerId: string;
      projectId: string | number;
      start: string;
      end: string;
    },
    opts?: RequestOptions,
  ): Promise<ProfileChunk> {
    const queryParams = new URLSearchParams();
    queryParams.set("profiler_id", profilerId);
    queryParams.set("project", projectId.toString());
    queryParams.set("start", start);
    queryParams.set("end", end);

    const path =
      apiPath`/organizations/${organizationSlug}/profiling/chunks/` +
      `?${queryParams.toString()}`;
    const body = await this.requestJSON(path, undefined, opts);

    // Normalize the Sentry {chunk: ...} wrapper to the internal chunks array.
    const response = ProfileChunkResponseSchema.parse(body);
    if (response.chunks.length === 0) {
      throw new ApiNotFoundError(
        `No profile chunk found for profiler_id ${profilerId}`,
        undefined,
        body,
      );
    }

    return {
      ...response.chunks[0],
      // Sentry's frontend does the same query-param backfill for continuous
      // profile chunks because profiling-service may omit profiler_id.
      profiler_id: response.chunks[0].profiler_id ?? profilerId,
    };
  }

  getPreprodSnapshotUrl(organizationSlug: string, snapshotId: string): string {
    return getPreprodSnapshotUrlUtil(
      this.host,
      organizationSlug,
      snapshotId,
      this.protocol,
    );
  }

  async getSnapshotDetails({
    organizationSlug,
    snapshotId,
    compactMetadata = true,
  }: {
    organizationSlug: string;
    snapshotId: string;
    compactMetadata?: boolean;
  }): Promise<unknown> {
    const params = new URLSearchParams();
    if (compactMetadata) {
      params.set("compact_metadata", "true");
    }
    const path =
      apiPath`/organizations/${organizationSlug}/preprodartifacts/snapshots/${snapshotId}/` +
      `?${params.toString()}`;
    return this.requestJSON(path);
  }

  async getSnapshotImageDetail({
    organizationSlug,
    snapshotId,
    imageIdentifier,
  }: {
    organizationSlug: string;
    snapshotId: string;
    imageIdentifier: string;
  }): Promise<unknown> {
    const path = apiPath`/organizations/${organizationSlug}/preprodartifacts/snapshots/${snapshotId}/images/${imageIdentifier}/`;
    return this.requestJSON(path);
  }

  async fetchImageByUrl(
    imageUrl: string,
  ): Promise<{ blob: Blob; contentType: string }> {
    const response = imageUrl.startsWith("https://")
      ? await fetch(imageUrl)
      : await this.request(
          imageUrl.startsWith("/api/0")
            ? imageUrl.slice("/api/0".length)
            : imageUrl,
        );
    if (!response.ok) {
      throw new Error(
        `Failed to fetch image: ${response.status} ${response.statusText}`,
      );
    }
    const blob = await response.blob();
    let contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      const { detectImageMimeType } = await import("../internal/blob-utils.js");
      contentType = (await detectImageMimeType(blob)) ?? contentType;
    }
    return { blob, contentType };
  }

  async getLatestBaseSnapshot({
    organizationSlug,
    appId,
    branch,
    project,
    projectSlug,
    compactMetadata = true,
  }: {
    organizationSlug: string;
    appId: string;
    branch?: string;
    project?: string;
    projectSlug?: string;
    compactMetadata?: boolean;
  }): Promise<unknown> {
    const params = new URLSearchParams();
    params.set("app_id", appId);
    if (branch) params.set("branch", branch);
    if (project) params.set("project", project);
    if (projectSlug) params.set("projectSlug", projectSlug);
    if (compactMetadata) params.set("compact_metadata", "true");
    const path =
      apiPath`/organizations/${organizationSlug}/preprodartifacts/snapshots/latest-base/` +
      `?${params.toString()}`;
    return this.requestJSON(path);
  }
}
