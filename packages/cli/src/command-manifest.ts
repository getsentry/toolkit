/**
 * The top-level routes of the `sentry` CLI, in the order help lists them.
 *
 * Each entry says how to load the command or route map that implements it,
 * and whether help hides it. Loading this module loads no command: entries
 * only hold `import()` loaders, which the bundler splits into chunks. The
 * briefs of the visible routes live in `src/top-level-briefs.ts`, which the
 * commands import without pulling in these loaders.
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

/**
 * A top-level route. `hidden` leaves it out of help: plural aliases,
 * shortcuts, and old names.
 */
export type ManifestEntry = {
  readonly hidden?: true;
  readonly load: RouteLoader;
};

/** Load the export `name` of the module `load` imports. */
function loader<N extends string>(
  load: () => Promise<Record<N, SentryRoutes[string]>>,
  name: N,
): RouteLoader {
  return () => load().then((module) => module[name]);
}

/** A route help lists, implemented by the export `name` of a module. */
function route<N extends string>(
  load: () => Promise<Record<N, SentryRoutes[string]>>,
  name: N,
): ManifestEntry {
  return { load: loader(load, name) };
}

/** A route help hides, implemented by the export `name` of a module. */
function hidden<N extends string>(
  load: () => Promise<Record<N, SentryRoutes[string]>>,
  name: N,
): ManifestEntry {
  return { hidden: true, load: loader(load, name) };
}

/** Every top-level route of the `sentry` CLI, by name. */
export const COMMAND_MANIFEST: Readonly<Record<string, ManifestEntry>> = {
  help: route(() => import("./commands/help.js"), "helpCommand"),
  alert: route(() => import("./commands/alert/index.js"), "alertRoute"),
  attribute: route(
    () => import("./commands/attribute/index.js"),
    "attributeRoute",
  ),
  auth: route(() => import("./commands/auth/index.js"), "authRoute"),
  build: route(() => import("./commands/build/index.js"), "buildRoute"),
  cli: route(() => import("./commands/cli/index.js"), "cliRoute"),
  "code-mappings": route(
    () => import("./commands/code-mappings/index.js"),
    "codeMappingsRoute",
  ),
  "agent-conversation": route(
    () => import("./commands/agent-conversation/index.js"),
    "conversationRoute",
  ),
  "dart-symbol-map": route(
    () => import("./commands/dart-symbol-map/index.js"),
    "dartSymbolMapRoute",
  ),
  "debug-files": route(
    () => import("./commands/debug-files/index.js"),
    "debugFilesRoute",
  ),
  dashboard: route(
    () => import("./commands/dashboard/index.js"),
    "dashboardRoute",
  ),
  docs: route(() => import("./commands/docs/index.js"), "docsRoute"),
  dsn: route(() => import("./commands/dsn/index.js"), "dsnRoute"),
  org: route(() => import("./commands/org/index.js"), "orgRoute"),
  platform: route(
    () => import("./commands/platform/index.js"),
    "platformRoute",
  ),
  project: route(() => import("./commands/project/index.js"), "projectRoute"),
  proguard: route(
    () => import("./commands/proguard/index.js"),
    "proguardRoute",
  ),
  "react-native": route(
    () => import("./commands/react-native/index.js"),
    "reactNativeRoute",
  ),
  replay: route(() => import("./commands/replay/index.js"), "replayRoute"),
  release: route(() => import("./commands/release/index.js"), "releaseRoute"),
  repo: route(() => import("./commands/repo/index.js"), "repoRoute"),
  team: route(() => import("./commands/team/index.js"), "teamRoute"),
  token: route(() => import("./commands/token/index.js"), "tokenRoute"),
  integration: route(
    () => import("./commands/integration/index.js"),
    "integrationRoute",
  ),
  issue: route(() => import("./commands/issue/index.js"), "issueRoute"),
  event: route(() => import("./commands/event/index.js"), "eventRoute"),
  events: hidden(() => import("./commands/event/list.js"), "listCommand"),
  explore: route(() => import("./commands/explore.js"), "exploreCommand"),
  feedback: route(
    () => import("./commands/feedback/index.js"),
    "feedbackRoute",
  ),
  games: hidden(() => import("./commands/games/index.js"), "gamesRoute"),
  log: route(() => import("./commands/log/index.js"), "logRoute"),
  mcp: route(() => import("./commands/mcp.js"), "mcpCommand"),
  monitor: route(() => import("./commands/monitor/index.js"), "monitorRoute"),
  snapshots: route(
    () => import("./commands/snapshots/index.js"),
    "snapshotsRoute",
  ),
  sourcemap: route(
    () => import("./commands/sourcemap/index.js"),
    "sourcemapRoute",
  ),
  sourcemaps: hidden(
    () => import("./commands/sourcemap/index.js"),
    "sourcemapRoute",
  ),
  span: route(() => import("./commands/span/index.js"), "spanRoute"),
  status: route(() => import("./commands/status/index.js"), "statusRoute"),
  trace: route(() => import("./commands/trace/index.js"), "traceRoute"),
  trial: route(() => import("./commands/trial/index.js"), "trialRoute"),
  init: route(() => import("./commands/init.js"), "initCommand"),
  info: route(() => import("./commands/info.js"), "infoCommand"),
  local: route(() => import("./commands/local/index.js"), "localRoute"),
  api: route(() => import("./commands/api.js"), "apiCommand"),
  schema: route(() => import("./commands/schema.js"), "schemaCommand"),
  "wasm-split": route(
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
  tokens: hidden(() => import("./commands/token/list.js"), "listCommand"),
  logs: hidden(() => import("./commands/log/list.js"), "listCommand"),
  monitors: hidden(() => import("./commands/monitor/list.js"), "listCommand"),
  spans: hidden(() => import("./commands/span/list.js"), "listCommand"),
  traces: hidden(() => import("./commands/trace/list.js"), "listCommand"),
  trials: hidden(() => import("./commands/trial/list.js"), "listCommand"),
  whoami: hidden(() => import("./commands/auth/whoami.js"), "whoamiCommand"),
};
