/**
 * Sentry API Client — barrel re-export
 *
 * All domain modules are re-exported here so existing imports
 * (`import { ... } from "./api-client.js"`) continue to work.
 *
 * Domain modules live in `src/lib/api/` and are organized by entity:
 * - infrastructure: shared helpers, types, constants, raw request functions
 * - conversations: agent conversation listing and detail
 * - organizations: org CRUD and region discovery
 * - projects: project CRUD, search, DSN keys
 * - teams: team CRUD, project teams
 * - repositories: repository listing
 * - issues: issue listing, lookup, status updates
 * - events: event retrieval and resolution
 * - replays: replay listing and detail lookup
 * - traces: trace details and transactions
 * - logs: log listing, detailed fetch, trace-logs
 * - seer: Seer AI root cause analysis and planning
 * - trials: product trial management
 * - users: current user info
 */

export {
  createIssueAlertRule,
  createMetricAlertRule,
  deleteIssueAlertRule,
  deleteMetricAlertRule,
  getIssueAlertRule,
  getIssueAlertWorkflowDocument,
  getMetricAlertRule,
  getMetricAlertRuleDocument,
  type IssueAlertRule,
  listIssueAlertsPaginated,
  listMetricAlertsPaginated,
  type MetricAlertRule,
  putMetricAlertRule,
  resolveErrorDetectorId,
  updateIssueAlertRule,
} from "./api/alerts.js";
export {
  getConversationSpans,
  listConversations,
} from "./api/conversations.js";
export {
  createDashboard,
  getDashboard,
  listDashboardRevisionsPaginated,
  listDashboardsPaginated,
  queryAllWidgets,
  restoreDashboardRevision,
  updateDashboard,
} from "./api/dashboards.js";
export { isNotFoundApiError } from "./api/error-guards.js";
export {
  findEventAcrossOrgs,
  getEvent,
  getLatestEvent,
  listEventAttachments,
  listIssueEvents,
  type ResolvedEvent,
  resolveEventInOrg,
} from "./api/events.js";
export type { MetricMeta } from "./api/explore.js";
export { queryEvents, queryMetricsMeta } from "./api/explore.js";
export {
  buildFeedbackQuery,
  type FeedbackPage,
  type FeedbackStatus,
  type ListFeedbackOptions,
  listFeedback,
} from "./api/feedback.js";
export {
  API_MAX_PER_PAGE,
  type ApiRequestOptions,
  apiRequest,
  apiRequestToRegion,
  apiRequestToRegionNoContent,
  appendSearchParams,
  autoPaginate,
  buildSearchParams,
  isTextualContentType,
  ORG_FANOUT_CONCURRENCY,
  type PaginatedResponse,
  parseLinkHeader,
  rawApiRequest,
} from "./api/infrastructure.js";
export {
  buildIssueListCollapse,
  getIssue,
  getIssueByShortId,
  getIssueInOrg,
  getSharedIssue,
  type IgnoreStatusDetails,
  ISSUE_DETAIL_COLLAPSE,
  type IssueCollapseField,
  type IssueSort,
  type IssuesPage,
  listIssuesAllPages,
  listIssuesPaginated,
  type MergeIssuesResult,
  mergeIssues,
  type ParsedResolveSpec,
  parseResolveSpec,
  RESOLVE_COMMIT_EXPLICIT_PREFIX,
  RESOLVE_COMMIT_SENTINEL,
  RESOLVE_NEXT_RELEASE_SENTINEL,
  type ResolveCommitSpec,
  type ResolveStatusDetails,
  tryGetIssueByShortId,
  updateIssueStatus,
} from "./api/issues.js";
export {
  getLogItemDetail,
  getLogs,
  type LogSortDirection,
  listLogs,
  listTraceLogs,
} from "./api/logs.js";
export { listMonitors, listMonitorsPaginated } from "./api/monitors.js";
export {
  getOrganization,
  getUserRegions,
  listOrganizations,
  listOrganizationsPage,
  listOrganizationsUncached,
} from "./api/organizations.js";
export {
  type CreatedProjectDetails,
  createProject,
  createProjectWithAutoTeam,
  createProjectWithDsn,
  deleteProject,
  findProjectByDsnKey,
  findProjectsByPattern,
  findProjectsBySlug,
  getProject,
  getProjectKeys,
  listProjects,
  listProjectsAllPages,
  listProjectsPaginated,
  MEMBER_PROJECT_CREATION_DISABLED_DETAIL,
  matchesWordBoundary,
  type ProjectSearchResult,
  type ProjectWithOrg,
  resolveOrgDisplayName,
  tryGetPrimaryDsn,
} from "./api/projects.js";
export {
  createRelease,
  createReleaseDeploy,
  deleteRelease,
  getRelease,
  type ListReleasesOptions,
  listProjectEnvironments,
  listReleaseDeploys,
  listReleasesForProject,
  listReleasesPaginated,
  NO_REPO_INTEGRATIONS_MESSAGE,
  type ReleaseSortValue,
  setCommitsAuto,
  setCommitsLocal,
  setCommitsWithRefs,
  updateRelease,
} from "./api/releases.js";
export {
  getReplay,
  getReplayRecordingSegments,
  isReplaySortValue,
  type ListReplaysOptions,
  listReplayIdsForIssue,
  listReplays,
  REPLAY_SORT_FIELDS,
  type ReplaySortField,
  type ReplaySortValue,
  resolveReplay,
} from "./api/replays.js";
export {
  listAllRepositories,
  listRepositories,
  listRepositoriesCached,
  listRepositoriesPaginated,
} from "./api/repositories.js";
export {
  getAutofixState,
  triggerRootCauseAnalysis,
  triggerSolutionPlanning,
} from "./api/seer.js";
export {
  addMemberToTeam,
  createTeam,
  listProjectTeams,
  listTeams,
  listTeamsPaginated,
} from "./api/teams.js";
export type {
  FetchMultiSpanDetailsOptions,
  TraceItemAttribute,
  TraceItemDetail,
} from "./api/traces.js";
export {
  attributesToDict,
  fetchMultiSpanDetails,
  getDetailedTrace,
  getSpanDetails,
  getTraceMeta,
  listSpans,
  listTransactions,
  normalizeTraceSpan,
  REDUNDANT_DETAIL_ATTRS,
} from "./api/traces.js";
export {
  getCustomerTrialInfo,
  getProductTrials,
  startProductTrial,
} from "./api/trials.js";
export { getCurrentUser } from "./api/users.js";
