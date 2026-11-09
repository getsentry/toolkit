// Intentional public API barrel.
/**
 * Type definitions for the Sentry CLI
 *
 * Re-exports all types from domain-specific modules.
 */

// DSN types
export type { DetectedDsn, DsnSource, ParsedDsn } from "../lib/dsn/types.js";
// Configuration types
export type {
  CachedProject,
  ProjectAliasEntry,
  ProjectAliases,
  SentryConfig,
} from "./config.js";
export {
  ProjectAliasEntrySchema,
  ProjectAliasesSchema,
  SentryConfigSchema,
} from "./config.js";
// Agent conversations types
export type {
  AgentConversationDetails,
  AgentConversationSpan,
  ConversationListItem,
  ConversationStats,
} from "./conversation.js";
export {
  AgentConversationDetailsSchema,
  AgentConversationSpanSchema,
  ConversationListItemSchema,
  ConversationStatsSchema,
} from "./conversation.js";
// Dashboard types
export type {
  DashboardDetail,
  DashboardListItem,
  DashboardWidget,
  DashboardWidgetLayout,
  DashboardWidgetQuery,
} from "./dashboard.js";
export {
  DashboardDetailSchema,
  DashboardWidgetLayoutSchema,
  DashboardWidgetQuerySchema,
  DashboardWidgetSchema,
} from "./dashboard.js";
// Feedback types and schemas
export type {
  FeedbackListResult,
  FeedbackMetadata,
  FeedbackViewResult,
  SentryFeedback,
} from "./feedback.js";
// OAuth types and schemas
export type {
  DeviceCodeResponse,
  TokenErrorResponse,
  TokenResponse,
} from "./oauth.js";
export {
  DeviceCodeResponseSchema,
  TokenErrorResponseSchema,
  TokenResponseSchema,
} from "./oauth.js";
// Replay types and schemas
export type {
  ReplayActivityEvent,
  ReplayBrowser,
  ReplayDetails,
  ReplayDetailsResponse,
  ReplayDevice,
  ReplayGeo,
  ReplayIdsByResource,
  ReplayListItem,
  ReplayListResponse,
  ReplayOs,
  ReplayOtaUpdates,
  ReplayRelatedIssue,
  ReplayRelatedTrace,
  ReplaySdk,
  ReplayStringProjectId,
  ReplayUser,
} from "./replay.js";
export {
  REPLAY_LIST_FIELDS,
  ReplayBrowserSchema,
  ReplayDetailsResponseSchema,
  ReplayDetailsSchema,
  ReplayDeviceSchema,
  ReplayGeoSchema,
  ReplayIdsByResourceSchema,
  ReplayListItemSchema,
  ReplayListResponseSchema,
  ReplayOsSchema,
  ReplayOtaUpdatesSchema,
  ReplaySdkSchema,
  ReplayUserSchema,
} from "./replay.js";
export type {
  AutofixResponse,
  AutofixState,
  RootCause,
  SolutionArtifact,
} from "./seer.js";
// Seer types
export {
  extractRootCauses,
  extractSolution,
  isTerminalStatus,
  SolutionArtifactSchema,
  TERMINAL_STATUSES,
} from "./seer.js";
// Sentry API types (SDK-derived + internal)
export type {
  Breadcrumb,
  BreadcrumbsEntry,
  BrowserContext,
  CustomerTrialInfo,
  DetailedLogsResponse,
  DetailedSentryLog,
  DeviceContext,
  ExceptionEntry,
  ExceptionValue,
  IssueEvent,
  IssueLevel,
  IssueStatus,
  LogsResponse,
  Mechanism,
  MonitorConfig,
  OrgAuthToken,
  OsContext,
  ProductTrial,
  ProjectKey,
  Region,
  ReplayContext,
  RepositoryProvider,
  RequestEntry,
  SentryDeploy,
  SentryEvent,
  SentryIntegration,
  SentryIssue,
  SentryLog,
  SentryMonitor,
  SentryOrganization,
  SentryProject,
  ReleaseUpdateOutput,
  SentryRelease,
  SentryRepository,
  SentryTeam,
  SentryUser,
  SpanListItem,
  SpansResponse,
  StackFrame,
  Stacktrace,
  TraceContext,
  TraceItemAttribute,
  TraceItemDetail,
  TraceLog,
  TraceLogsResponse,
  TraceMeta,
  TraceSpan,
  TransactionListItem,
  TransactionsResponse,
  UserRegionsResponse,
} from "./sentry.js";
export {
  CustomerTrialInfoSchema,
  DetailedLogsResponseSchema,
  DetailedSentryLogSchema,
  DsnLookupResponseSchema,
  type EventViewAttachment,
  ISSUE_LEVELS,
  ISSUE_STATUSES,
  LogsResponseSchema,
  OrgAuthTokenSchema,
  ProductTrialSchema,
  RegionSchema,
  SentryLogSchema,
  SentryUserSchema,
  SpansResponseSchema,
  TraceItemAttributeSchema,
  TraceItemDetailSchema,
  TraceLogSchema,
  TraceLogsResponseSchema,
  TraceMetaSchema,
  TransactionListItemSchema,
  TransactionsResponseSchema,
  UserRegionsResponseSchema,
} from "./sentry.js";

export type { WithOutputFields } from "../output-schemas/output.js";

// I/O types

/**
 * Simple writer interface for output streams.
 * Compatible with process.stdout, process.stderr, and test mocks.
 * Avoids dependency on Node.js-specific types like NodeJS.WriteStream.
 *
 * `write` accepts `Uint8Array` so binary command output (e.g. `sentry api`
 * attachment downloads) can stream raw bytes without a string round-trip.
 * Optional `isTTY` mirrors Node write streams for TTY-aware warnings.
 */
export type Writer = {
  write(data: string | Uint8Array): void;
  /**
   * Zero-copy object capture for library mode.
   * When set, JSON objects are passed directly instead of serialized.
   */
  captureObject?: (obj: unknown) => void;
  /** True when the underlying stream is a TTY (optional; set on process streams). */
  readonly isTTY?: boolean;
};
