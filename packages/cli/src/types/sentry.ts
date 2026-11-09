/**
 * Sentry API Types
 *
 * Types representing Sentry API resources.
 *
 * SDK-backed types (Organization, Project, Issue, Event, ProjectKey) are derived
 * from `@sentry/api` response types using `Partial<SdkType> & RequiredCore`.
 * This keeps all SDK-documented fields available with correct types while making
 * non-core fields optional for flexibility (test mocks, partial API responses).
 *
 * Internal types not covered by the SDK (Region, User, logs) use Valibot schemas
 * for runtime validation. Event entry types (exceptions, breadcrumbs, etc.)
 * are plain TypeScript interfaces since they are only used for type annotations.
 */

import type {
  EventAttachmentDetailsResponse,
  GroupEventsResponseDict as SdkGroupEventsList,
  IssueEventDetailsResponse,
  DeployResponse as SdkDeployResponse,
  GetOrganizationIssueResponse as SdkIssueDetail,
  ListOrganizationIssuesResponse as SdkIssueList,
  ListOrganizations as SdkOrganizationList,
  ProjectKey as SdkProjectKey,
  OrganizationProjectResponseDict as SdkProjectList,
  OrgReleaseResponse as SdkReleaseResponse,
  BaseTeam as SdkTeam,
} from "@sentry/api";
import type { EventViewAttachmentFields } from "../output-schemas/event.js";
import type { SentryIntegrationSchema } from "../output-schemas/integration.js";
import type {
  MonitorConfigSchema,
  SentryMonitorSchema,
} from "../output-schemas/monitor.js";
import type { WithOutputFields } from "../output-schemas/output.js";
import type { ReleaseUpdateOutputFields } from "../output-schemas/release.js";
import type {
  RepositoryProviderSchema,
  SentryRepositorySchema,
} from "../output-schemas/repo.js";
import type {
  SentryIssueIdentity,
  SentryNamedResource,
} from "@sentry/toolkit-core/resource-identity";
import { vOrganizationTraceMetaResponse } from "@sentry/api/valibot";
import {
  array,
  boolean,
  description,
  type InferOutput,
  literal,
  looseObject,
  nullable,
  nullish,
  number,
  object,
  optional,
  partial,
  pipe,
  record,
  string,
  transform,
  union,
  unknown,
  url,
  variant,
} from "valibot";

// SDK-derived types

// Organization

/**
 * A Sentry organization.
 *
 * Based on the `@sentry/api` list-organizations response type.
 * Core identifiers are required; other SDK fields are available but optional,
 * allowing test mocks and list-endpoint responses to omit them.
 *
 * `allowMemberProjectCreation` and `orgRole` are present in detail responses
 * (GET /api/0/organizations/{slug}/) but absent from list responses, hence
 * optional. `allowMemberProjectCreation` being false means
 * Organization.flags.disable_member_project_creation is set — project creation
 * requires org:write scope or team:admin on the target team.
 */
export type SentryOrganization = Partial<SdkOrganizationList[number]> &
  SentryNamedResource<string> & {
    /** False when org admins have restricted project creation to owners/managers/team-admins. Default for new orgs. */
    allowMemberProjectCreation?: boolean;
    /** The authenticated user's role in this org ("member", "admin", "manager", "owner"). */
    orgRole?: string;
  };

// Project

/** Element type of the SDK's list-projects response */
type SdkProjectListItem = SdkProjectList[number];

/**
 * A Sentry project.
 *
 * Based on the `@sentry/api` list-projects response type.
 * The `organization` field is present in detail responses but absent in list responses,
 * so it is declared as an optional extension.
 */
export type SentryProject = Partial<SdkProjectListItem> &
  SentryNamedResource<string> & {
    /**
     * Organization context (present in detail responses, absent in list).
     *
     * `name` is optional because `getProject()` passes `?collapse=organization`
     * to skip full-org serialization on the server (~400-500ms faster). The
     * collapsed payload only carries `{id, slug}`. Callers needing a display
     * name should use `resolveOrgDisplayName()` which falls back to the
     * cached organizations list.
     */
    organization?: {
      id: string;
      slug: string;
      name?: string;
      [key: string]: unknown;
    };
    /**
     * Project status (returned by API but not in the OpenAPI spec).
     *
     * Overlay convention: the SDK type (`SdkProjectListItem`) carries every
     * documented field; this overlay adds ONLY fields the API returns but the
     * spec omits, each a backend `@extend_schema` candidate. Keep it minimal —
     * do not restate fields the SDK already types.
     */
    status?: string;
  };

// Issue Constants

/**
 * Runtime-iterable tuple of issue status values the CLI renders.
 *
 * This is a deliberate superset of the SDK's `GetOrganizationIssueResponse`
 * status union: it keeps `resolvedInNextRelease` and `muted`, which the
 * retrieve-issue endpoint still emits and the CLI still renders (see
 * STATUS_ICONS / STATUS_LABELS / STATUS_COLORS). As of @sentry/api 0.256 the
 * SDK union narrowed and no longer covers those two, so the previous
 * `satisfies NonNullable<SdkIssueDetail["status"]>[]` drift guard misfired on
 * statuses the CLI needs to display and was removed.
 */
export const ISSUE_STATUSES = [
  "resolved",
  "resolvedInNextRelease",
  "unresolved",
  "ignored",
  "muted",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_LEVELS = [
  "fatal",
  "error",
  "warning",
  "info",
  "debug",
] as const;
export type IssueLevel = (typeof ISSUE_LEVELS)[number];

// Issue

/**
 * A Sentry issue.
 *
 * Based on the `@sentry/api` retrieve-issue response type.
 * Core identifiers are required; other SDK fields are available but optional.
 * Includes extensions for fields returned by the API but not in the OpenAPI spec.
 *
 * The `metadata` field is overridden from the SDK's discriminated union to a single
 * object with all optional fields, matching how the API actually returns data.
 */
export type SentryIssue = Omit<Partial<SdkIssueDetail>, "metadata"> &
  SentryIssueIdentity<string> & {
    /** Issue metadata (value, filename, function, etc.) */
    metadata?: {
      value?: string;
      type?: string;
      filename?: string;
      function?: string;
      title?: string;
      display_title_with_tree_label?: boolean;
      [key: string]: unknown;
    };
    /** Issue substatus (not in OpenAPI spec) */
    substatus?: string | null;
    /** Issue priority (not in OpenAPI spec) */
    priority?: string;
    /** Whether the issue is unhandled (not in OpenAPI spec) */
    isUnhandled?: boolean;
    /** Platform of the issue (not in OpenAPI spec) */
    platform?: string;
    /**
     * Seer AI fixability score (0-1). Higher = easier to fix automatically.
     * `null` when Seer has not analyzed this issue; absent when the org has Seer disabled.
     */
    seerFixabilityScore?: number | null;
    /**
     * Seen-stats scoped to the query's event-level filters (e.g. `release:`).
     * Returned by the issues-list endpoint only when `filtered` isn't
     * collapsed; `null` when the query has no such filters.
     */
    filtered?: SdkIssueList[number]["filtered"];
  };

// Event

/**
 * A Sentry event.
 *
 * Based on the `@sentry/api` IssueEventDetailsResponse type.
 * Core identifier (eventID) is required; other SDK fields are available but optional.
 *
 * The `contexts` field is overridden from the SDK's generic `Record<string,unknown>`
 * to include typed sub-contexts (trace, browser, os, device) that our formatters access.
 * Additional fields not in the OpenAPI spec are also included.
 */
export type SentryEvent = Omit<
  Partial<IssueEventDetailsResponse>,
  "contexts"
> & {
  eventID: string;
  /** Event contexts with typed sub-contexts */
  contexts?: {
    trace?: TraceContext;
    browser?: BrowserContext;
    os?: OsContext;
    device?: DeviceContext;
    replay?: ReplayContext;
    [key: string]: unknown;
  } | null;
  /** Date the event was created (not in OpenAPI spec) */
  dateCreated?: string;
  /** Event fingerprints (not in OpenAPI spec) */
  fingerprints?: string[];
  /** Release associated with the event (not in OpenAPI spec) */
  release?: {
    version: string;
    shortVersion?: string;
    dateCreated?: string;
    dateReleased?: string | null;
    [key: string]: unknown;
  } | null;
  /** SDK update suggestions (not in OpenAPI spec) */
  sdkUpdates?: Array<{
    type?: string;
    sdkName?: string;
    newSdkVersion?: string;
    sdkUrl?: string;
    [key: string]: unknown;
  }>;
  /** URL/function where the error occurred (not in OpenAPI spec for events) */
  culprit?: string | null;
};

/** An event attachment with its authenticated download URL. */
export type EventViewAttachment = WithOutputFields<
  EventAttachmentDetailsResponse,
  typeof EventViewAttachmentFields
>;

// Issue Event (list endpoint)

/**
 * A lightweight event from the issue events list endpoint.
 *
 * This is a subset of the full event detail — the list endpoint returns
 * minimal event metadata without stacktraces, breadcrumbs, or contexts.
 * Use {@link SentryEvent} for full event details from the detail endpoint.
 */
export type IssueEvent = SdkGroupEventsList[number];

// Project Keys (DSN)

/**
 * A Sentry project key (DSN).
 *
 * Based on the `@sentry/api` ProjectKey type.
 * Core fields are required; other SDK fields are available but optional.
 */
export type ProjectKey = Partial<SdkProjectKey> & {
  id: string;
  name: string;
  isActive: boolean;
  dsn: {
    public: string;
    secret: string;
    [key: string]: unknown;
  };
};

// Internal types with Valibot schemas (runtime-validated, not in @sentry/api)

// Region

/** A Sentry region (e.g., US, EU) */
export const RegionSchema = object({
  name: string(),
  url: pipe(string(), url()),
});

export type Region = InferOutput<typeof RegionSchema>;

/** Response from /api/0/users/me/regions/ endpoint */
export const UserRegionsResponseSchema = object({
  regions: array(RegionSchema),
});

export type UserRegionsResponse = InferOutput<typeof UserRegionsResponseSchema>;

/**
 * Response from `/api/0/organizations/{org}/dsn-lookup/`. The endpoint is
 * private, so `@sentry/api` has no type for it.
 */
export const DsnLookupResponseSchema = looseObject({
  organizationSlug: string(),
  projectSlug: string(),
  projectId: string(),
  projectName: string(),
});

// User

/**
 * Minimal user schema for the `/auth/` endpoint response.
 *
 * All optional fields use `.nullish()` (accepts both `null` and `undefined`)
 * because the Sentry API can return `null` for any of these.
 * Note: `@sentry/api` doesn't export types for the `/auth/` endpoint —
 * it's undocumented, so we define this schema manually.
 */
export const SentryUserSchema = looseObject({
  id: string(),
  email: nullish(string()),
  username: nullish(string()),
  name: nullish(string()),
});

export type SentryUser = InferOutput<typeof SentryUserSchema>;

// Plain TypeScript interfaces (type annotations only, no runtime validation)

// Event Contexts

/** Trace context from event.contexts.trace */
export type TraceContext = {
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string | null;
  op?: string;
  status?: string;
  description?: string | null;
  [key: string]: unknown;
};

/** Browser context from event.contexts.browser */
export type BrowserContext = {
  name?: string;
  version?: string;
  type?: "browser";
  [key: string]: unknown;
};

/** Operating system context from event.contexts.os */
export type OsContext = {
  name?: string;
  version?: string;
  type?: "os";
  [key: string]: unknown;
};

/** Device context from event.contexts.device */
export type DeviceContext = {
  family?: string;
  model?: string;
  brand?: string;
  type?: "device";
  [key: string]: unknown;
};

/** Replay context from event.contexts.replay */
export type ReplayContext = {
  replay_id?: string;
  [key: string]: unknown;
};

/** High-level metadata returned by the organization trace-meta endpoint. */
export const TraceMetaSchema = vOrganizationTraceMetaResponse;

export type TraceMeta = InferOutput<typeof TraceMetaSchema>;

export const ISSUE_PRIORITIES = ["high", "medium", "low"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

export const ISSUE_SUBSTATUSES = [
  "ongoing",
  "escalating",
  "regressed",
  "new",
  "archived_until_escalating",
  "archived_until_condition_met",
  "archived_forever",
] as const;
export type IssueSubstatus = (typeof ISSUE_SUBSTATUSES)[number];

// Release

/**
 * A Sentry release.
 *
 * Based on the `@sentry/api` org-release response type (`OrgReleaseResponse`).
 * Only `version` is unconditionally required; all other SDK fields (id, status,
 * versionInfo, data, authors, projects, ...) are widened to optional so test
 * fixtures and partial API responses can omit them without casts.
 */
export type SentryRelease = Partial<SdkReleaseResponse> & {
  version: string;
};

/** The updated release, or the `--dry-run` preview. */
export type ReleaseUpdateOutput = WithOutputFields<
  SentryRelease,
  typeof ReleaseUpdateOutputFields
>;

// Deploy

/**
 * A Sentry deploy.
 *
 * Based on the `@sentry/api` deploy response type (`DeployResponse`).
 * Core identifiers are required; timestamps and display fields are widened
 * to optional so test mocks can omit `dateStarted`, `dateFinished`, `name`,
 * and `url`.
 */
export type SentryDeploy = Partial<SdkDeployResponse> & {
  id: string;
  environment: string;
};

// Issue

// Span (for trace tree display)

/** A single span in a trace */
export const SpanSchema = looseObject({
  span_id: string(),
  parent_span_id: optional(nullable(string())),
  trace_id: optional(string()),
  op: optional(string()),
  description: optional(nullable(string())),
  /** Start time as Unix timestamp (seconds with fractional ms) */
  start_timestamp: number(),
  /** End time as Unix timestamp (seconds with fractional ms) */
  timestamp: number(),
  status: optional(string()),
  data: optional(record(string(), unknown())),
  tags: optional(record(string(), string())),
});

export type Span = InferOutput<typeof SpanSchema>;

/**
 * Span from /trace/{traceId}/ endpoint with nested children.
 * This endpoint returns a hierarchical structure unlike /events-trace/.
 *
 * The API may return either `timestamp` or `end_timestamp` (or both) depending
 * on the span source. Code should check both fields when reading the end time.
 */
export type TraceSpan = {
  span_id: string;
  parent_span_id?: string | null;
  op?: string;
  description?: string | null;
  start_timestamp: number;
  /** End timestamp in seconds (legacy field, prefer end_timestamp) */
  timestamp?: number;
  /** End timestamp in seconds (preferred over timestamp) */
  end_timestamp?: number;
  /** Duration in milliseconds (when provided by the API) */
  duration?: number;
  transaction?: string;
  "transaction.op"?: string;
  project_slug?: string;
  event_id?: string;
  /** Nested child spans */
  children?: TraceSpan[];
  /** Span name (often same as op) */
  name?: string;
  /** Always "span" for EAP spans */
  event_type?: string;
  /** Whether this span is a transaction boundary */
  is_transaction?: boolean;
  /** Transaction event ID */
  transaction_id?: string;
  /** SDK that produced this span */
  sdk_name?: string;
  /** Profile ID (empty string when not profiled) */
  profile_id?: string;
  /** Profiler ID (empty string when not profiled) */
  profiler_id?: string;
  /** Web vitals and performance measurements (keyed by measurement name) */
  measurements?: Record<string, number>;
  /** Extra attributes requested via `additional_attributes` query param */
  additional_attributes?: Record<string, unknown>;
  /** Error issues attached to this span */
  errors?: unknown[];
  /** Performance issue occurrences on this span */
  occurrences?: unknown[];
};

// Stack Frame & Exception Entry

/** A single frame in a stack trace */
export type StackFrame = {
  filename?: string | null;
  absPath?: string | null;
  module?: string | null;
  package?: string | null;
  platform?: string | null;
  function?: string | null;
  rawFunction?: string | null;
  symbol?: string | null;
  lineNo?: number | null;
  colNo?: number | null;
  /** Whether this frame is in the user's application code */
  inApp?: boolean | null;
  /** Surrounding code lines: [[lineNo, code], ...] */
  context?: [number, string][] | null;
  vars?: Record<string, unknown> | null;
  instructionAddr?: string | null;
  symbolAddr?: string | null;
  trust?: string | null;
  errors?: unknown[] | null;
  [key: string]: unknown;
};

/** Stack trace containing frames */
export type Stacktrace = {
  frames?: StackFrame[];
  framesOmitted?: number[] | null;
  registers?: Record<string, string> | null;
  hasSystemFrames?: boolean;
  [key: string]: unknown;
};

/** Exception mechanism (how the error was captured) */
export type Mechanism = {
  type?: string;
  handled?: boolean;
  synthetic?: boolean;
  description?: string | null;
  data?: Record<string, unknown>;
  [key: string]: unknown;
};

/** A single exception value in the exception entry */
export type ExceptionValue = {
  type?: string | null;
  value?: string | null;
  module?: string | null;
  threadId?: string | number | null;
  mechanism?: Mechanism | null;
  stacktrace?: Stacktrace | null;
  rawStacktrace?: Stacktrace | null;
  [key: string]: unknown;
};

/** Exception entry in event.entries */
export type ExceptionEntry = {
  type: "exception";
  data: {
    values?: ExceptionValue[];
    excOmitted?: number[] | null;
    hasSystemFrames?: boolean;
    [key: string]: unknown;
  };
};

// Breadcrumbs Entry

/** A single breadcrumb */
export type Breadcrumb = {
  type?: string;
  category?: string | null;
  level?: string;
  message?: string | null;
  timestamp?: string;
  event_id?: string | null;
  data?: Record<string, unknown> | null;
  [key: string]: unknown;
};

/** Breadcrumbs entry in event.entries */
export type BreadcrumbsEntry = {
  type: "breadcrumbs";
  data: {
    values?: Breadcrumb[];
    [key: string]: unknown;
  };
};

// Request Entry

/** HTTP request entry in event.entries */
export type RequestEntry = {
  type: "request";
  data: {
    url?: string | null;
    method?: string | null;
    fragment?: string | null;
    query?: [string, string][] | string | Record<string, string> | null;
    data?: unknown;
    headers?: [string, string][] | Record<string, string> | null;
    cookies?: [string, string][] | Record<string, string> | null;
    env?: Record<string, string> | null;
    inferredContentType?: string | null;
    apiTarget?: string | null;
    [key: string]: unknown;
  };
};

// Log types (runtime-validated, internal explore API)

/**
 * Individual log entry from the logs dataset.
 * Fields match the Sentry Explore/Events API response for dataset=logs.
 */
export const SentryLogSchema = pipe(
  looseObject({
    /** Unique identifier for deduplication */
    "sentry.item_id": pipe(string(), description("Unique log entry ID")),
    /** ISO timestamp of the log entry */
    timestamp: pipe(string(), description("Log timestamp (ISO 8601)")),
    /** Nanosecond-precision timestamp for accurate ordering and filtering.
     * Coerced from string because the API may return large integers as strings
     * to avoid precision loss beyond Number.MAX_SAFE_INTEGER. */
    timestamp_precise: pipe(
      unknown(),
      transform(Number),
      number(),
      description("Nanosecond-precision timestamp"),
    ),
    /** Log message content */
    message: optional(nullable(pipe(string(), description("Log message")))),
    /** Log severity level (error, warning, info, debug, etc.) */
    severity: optional(
      nullable(
        pipe(
          string(),
          description("Severity level (error, warning, info, debug)"),
        ),
      ),
    ),
    /** Trace ID for correlation with traces */
    trace: optional(
      nullable(pipe(string(), description("Trace ID for correlation"))),
    ),
  }),
  description("Sentry log"),
);

export type SentryLog = InferOutput<typeof SentryLogSchema>;

/** Response from the logs events endpoint */
export const LogsResponseSchema = object({
  data: array(SentryLogSchema),
  meta: optional(
    looseObject({
      fields: optional(record(string(), string())),
    }),
  ),
});

export type LogsResponse = InferOutput<typeof LogsResponseSchema>;

/**
 * Detailed log entry with all available fields from the logs dataset.
 * Used by the `log view` command for comprehensive log display.
 */
export const DetailedSentryLogSchema = pipe(
  looseObject({
    /** Unique identifier for deduplication */
    "sentry.item_id": string(),
    /** ISO timestamp of the log entry */
    timestamp: string(),
    /** Nanosecond-precision timestamp for accurate ordering.
     * Coerced from string because the API may return large integers as strings
     * to avoid precision loss beyond Number.MAX_SAFE_INTEGER. */
    timestamp_precise: pipe(unknown(), transform(Number), number()),
    /** Log message content */
    message: optional(nullable(string())),
    /** Log severity level (error, warning, info, debug, etc.) */
    severity: optional(nullable(string())),
    /** Trace ID for correlation with traces */
    trace: optional(nullable(string())),
    /** Project slug */
    project: optional(nullable(string())),
    /** Environment name */
    environment: optional(nullable(string())),
    /** Release version */
    release: optional(nullable(string())),
    /** SDK name */
    "sdk.name": optional(nullable(string())),
    /** SDK version */
    "sdk.version": optional(nullable(string())),
    /** Span ID for correlation with spans */
    span_id: optional(nullable(string())),
    /** Function name where log was emitted */
    "code.function": optional(nullable(string())),
    /** File path where log was emitted */
    "code.file.path": optional(nullable(string())),
    /** Line number where log was emitted */
    "code.line.number": optional(nullable(string())),
    /** OpenTelemetry span kind */
    "sentry.otel.kind": optional(nullable(string())),
    /** OpenTelemetry status code */
    "sentry.otel.status_code": optional(nullable(string())),
    /** OpenTelemetry instrumentation scope name */
    "sentry.otel.instrumentation_scope.name": optional(nullable(string())),
  }),
  description("Detailed Sentry log"),
);

export type DetailedSentryLog = InferOutput<typeof DetailedSentryLogSchema>;

/** Response from the detailed log query endpoint */
export const DetailedLogsResponseSchema = object({
  data: array(DetailedSentryLogSchema),
  meta: optional(
    looseObject({
      fields: optional(record(string(), string())),
    }),
  ),
});

export type DetailedLogsResponse = InferOutput<
  typeof DetailedLogsResponseSchema
>;

// Trace-item detail types (from /projects/{org}/{project}/trace-items/{itemId}/ endpoint)

/**
 * A single attribute on a trace item (log, span, etc.).
 *
 * Mirrors Sentry's TraceItemResponseAttribute:
 * https://github.com/getsentry/sentry/blob/8a4f150b21b/static/app/views/explore/hooks/useTraceItemDetails.tsx#L85-L89
 *
 * The endpoint is EXPERIMENTAL and not yet in @sentry/api (getsentry/sentry-api-schema).
 */
export const TraceItemAttributeSchema = variant("type", [
  object({ name: string(), type: literal("str"), value: string() }),
  // Sentry serializes int64 values as strings to avoid precision loss
  // (e.g. project_id: "4508608809533441"); keep them as strings.
  object({
    name: string(),
    type: literal("int"),
    value: union([number(), string()]),
  }),
  object({ name: string(), type: literal("float"), value: number() }),
  object({ name: string(), type: literal("bool"), value: boolean() }),
  // "array" is gated by organizations:trace-item-details-array-fields in Sentry backend
  object({
    name: string(),
    type: literal("array"),
    value: array(unknown()),
  }),
]);
export type TraceItemAttribute = InferOutput<typeof TraceItemAttributeSchema>;

/** Response from GET /projects/{org}/{project}/trace-items/{itemId}/ (logs and spans) */
export const TraceItemDetailSchema = looseObject({
  itemId: string(),
  timestamp: string(),
  attributes: array(TraceItemAttributeSchema),
}); // preserves meta, links, and any future fields returned by the endpoint
export type TraceItemDetail = InferOutput<typeof TraceItemDetailSchema>;

// Trace-log types (from /organizations/{org}/trace-logs/ endpoint)

/**
 * Individual log entry from the trace-logs endpoint.
 *
 * Fields returned by `GET /api/0/organizations/{org}/trace-logs/`. This endpoint
 * is org-scoped and always queries all projects — it returns a fixed set of 8
 * columns, unlike the flexible Explore/Events logs endpoint.
 *
 * Key differences from {@link SentryLog} (Explore/Events):
 * - `id` instead of `sentry.item_id`
 * - Includes `project.id` (integer) and `severity_number`
 * - `timestamp_precise` is a nanosecond integer (same as Explore/Events logs)
 */
export const TraceLogSchema = pipe(
  looseObject({
    /** Unique identifier for this log entry */
    id: string(),
    /** Numeric ID of the project this log belongs to.
     * Coerced from string because some API responses return numeric IDs as strings. */
    "project.id": pipe(unknown(), transform(Number), number()),
    /** The 32-character hex trace ID this log is associated with */
    trace: string(),
    /** Numeric OTel severity level (e.g., 9 = INFO, 13 = WARN, 17 = ERROR).
     * Optional because not all log entries include this field.
     * Coerced from string for resilience against API format variations. */
    severity_number: optional(pipe(unknown(), transform(Number), number())),
    /** Severity label (e.g., "info", "warn", "error") */
    severity: string(),
    /** ISO 8601 timestamp */
    timestamp: string(),
    /** High-precision timestamp in nanoseconds.
     * Optional because some API responses may omit it.
     * Coerced from string because nanosecond timestamps (≈1.7e18 in 2026)
     * exceed Number.MAX_SAFE_INTEGER and APIs may return them as strings. */
    timestamp_precise: optional(pipe(unknown(), transform(Number), number())),
    /** Log message content */
    message: optional(nullable(string())),
  }),
  description("Trace log"),
);

export type TraceLog = InferOutput<typeof TraceLogSchema>;

/** Response from the trace-logs endpoint */
export const TraceLogsResponseSchema = looseObject({
  data: array(TraceLogSchema),
  meta: optional(
    looseObject({
      fields: optional(record(string(), string())),
      units: optional(record(string(), string())),
    }),
  ),
});

export type TraceLogsResponse = InferOutput<typeof TraceLogsResponseSchema>;

// Transaction (for trace listing)

/**
 * Transaction list item from the Explore/Events API (spans dataset,
 * `is_transaction:true` — transactions are root spans).
 * Fields match the response when querying trace, id, transaction, timestamp, etc.
 */
export const TransactionListItemSchema = pipe(
  looseObject({
    /** Trace ID this transaction belongs to */
    trace: pipe(string(), description("Trace ID")),
    /** Span ID of the root (transaction) span */
    id: pipe(string(), description("Span ID of the root span")),
    /** Transaction name (e.g., "GET /api/users") */
    transaction: pipe(string(), description("Transaction name")),
    /** ISO timestamp of the transaction */
    timestamp: pipe(string(), description("Timestamp (ISO 8601)")),
    /** Duration of the root span in milliseconds */
    "span.duration": pipe(number(), description("Duration (ms)")),
    /** Project slug */
    project: pipe(string(), description("Project slug")),
  }),
  description("Transaction list item"),
);

export type TransactionListItem = InferOutput<typeof TransactionListItemSchema>;

/** Response from the spans events endpoint (is_transaction:true) */
export const TransactionsResponseSchema = object({
  data: array(TransactionListItemSchema),
  meta: optional(
    looseObject({
      fields: optional(record(string(), string())),
    }),
  ),
});

export type TransactionsResponse = InferOutput<
  typeof TransactionsResponseSchema
>;

/** A single span item from the EAP spans search endpoint */
export const SpanListItemSchema = pipe(
  looseObject({
    id: pipe(string(), description("Span ID")),
    parent_span: optional(
      nullable(pipe(string(), description("Parent span ID"))),
    ),
    "span.op": optional(
      nullable(
        pipe(string(), description("Span operation (e.g. http.client, db)")),
      ),
    ),
    description: optional(
      nullable(pipe(string(), description("Span description"))),
    ),
    "span.duration": optional(
      nullable(pipe(number(), description("Duration (ms)"))),
    ),
    timestamp: pipe(string(), description("Timestamp (ISO 8601)")),
    project: pipe(string(), description("Project slug")),
    transaction: optional(
      nullable(pipe(string(), description("Transaction name"))),
    ),
    trace: pipe(string(), description("Trace ID")),
  }),
  description("Span list item"),
);

export type SpanListItem = InferOutput<typeof SpanListItemSchema>;

/** Response from the spans events endpoint */
export const SpansResponseSchema = object({
  data: array(SpanListItemSchema),
  meta: optional(
    looseObject({
      fields: optional(record(string(), string())),
    }),
  ),
});

export type SpansResponse = InferOutput<typeof SpansResponseSchema>;

// Repository

export type RepositoryProvider = InferOutput<typeof RepositoryProviderSchema>;

export type SentryRepository = InferOutput<typeof SentryRepositorySchema>;

// Integrations

export type SentryIntegration = InferOutput<typeof SentryIntegrationSchema>;

// Org Auth Token

/**
 * Organization auth token from `/organizations/{org}/org-auth-tokens/`.
 *
 * The full `token` value is only present in the create response; Sentry
 * stores a hash and can't return it again.
 */
export const OrgAuthTokenSchema = pipe(
  looseObject({
    id: pipe(string(), description("Token ID")),
    name: pipe(string(), description("Token name")),
    scopes: pipe(array(string()), description("Scopes granted to the token")),
    tokenLastCharacters: pipe(
      nullable(string()),
      description("Last 4 characters of the token"),
    ),
    dateCreated: pipe(string(), description("Creation timestamp")),
    dateLastUsed: pipe(
      nullable(string()),
      description("Last time the token was used, if ever"),
    ),
    projectLastUsedId: optional(
      pipe(
        nullable(string()),
        description("ID of the project the token was last used for"),
      ),
    ),
    token: optional(
      pipe(string(), description("Full token value (create response only)")),
    ),
  }),
  description("Organization auth token"),
);

export type OrgAuthToken = InferOutput<typeof OrgAuthTokenSchema>;

// Cron Monitor

export type MonitorConfig = InferOutput<typeof MonitorConfigSchema>;

export type SentryMonitor = InferOutput<typeof SentryMonitorSchema>;

// Team

/**
 * A Sentry team.
 *
 * Based on the `@sentry/api` `BaseTeam` type. Only core identifiers are
 * required; other SDK fields (dateCreated, isMember, teamRole, flags, access,
 * hasAccess, isPending, memberCount, avatar) are widened to optional so test
 * mocks and partial list-endpoint responses can omit them.
 *
 * `SentryTeamSchema` (`output-schemas/team.ts`) is the `--fields` / SKILL.md
 * documentation schema — it is NOT used for runtime validation (team list
 * responses are cast `as unknown as SentryTeam[]` in `api/teams.ts`), so the
 * schema and type are allowed to diverge: the schema curates a user-facing
 * subset of fields, the type follows the SDK's structural superset.
 */
export type SentryTeam = Partial<SdkTeam> & SentryNamedResource<string>;

// Product Trials

/** A product trial from the customer endpoint */
export const ProductTrialSchema = pipe(
  object({
    /** Trial category (e.g., "seerUsers", "seerAutofix") */
    category: pipe(
      string(),
      description("Trial category (e.g. seerUsers, seerAutofix)"),
    ),
    /** ISO date when the trial started, null if not started */
    startDate: pipe(nullable(string()), description("Start date (ISO 8601)")),
    /** ISO date when the trial ends, null if not started */
    endDate: pipe(nullable(string()), description("End date (ISO 8601)")),
    /** Reason code for the trial */
    reasonCode: pipe(number(), description("Reason code")),
    /** Whether the trial has been activated */
    isStarted: pipe(boolean(), description("Whether the trial has started")),
    /** Duration of the trial in days, null if unknown */
    lengthDays: pipe(nullable(number()), description("Trial duration in days")),
  }),
  description("Product trial"),
);

export type ProductTrial = InferOutput<typeof ProductTrialSchema>;

/** Subset of plan details needed for plan trial display */
export const PlanDetailsSubsetSchema = object({
  /** Human-readable plan name (e.g., "Developer", "Business") */
  name: string(),
  /** Plan ID of the trial plan (e.g., "am3_t"), null if no trial plan */
  trialPlan: optional(nullable(string())),
});

/** Subset of customer data needed for trial availability checks */
export const CustomerTrialInfoSchema = object({
  /** Available and active product trials for the organization */
  productTrials: optional(nullable(array(ProductTrialSchema))),
  /** Whether the organization can start a plan-level trial */
  canTrial: optional(boolean()),
  /** Whether the organization is currently on a plan trial */
  isTrial: optional(boolean()),
  /** ISO date when the plan trial ends, null if not on trial */
  trialEnd: optional(nullable(string())),
  /** Plan details with trial plan info */
  planDetails: optional(PlanDetailsSubsetSchema),
});

export type CustomerTrialInfo = InferOutput<typeof CustomerTrialInfoSchema>;
