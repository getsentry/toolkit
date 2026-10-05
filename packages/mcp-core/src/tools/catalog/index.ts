import whoami from "./whoami";
import getSentryMcpInfo from "./get-sentry-mcp-info";
import findOrganizations from "./find-organizations";
import findTeams from "./find-teams";
import findProjects from "./find-projects";
import findReleases from "./find-releases";
import getReleaseDetails from "./get-release-details";
import findDashboards from "./find-dashboards";
import getDashboardDetails from "./get-dashboard-details";
import findMonitors from "./find-monitors";
import getMonitorDetails from "./get-monitor-details";
import findUptimeMonitors from "./find-uptime-monitors";
import getUptimeMonitorDetails from "./get-uptime-monitor-details";
import findMetricMonitors from "./find-metric-monitors";
import getMetricMonitorDetails from "./get-metric-monitor-details";
import createMetricMonitor from "./create-metric-monitor";
import updateMetricMonitor from "./update-metric-monitor";
import deleteMetricMonitor from "./delete-metric-monitor";
import createUptimeMonitor from "./create-uptime-monitor";
import updateUptimeMonitor from "./update-uptime-monitor";
import deleteUptimeMonitor from "./delete-uptime-monitor";
import findAlertRules from "./find-alert-rules";
import getAlertRule from "./get-alert-rule";
import getAlertOptions from "./get-alert-options";
import updateAlertRule from "./update-alert-rule";
import createAlertRule from "./create-alert-rule";
import deleteAlertRule from "./delete-alert-rule";
import getIssueDetails from "./get-issue-details";
import getEventStacktrace from "./get-event-stacktrace";
import getIssueActivity from "./get-issue-activity";
import getIssueBreadcrumbs from "./get-issue-breadcrumbs";
import getIssueTagValues from "./get-issue-tag-values";
import getIssueUserReports from "./get-issue-user-reports";
import getTraceDetails from "./get-trace-details";
import getSpanDetails from "./get-span-details";
import getReplayDetails from "./get-replay-details";
import getEventAttachment from "./get-event-attachment";
import updateIssue from "./update-issue";
import linkIssue from "./link-issue";
import unlinkIssue from "./unlink-issue";
import searchEvents from "./search-events";
import searchErrors from "./search-errors";
import searchLogs from "./search-logs";
import searchTraces from "./search-traces";
import searchMetrics from "./search-metrics";
import searchProfiles from "./search-profiles";
import searchReplays from "./search-replays";
import createTeam from "./create-team";
import createProject from "./create-project";
import updateProject from "./update-project";
import addTeamToProject from "./add-team-to-project";
import removeTeamFromProject from "./remove-team-from-project";
import createDsn from "./create-dsn";
import findDsns from "./find-dsns";
import updateDsn from "./update-dsn";
import analyzeIssueWithSeer from "./analyze-issue-with-seer";
import searchDocs from "./search-docs";
import getDoc from "./get-doc";
import searchIssues from "./search-issues";
import searchIssueEvents from "./search-issue-events";
import getProfile from "./get-profile";
import getProfileDetails from "./get-profile-details";
import getSentryResource from "./get-sentry-resource";
import getSnapshot from "./get-snapshot";
import getSnapshotImage from "./get-snapshot-image";
import getLatestBaseSnapshot from "./get-latest-base-snapshot";
import getAgentConversationDetails from "./get-agent-conversation-details";
import searchAgentConversations from "./search-agent-conversations";
import addIssueNote from "./add-issue-note";
import onboardingStatusUpdate from "./onboarding-status-update";
import type { ToolConfig } from "../types";

const legacyGetAIConversationDetails = {
  ...getAgentConversationDetails,
  name: "get_ai_conversation_details",
  includeInSkillDefinitions: false,
  description: [
    "Deprecated alias for get_agent_conversation_details.",
    "",
    "Use get_agent_conversation_details for new integrations. This alias is kept for backward compatibility.",
  ].join("\n"),
} satisfies ToolConfig<any>;

const legacySearchAIConversations = {
  ...searchAgentConversations,
  name: "search_ai_conversations",
  includeInSkillDefinitions: false,
  description: [
    "Deprecated alias for search_agent_conversations.",
    "",
    "Use search_agent_conversations for new integrations. This alias is kept for backward compatibility.",
  ].join("\n"),
} satisfies ToolConfig<any>;

/**
 * Catalog of ordinary Sentry MCP operations.
 *
 * These tools are searchable/executable through search_sentry_tools and execute_sentry_tool.
 * A central subset is also exposed directly via tools/list in surfaces.ts.
 *
 * Wrapper tools such as search_sentry_tools and execute_sentry_tool intentionally
 * live outside this catalog.
 */
const catalogTools = {
  whoami,
  find_organizations: findOrganizations,
  find_teams: findTeams,
  find_projects: findProjects,
  find_releases: findReleases,
  get_release_details: getReleaseDetails,
  find_dashboards: findDashboards,
  get_dashboard_details: getDashboardDetails,
  find_monitors: findMonitors,
  get_monitor_details: getMonitorDetails,
  find_uptime_monitors: findUptimeMonitors,
  get_uptime_monitor_details: getUptimeMonitorDetails,
  find_metric_monitors: findMetricMonitors,
  get_metric_monitor_details: getMetricMonitorDetails,
  create_metric_monitor: createMetricMonitor,
  update_metric_monitor: updateMetricMonitor,
  delete_metric_monitor: deleteMetricMonitor,
  create_uptime_monitor: createUptimeMonitor,
  update_uptime_monitor: updateUptimeMonitor,
  delete_uptime_monitor: deleteUptimeMonitor,
  find_alert_rules: findAlertRules,
  get_alert_rule: getAlertRule,
  get_alert_options: getAlertOptions,
  update_alert_rule: updateAlertRule,
  create_alert_rule: createAlertRule,
  delete_alert_rule: deleteAlertRule,
  get_issue_details: getIssueDetails,
  get_event_stacktrace: getEventStacktrace,
  get_issue_activity: getIssueActivity,
  get_issue_breadcrumbs: getIssueBreadcrumbs,
  get_issue_user_reports: getIssueUserReports,
  get_issue_tag_values: getIssueTagValues,
  get_trace_details: getTraceDetails,
  get_span_details: getSpanDetails,
  get_replay_details: getReplayDetails,
  get_event_attachment: getEventAttachment,
  update_issue: updateIssue,
  link_issue: linkIssue,
  unlink_issue: unlinkIssue,
  search_errors: searchErrors,
  search_logs: searchLogs,
  search_traces: searchTraces,
  search_metrics: searchMetrics,
  search_profiles: searchProfiles,
  search_replays: searchReplays,
  search_events: searchEvents,
  create_team: createTeam,
  create_project: createProject,
  update_project: updateProject,
  add_team_to_project: addTeamToProject,
  remove_team_from_project: removeTeamFromProject,
  create_dsn: createDsn,
  find_dsns: findDsns,
  update_dsn: updateDsn,
  analyze_issue_with_seer: analyzeIssueWithSeer,
  search_docs: searchDocs,
  get_doc: getDoc,
  search_issues: searchIssues,
  search_issue_events: searchIssueEvents,
  get_profile: getProfile,
  get_profile_details: getProfileDetails,
  get_sentry_mcp_info: getSentryMcpInfo,
  get_sentry_resource: getSentryResource,
  get_snapshot: getSnapshot,
  get_snapshot_image: getSnapshotImage,
  get_latest_base_snapshot: getLatestBaseSnapshot,
  get_agent_conversation_details: getAgentConversationDetails,
  get_ai_conversation_details: legacyGetAIConversationDetails,
  search_agent_conversations: searchAgentConversations,
  search_ai_conversations: legacySearchAIConversations,
  add_issue_note: addIssueNote,
  onboarding_status_update: onboardingStatusUpdate,
} as const satisfies Record<string, ToolConfig<any>>;

export default catalogTools;
export type CatalogToolName = keyof typeof catalogTools;
