/**
 * The top-level routes of the `sentry` CLI, in the order help lists them.
 *
 * Each entry says how to load the command or route map that implements it,
 * whether help hides it, and the brief help shows for it. The top-level
 * route maps and commands read their brief from here ({@link topLevelBrief}),
 * so it is written only once. Loading this module loads no command: entries
 * only hold `import()` loaders, which the bundler splits into chunks.
 *
 * `sentry`, `sentry help` and `sentry --help` print the top-level help
 * without loading every command (see `src/root-help-routes.ts`). What else
 * they show (subcommands, usage lines) derives from code, so
 * `script/generate-top-level-routes.ts` generates it.
 *
 * `src/app.ts` builds the full route tree from the same modules, in the same
 * order. `test/lib/command-manifest.test.ts` fails when they disagree.
 */

import type { SentryRoutes } from "./app-root.js";

/** Loads the command or route map of a top-level route. */
export type RouteLoader = () => Promise<SentryRoutes[string]>;

/** A route help lists, with the brief it shows for it. */
export type VisibleManifestEntry = {
  readonly hidden?: undefined;
  readonly brief: string;
  readonly load: RouteLoader;
};

/** A route left out of help: plural aliases, shortcuts, and old names. */
export type HiddenManifestEntry = {
  readonly hidden: true;
  readonly load: RouteLoader;
};

export type ManifestEntry = VisibleManifestEntry | HiddenManifestEntry;

/** Load the export `name` of the module `load` imports. */
function loader<N extends string>(
  load: () => Promise<Record<N, SentryRoutes[string]>>,
  name: N,
): RouteLoader {
  return () => load().then((module) => module[name]);
}

/** A route help lists, implemented by the export `name` of a module. */
function route<N extends string>(
  brief: string,
  load: () => Promise<Record<N, SentryRoutes[string]>>,
  name: N,
): VisibleManifestEntry {
  return { brief, load: loader(load, name) };
}

/** A route help hides, implemented by the export `name` of a module. */
function hidden<N extends string>(
  load: () => Promise<Record<N, SentryRoutes[string]>>,
  name: N,
): HiddenManifestEntry {
  return { hidden: true, load: loader(load, name) };
}

/** Every top-level route of the `sentry` CLI, by name. */
export const COMMAND_MANIFEST: Readonly<Record<string, ManifestEntry>> = {
  help: route(
    "Display help for a command",
    () => import("./commands/help.js"),
    "helpCommand",
  ),
  alert: route(
    "Manage Sentry alert rules",
    () => import("./commands/alert/index.js"),
    "alertRoute",
  ),
  attribute: route(
    "Explore span, log, and metric attributes",
    () => import("./commands/attribute/index.js"),
    "attributeRoute",
  ),
  auth: route(
    "Authenticate with Sentry",
    () => import("./commands/auth/index.js"),
    "authRoute",
  ),
  build: route(
    "Manage mobile build artifacts",
    () => import("./commands/build/index.js"),
    "buildRoute",
  ),
  cli: route(
    "CLI-related commands",
    () => import("./commands/cli/index.js"),
    "cliRoute",
  ),
  "code-mappings": route(
    "Manage code mappings for stack trace linking",
    () => import("./commands/code-mappings/index.js"),
    "codeMappingsRoute",
  ),
  "agent-conversation": route(
    "List and view agent conversations",
    () => import("./commands/agent-conversation/index.js"),
    "conversationRoute",
  ),
  "dart-symbol-map": route(
    "Work with Dart/Flutter symbol maps",
    () => import("./commands/dart-symbol-map/index.js"),
    "dartSymbolMapRoute",
  ),
  "debug-files": route(
    "Work with debug information files",
    () => import("./commands/debug-files/index.js"),
    "debugFilesRoute",
  ),
  dashboard: route(
    "Manage Sentry dashboards",
    () => import("./commands/dashboard/index.js"),
    "dashboardRoute",
  ),
  docs: route(
    "Search and query current Sentry documentation",
    () => import("./commands/docs/index.js"),
    "docsRoute",
  ),
  dsn: route(
    "Find Sentry DSNs",
    () => import("./commands/dsn/index.js"),
    "dsnRoute",
  ),
  org: route(
    "Work with Sentry organizations",
    () => import("./commands/org/index.js"),
    "orgRoute",
  ),
  platform: route(
    "List valid Sentry platform identifiers",
    () => import("./commands/platform/index.js"),
    "platformRoute",
  ),
  project: route(
    "Work with Sentry projects",
    () => import("./commands/project/index.js"),
    "projectRoute",
  ),
  proguard: route(
    "Work with ProGuard/R8 mapping files",
    () => import("./commands/proguard/index.js"),
    "proguardRoute",
  ),
  "react-native": route(
    "Upload React Native sourcemaps from build steps",
    () => import("./commands/react-native/index.js"),
    "reactNativeRoute",
  ),
  replay: route(
    "Search and inspect Session Replays",
    () => import("./commands/replay/index.js"),
    "replayRoute",
  ),
  release: route(
    "Work with Sentry releases",
    () => import("./commands/release/index.js"),
    "releaseRoute",
  ),
  repo: route(
    "Work with Sentry repositories",
    () => import("./commands/repo/index.js"),
    "repoRoute",
  ),
  team: route(
    "Work with Sentry teams",
    () => import("./commands/team/index.js"),
    "teamRoute",
  ),
  integration: route(
    "Work with Sentry integrations",
    () => import("./commands/integration/index.js"),
    "integrationRoute",
  ),
  issue: route(
    "Manage Sentry issues",
    () => import("./commands/issue/index.js"),
    "issueRoute",
  ),
  event: route(
    "View, list, and send Sentry events",
    () => import("./commands/event/index.js"),
    "eventRoute",
  ),
  events: hidden(() => import("./commands/event/list.js"), "listCommand"),
  explore: route(
    "Query aggregate event data (Explore)",
    () => import("./commands/explore.js"),
    "exploreCommand",
  ),
  feedback: route(
    "Manage User Feedback",
    () => import("./commands/feedback/index.js"),
    "feedbackRoute",
  ),
  log: route(
    "View Sentry logs",
    () => import("./commands/log/index.js"),
    "logRoute",
  ),
  mcp: route(
    "Start a local Sentry MCP server",
    () => import("./commands/mcp.js"),
    "mcpCommand",
  ),
  monitor: route(
    "Work with Sentry cron monitors",
    () => import("./commands/monitor/index.js"),
    "monitorRoute",
  ),
  snapshots: route(
    "Manage and compare snapshots",
    () => import("./commands/snapshots/index.js"),
    "snapshotsRoute",
  ),
  sourcemap: route(
    "Manage sourcemaps",
    () => import("./commands/sourcemap/index.js"),
    "sourcemapRoute",
  ),
  sourcemaps: hidden(
    () => import("./commands/sourcemap/index.js"),
    "sourcemapRoute",
  ),
  span: route(
    "List and view spans in projects or traces",
    () => import("./commands/span/index.js"),
    "spanRoute",
  ),
  status: route(
    "Check Sentry service status",
    () => import("./commands/status/index.js"),
    "statusRoute",
  ),
  trace: route(
    "View distributed traces",
    () => import("./commands/trace/index.js"),
    "traceRoute",
  ),
  trial: route(
    "Manage product trials",
    () => import("./commands/trial/index.js"),
    "trialRoute",
  ),
  init: route(
    "Initialize Sentry in your project (experimental)",
    () => import("./commands/init.js"),
    "initCommand",
  ),
  info: route(
    "Print configuration and verify authentication",
    () => import("./commands/info.js"),
    "infoCommand",
  ),
  local: route(
    "Sentry for local development",
    () => import("./commands/local/index.js"),
    "localRoute",
  ),
  api: route(
    "Make an authenticated API request",
    () => import("./commands/api.js"),
    "apiCommand",
  ),
  schema: route(
    "Browse the Sentry API schema",
    () => import("./commands/schema.js"),
    "schemaCommand",
  ),
  "wasm-split": route(
    "Add build ids to WebAssembly modules and split out debug data",
    () => import("./commands/wasm-split.js"),
    "wasmSplitCommand",
  ),
  // Backward-compat aliases for old sentry-cli
  "send-event": hidden(
    () => import("./commands/send-event.js"),
    "sendEventCommand",
  ),
  "send-envelope": hidden(
    () => import("./commands/send-envelope.js"),
    "sendEnvelopeCommand",
  ),
  "bash-hook": hidden(
    () => import("./commands/bash-hook.js"),
    "bashHookCommand",
  ),
  "agent-conversations": hidden(
    () => import("./commands/agent-conversation/list.js"),
    "listCommand",
  ),
  attributes: hidden(
    () => import("./commands/attribute/list.js"),
    "listCommand",
  ),
  dashboards: hidden(
    () => import("./commands/dashboard/list.js"),
    "listCommand",
  ),
  dsns: hidden(() => import("./commands/dsn/list.js"), "listCommand"),
  integrations: hidden(
    () => import("./commands/integration/list.js"),
    "listCommand",
  ),
  issues: hidden(() => import("./commands/issue/list.js"), "listCommand"),
  orgs: hidden(() => import("./commands/org/list.js"), "listCommand"),
  platforms: hidden(() => import("./commands/platform/list.js"), "listCommand"),
  projects: hidden(() => import("./commands/project/list.js"), "listCommand"),
  replays: hidden(() => import("./commands/replay/list.js"), "listCommand"),
  releases: hidden(() => import("./commands/release/list.js"), "listCommand"),
  repos: hidden(() => import("./commands/repo/list.js"), "listCommand"),
  teams: hidden(() => import("./commands/team/list.js"), "listCommand"),
  logs: hidden(() => import("./commands/log/list.js"), "listCommand"),
  monitors: hidden(() => import("./commands/monitor/list.js"), "listCommand"),
  spans: hidden(() => import("./commands/span/list.js"), "listCommand"),
  traces: hidden(() => import("./commands/trace/list.js"), "listCommand"),
  trials: hidden(() => import("./commands/trial/list.js"), "listCommand"),
  whoami: hidden(() => import("./commands/auth/whoami.js"), "whoamiCommand"),
};

/**
 * The brief help shows for the top-level route `name`.
 *
 * The top-level route maps and commands set their `brief` with this, so it is
 * written only here. Throws for a name that is missing or hidden, which fails
 * every run and test that loads the route.
 */
export function topLevelBrief(name: string): string {
  const entry = COMMAND_MANIFEST[name];
  if (!entry || entry.hidden) {
    throw new Error(`No visible top-level route "${name}" in COMMAND_MANIFEST`);
  }
  return entry.brief;
}
