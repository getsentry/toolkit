import { conversationRoute } from "./commands/agent-conversation/index.js";
import { listCommand as conversationListCommand } from "./commands/agent-conversation/list.js";
import { alertRoute } from "./commands/alert/index.js";
import { apiCommand } from "./commands/api.js";
import { attributeRoute } from "./commands/attribute/index.js";
import { listCommand as attributeListCommand } from "./commands/attribute/list.js";
import { authRoute } from "./commands/auth/index.js";
import { whoamiCommand } from "./commands/auth/whoami.js";
import { bashHookCommand } from "./commands/bash-hook.js";
import { buildRoute } from "./commands/build/index.js";
import { cliRoute } from "./commands/cli/index.js";
import { codeMappingsRoute } from "./commands/code-mappings/index.js";
import { dartSymbolMapRoute } from "./commands/dart-symbol-map/index.js";
import { dashboardRoute } from "./commands/dashboard/index.js";
import { listCommand as dashboardListCommand } from "./commands/dashboard/list.js";
import { debugFilesRoute } from "./commands/debug-files/index.js";
import { docsRoute } from "./commands/docs/index.js";
import { dsnRoute } from "./commands/dsn/index.js";
import { listCommand as dsnListCommand } from "./commands/dsn/list.js";
import { eventRoute } from "./commands/event/index.js";
import { listCommand as eventListCommand } from "./commands/event/list.js";
import { exploreCommand } from "./commands/explore.js";
import { feedbackRoute } from "./commands/feedback/index.js";
import { helpCommand } from "./commands/help.js";
import { infoCommand } from "./commands/info.js";
import { initCommand } from "./commands/init.js";
import { integrationRoute } from "./commands/integration/index.js";
import { listCommand as integrationListCommand } from "./commands/integration/list.js";
import { issueRoute } from "./commands/issue/index.js";
import { listCommand as issueListCommand } from "./commands/issue/list.js";
import { localRoute } from "./commands/local/index.js";
import { logRoute } from "./commands/log/index.js";
import { listCommand as logListCommand } from "./commands/log/list.js";
import { mcpCommand } from "./commands/mcp.js";
import { monitorRoute } from "./commands/monitor/index.js";
import { listCommand as monitorListCommand } from "./commands/monitor/list.js";
import { orgRoute } from "./commands/org/index.js";
import { listCommand as orgListCommand } from "./commands/org/list.js";
import { platformRoute } from "./commands/platform/index.js";
import { listCommand as platformListCommand } from "./commands/platform/list.js";
import { proguardRoute } from "./commands/proguard/index.js";
import { projectRoute } from "./commands/project/index.js";
import { listCommand as projectListCommand } from "./commands/project/list.js";
import { reactNativeRoute } from "./commands/react-native/index.js";
import { releaseRoute } from "./commands/release/index.js";
import { listCommand as releaseListCommand } from "./commands/release/list.js";
import { replayRoute } from "./commands/replay/index.js";
import { listCommand as replayListCommand } from "./commands/replay/list.js";
import { repoRoute } from "./commands/repo/index.js";
import { listCommand as repoListCommand } from "./commands/repo/list.js";
import { schemaCommand } from "./commands/schema.js";
import { sendEnvelopeCommand } from "./commands/send-envelope.js";
import { sendEventCommand } from "./commands/send-event.js";
import { snapshotsRoute } from "./commands/snapshots/index.js";
import { sourcemapRoute } from "./commands/sourcemap/index.js";
import { spanRoute } from "./commands/span/index.js";
import { listCommand as spanListCommand } from "./commands/span/list.js";
import { statusRoute } from "./commands/status/index.js";
import { teamRoute } from "./commands/team/index.js";
import { listCommand as teamListCommand } from "./commands/team/list.js";
import { traceRoute } from "./commands/trace/index.js";
import { listCommand as traceListCommand } from "./commands/trace/list.js";
import { trialRoute } from "./commands/trial/index.js";
import { listCommand as trialListCommand } from "./commands/trial/list.js";
import { wasmSplitCommand } from "./commands/wasm-split.js";
import { buildCliApplication } from "./lib/application.js";
import { setGraphicsBanner } from "./lib/help.js";
import { buildRouteMap } from "./lib/route-map.js";
import { graphicsBanner, graphicsBannerExtraRows } from "./lib/sixel.js";

/**
 * Plural alias → singular route name mapping.
 * Used to suggest the correct command when users type e.g. `sentry projects view cli`.
 */
const PLURAL_TO_SINGULAR: Record<string, string> = {
  "agent-conversations": "agent-conversation",
  attributes: "attribute",
  dashboards: "dashboard",
  dsns: "dsn",
  events: "event",
  integrations: "integration",
  issues: "issue",
  orgs: "org",
  platforms: "platform",
  projects: "project",
  releases: "release",
  repos: "repo",
  teams: "team",
  logs: "log",
  monitors: "monitor",
  replays: "replay",

  spans: "span",
  traces: "trace",
  trials: "trial",
};

/** Top-level route map containing all CLI commands */
export const routes = buildRouteMap({
  routes: {
    help: helpCommand,
    alert: alertRoute,
    attribute: attributeRoute,
    auth: authRoute,
    build: buildRoute,
    cli: cliRoute,
    "code-mappings": codeMappingsRoute,
    "agent-conversation": conversationRoute,
    "dart-symbol-map": dartSymbolMapRoute,
    "debug-files": debugFilesRoute,
    dashboard: dashboardRoute,
    docs: docsRoute,
    dsn: dsnRoute,
    org: orgRoute,
    platform: platformRoute,
    project: projectRoute,
    proguard: proguardRoute,
    "react-native": reactNativeRoute,
    replay: replayRoute,
    release: releaseRoute,
    repo: repoRoute,
    team: teamRoute,
    integration: integrationRoute,
    issue: issueRoute,
    event: eventRoute,
    events: eventListCommand,
    explore: exploreCommand,
    feedback: feedbackRoute,
    log: logRoute,
    mcp: mcpCommand,
    monitor: monitorRoute,
    snapshots: snapshotsRoute,
    sourcemap: sourcemapRoute,
    sourcemaps: sourcemapRoute,
    span: spanRoute,
    status: statusRoute,
    trace: traceRoute,
    trial: trialRoute,
    init: initCommand,
    info: infoCommand,
    local: localRoute,
    api: apiCommand,
    schema: schemaCommand,
    "wasm-split": wasmSplitCommand,
    // Backward-compat aliases for old sentry-cli — hidden from help
    "send-event": sendEventCommand,
    "send-envelope": sendEnvelopeCommand,
    "bash-hook": bashHookCommand,
    "agent-conversations": conversationListCommand,
    attributes: attributeListCommand,
    dashboards: dashboardListCommand,
    dsns: dsnListCommand,
    integrations: integrationListCommand,
    issues: issueListCommand,
    orgs: orgListCommand,
    platforms: platformListCommand,
    projects: projectListCommand,
    replays: replayListCommand,
    releases: releaseListCommand,
    repos: repoListCommand,
    teams: teamListCommand,
    logs: logListCommand,
    monitors: monitorListCommand,
    spans: spanListCommand,
    traces: traceListCommand,
    trials: trialListCommand,
    whoami: whoamiCommand,
  },
  defaultCommand: "help",
  docs: {
    brief: "A gh-like CLI for Sentry",
    fullDescription:
      "sentry is a command-line interface for interacting with Sentry. " +
      "It provides commands for authentication, viewing issues, and making API calls.",
    hideRoute: {
      dsns: true,
      "agent-conversations": true,
      attributes: true,
      dashboards: true,
      events: true,
      integrations: true,
      issues: true,
      orgs: true,
      platforms: true,
      projects: true,
      replays: true,
      releases: true,
      repos: true,
      teams: true,
      logs: true,
      monitors: true,
      spans: true,
      traces: true,
      trials: true,
      sourcemaps: true,
      whoami: true,
      "send-event": true,
      "send-envelope": true,
      "bash-hook": true,
    },
  },
});

export const app = buildCliApplication(routes, {
  pluralAliases: PLURAL_TO_SINGULAR,
});

// Help shows the kitty/sixel image banner on capable terminals. Registered
// here rather than imported by `lib/help.ts`, so applications without it
// (`@sentry/mcp-server`) leave the image code out of their bundle.
setGraphicsBanner({
  render: graphicsBanner,
  extraRows: graphicsBannerExtraRows,
});
