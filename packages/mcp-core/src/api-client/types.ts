/**
 * TypeScript type definitions derived from Zod schemas.
 *
 * This module provides strongly-typed interfaces for all Sentry API data
 * structures. Types are automatically derived from their corresponding
 * Zod schemas using `z.infer<>`, ensuring perfect synchronization between
 * runtime validation and compile-time type checking.
 *
 * Type Categories:
 * - **Core Resources**: User, Organization, Team, Project
 * - **Issue Management**: Issue, Event, AssignedTo
 * - **Release Management**: Release
 * - **Search & Discovery**: Tag
 * - **Integrations**: ClientKey, AutofixRun, AutofixRunState
 *
 * Array Types:
 * All list types follow the pattern `ResourceList = Resource[]` for consistency.
 *
 * @example Type Usage
 * ```typescript
 * import type { Issue, IssueList } from "./types";
 *
 * function processIssues(issues: IssueList): void {
 *   issues.forEach((issue: Issue) => {
 *     console.log(`${issue.shortId}: ${issue.title}`);
 *   });
 * }
 * ```
 *
 * @example API Response Typing
 * ```typescript
 * async function getIssue(id: string): Promise<Issue> {
 *   const response = await apiService.getIssue({
 *     organizationSlug: "my-org",
 *     issueId: id
 *   });
 *   return response; // Already typed as Issue from schema validation
 * }
 * ```
 */
import type { z } from "zod";
import type {
  AgenticOnboardingRunSchema,
  AgenticOnboardingStatusUpdateSchema,
  AIConversationDetailsResponseSchema,
  AIConversationSpanListSchema,
  AIConversationSpanSchema,
  AIConversationSummaryListSchema,
  AIConversationSummarySchema,
  AIConversationUserSchema,
  AlertActionOptionSchema,
  AlertConditionOptionSchema,
  AlertRuleProjectScopeSchema,
  AssignedToSchema,
  AutofixRunSchema,
  AutofixRunStateSchema,
  SearchAgentStartSchema,
  SearchAgentStateSchema,
  ClientKeyListSchema,
  ClientKeySchema,
  CommitListSchema,
  CommitSchema,
  CommittersResponseSchema,
  DashboardListItemSchema,
  DashboardSchema,
  DashboardWidgetSchema,
  DefaultEventSchema,
  DeployListSchema,
  DeploySchema,
  DetectorSchema,
  ErrorEventSchema,
  EventAttachmentListSchema,
  EventAttachmentSchema,
  EventSchema,
  ExternalIssueListSchema,
  ExternalIssueSchema,
  FlamegraphFrameInfoSchema,
  FlamegraphFrameSchema,
  FlamegraphProfileMetadataSchema,
  FlamegraphProfileSchema,
  FlamegraphSchema,
  GenericEventSchema,
  IssueActivityListResponseSchema,
  IssueActivitySchema,
  IssueAlertRuleListSchema,
  IssueAlertRuleSchema,
  IssueCommentListSchema,
  IssueCommentSchema,
  IssueIntegrationListSchema,
  IssueIntegrationSchema,
  IssueListSchema,
  IssueSchema,
  IssueTagValuesSchema,
  MetricAlertRuleListSchema,
  MetricAlertRuleSchema,
  MonitorCheckInListSchema,
  MonitorCheckInSchema,
  MonitorListSchema,
  MonitorSchema,
  MonitorStatSchema,
  MonitorStatsSchema,
  NativeExternalIssueSchema,
  OrganizationEnvironmentListSchema,
  OrganizationListSchema,
  OrganizationSchema,
  ProfileChunkResponseSchema,
  ProfileChunkSampleSchema,
  ProfileChunkSchema,
  ProfileFrameSchema,
  ProjectListSchema,
  ProjectRepositoryMappingSchema,
  ProjectSchema,
  ReleaseDetailsSchema,
  ReleaseListSchema,
  ReleaseSchema,
  ReplayDetailsSchema,
  ReplayListResponseSchema,
  ReplayRecordingEventSchema,
  ReplayRecordingSegmentsSchema,
  SentryAppComponentListSchema,
  SentryAppExternalRequestOptionsSchema,
  SentryAppInstallationListSchema,
  StacktraceLinkSchema,
  TagListSchema,
  TagSchema,
  TeamListSchema,
  TeamSchema,
  TraceIssueSchema,
  TraceMetaSchema,
  TraceSchema,
  TraceSpanSchema,
  TransactionEventSchema,
  TransactionProfileSampleSchema,
  TransactionProfileSchema,
  UnknownEventSchema,
  UptimeCheckListSchema,
  UptimeCheckSchema,
  UptimeMonitorListSchema,
  UptimeMonitorSchema,
  UserReportListSchema,
  UserSchema,
} from "./schema";

export type AgenticOnboardingRun = z.infer<typeof AgenticOnboardingRunSchema>;
export type AgenticOnboardingStatusUpdate = z.infer<
  typeof AgenticOnboardingStatusUpdateSchema
>;
export type User = z.infer<typeof UserSchema>;
export type Organization = z.infer<typeof OrganizationSchema>;
export type Team = z.infer<typeof TeamSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectRepositoryMapping = z.infer<
  typeof ProjectRepositoryMappingSchema
>;
export type IssueAlertRule = z.infer<typeof IssueAlertRuleSchema>;
export type AlertActionOption = z.infer<typeof AlertActionOptionSchema>;
export type AlertConditionOption = z.infer<typeof AlertConditionOptionSchema>;
export type AlertRuleProjectScope = z.infer<typeof AlertRuleProjectScopeSchema>;
export type Detector = z.infer<typeof DetectorSchema>;
export type MetricMonitorUpdate = {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  owner?: string | null;
  workflowIds?: string[];
  config?: Record<string, unknown>;
  conditionGroup?: {
    id?: string | number;
    logicType: string;
    conditions: Array<{
      id?: string | number;
      type: string;
      comparison: unknown;
      conditionResult: unknown;
    }>;
  };
  dataSources?: Array<{
    dataset: string;
    query: string;
    aggregate: string;
    timeWindow: number;
    environment: string | null;
    eventTypes: string[];
    extrapolationMode?: string | null;
  }>;
};
export type MetricMonitorCreate = Pick<
  MetricMonitorUpdate,
  "description" | "owner"
> &
  Required<
    Pick<
      MetricMonitorUpdate,
      "name" | "config" | "conditionGroup" | "dataSources" | "workflowIds"
    >
  > & { type: "metric_issue" };
export type AlertRuleUpdate = {
  name: string;
  enabled: boolean;
  config?: Record<string, unknown>;
  environment?: string | null;
  owner?: string | null;
  triggers?: NonNullable<IssueAlertRule["triggers"]>;
  actionFilters?: NonNullable<IssueAlertRule["actionFilters"]>;
  detectorIds?: string[];
};
export type AlertRuleCreate = AlertRuleUpdate & { detectorIds: string[] };
export type MetricAlertRule = z.infer<typeof MetricAlertRuleSchema>;
export type ClientKey = z.infer<typeof ClientKeySchema>;
export type Release = z.infer<typeof ReleaseSchema>;
export type ReleaseDetails = z.infer<typeof ReleaseDetailsSchema>;
export type Deploy = z.infer<typeof DeploySchema>;
export type Commit = z.infer<typeof CommitSchema>;
export type Issue = z.infer<typeof IssueSchema>;
export type IssueActivity = z.infer<typeof IssueActivitySchema>;
export type IssueComment = z.infer<typeof IssueCommentSchema>;
export type Monitor = z.infer<typeof MonitorSchema>;
export type MonitorCheckIn = z.infer<typeof MonitorCheckInSchema>;
export type MonitorStat = z.infer<typeof MonitorStatSchema>;
export type UptimeMonitor = z.infer<typeof UptimeMonitorSchema>;
export type UptimeCheck = z.infer<typeof UptimeCheckSchema>;

// Individual event types
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
export type DefaultEvent = z.infer<typeof DefaultEventSchema>;
export type TransactionEvent = z.infer<typeof TransactionEventSchema>;
export type GenericEvent = z.infer<typeof GenericEventSchema>;
export type UnknownEvent = z.infer<typeof UnknownEventSchema>;

// Event union - use RawEvent for parsing, Event for all event types including unknown
export type RawEvent = z.infer<typeof EventSchema>;
export type Event =
  | ErrorEvent
  | DefaultEvent
  | TransactionEvent
  | GenericEvent
  | UnknownEvent;
export type StacktraceLink = z.infer<typeof StacktraceLinkSchema>;

export type EventAttachment = z.infer<typeof EventAttachmentSchema>;
export type Tag = z.infer<typeof TagSchema>;
export type AutofixRun = z.infer<typeof AutofixRunSchema>;
export type AutofixRunState = z.infer<typeof AutofixRunStateSchema>;
export type SearchAgentStart = z.infer<typeof SearchAgentStartSchema>;
export type SearchAgentState = z.infer<typeof SearchAgentStateSchema>;
export type AssignedTo = z.infer<typeof AssignedToSchema>;
export type ReplayDetails = z.infer<typeof ReplayDetailsSchema>;
export type ReplayList = z.infer<typeof ReplayListResponseSchema>["data"];
export type ReplayRecordingEvent = z.infer<typeof ReplayRecordingEventSchema>;
export type ReplayRecordingSegments = z.infer<
  typeof ReplayRecordingSegmentsSchema
>;

export type OrganizationList = z.infer<typeof OrganizationListSchema>;
export type TeamList = z.infer<typeof TeamListSchema>;
export type ProjectList = z.infer<typeof ProjectListSchema>;
export type IssueAlertRuleList = z.infer<typeof IssueAlertRuleListSchema>;
export type MetricAlertRuleList = z.infer<typeof MetricAlertRuleListSchema>;
export type ReleaseList = z.infer<typeof ReleaseListSchema>;
export type DeployList = z.infer<typeof DeployListSchema>;
export type CommitList = z.infer<typeof CommitListSchema>;
export type CommitterList = z.infer<
  typeof CommittersResponseSchema
>["committers"];
export type IssueList = z.infer<typeof IssueListSchema>;
export type IssueActivityList = z.infer<
  typeof IssueActivityListResponseSchema
>["activity"];
export type IssueCommentList = z.infer<typeof IssueCommentListSchema>;
export type MonitorList = z.infer<typeof MonitorListSchema>;
export type MonitorCheckInList = z.infer<typeof MonitorCheckInListSchema>;
export type MonitorStats = z.infer<typeof MonitorStatsSchema>;
export type UptimeMonitorList = z.infer<typeof UptimeMonitorListSchema>;
export type UptimeCheckList = z.infer<typeof UptimeCheckListSchema>;
export type EventAttachmentList = z.infer<typeof EventAttachmentListSchema>;
export type OrganizationEnvironmentList = z.infer<
  typeof OrganizationEnvironmentListSchema
>;
export type TagList = z.infer<typeof TagListSchema>;
export type ClientKeyList = z.infer<typeof ClientKeyListSchema>;

// Dashboard types
export type Dashboard = z.infer<typeof DashboardSchema>;
export type DashboardListItem = z.infer<typeof DashboardListItemSchema>;
export type DashboardWidget = z.infer<typeof DashboardWidgetSchema>;

// Trace types
export type TraceMeta = z.infer<typeof TraceMetaSchema>;
export type TraceSpan = z.infer<typeof TraceSpanSchema>;
export type TraceIssue = z.infer<typeof TraceIssueSchema>;
export type Trace = z.infer<typeof TraceSchema>;
export type AIConversationSpan = z.infer<typeof AIConversationSpanSchema>;
export type AIConversationSpanList = z.infer<
  typeof AIConversationSpanListSchema
>;
export type AIConversationDetails = z.infer<
  typeof AIConversationDetailsResponseSchema
>;
export type AIConversationUser = z.infer<typeof AIConversationUserSchema>;
export type AIConversationSummary = z.infer<typeof AIConversationSummarySchema>;
export type AIConversationSummaryList = z.infer<
  typeof AIConversationSummaryListSchema
>;

// Profile types
export type Flamegraph = z.infer<typeof FlamegraphSchema>;
export type FlamegraphFrame = z.infer<typeof FlamegraphFrameSchema>;
export type FlamegraphFrameInfo = z.infer<typeof FlamegraphFrameInfoSchema>;
export type FlamegraphProfile = z.infer<typeof FlamegraphProfileSchema>;
export type FlamegraphProfileMetadata = z.infer<
  typeof FlamegraphProfileMetadataSchema
>;
export type ProfileChunk = z.infer<typeof ProfileChunkSchema>;
export type ProfileChunkResponse = z.infer<typeof ProfileChunkResponseSchema>;
export type ProfileChunkSample = z.infer<typeof ProfileChunkSampleSchema>;
export type TransactionProfile = z.infer<typeof TransactionProfileSchema>;
export type TransactionProfileSample = z.infer<
  typeof TransactionProfileSampleSchema
>;
export type ProfileFrame = z.infer<typeof ProfileFrameSchema>;

// Issue tag values
export type IssueTagValues = z.infer<typeof IssueTagValuesSchema>;

// External issue links (Jira, GitHub, etc.)
export type ExternalIssue = z.infer<typeof ExternalIssueSchema>;
export type ExternalIssueList = z.infer<typeof ExternalIssueListSchema>;
export type IssueIntegration = z.infer<typeof IssueIntegrationSchema>;
export type IssueIntegrationList = z.infer<typeof IssueIntegrationListSchema>;
export type NativeExternalIssue = z.infer<typeof NativeExternalIssueSchema>;
export type SentryAppInstallationList = z.infer<
  typeof SentryAppInstallationListSchema
>;
export type SentryAppComponentList = z.infer<
  typeof SentryAppComponentListSchema
>;
export type SentryAppExternalRequestOptions = z.infer<
  typeof SentryAppExternalRequestOptionsSchema
>;

// User Report
export type UserReportList = z.infer<typeof UserReportListSchema>;
