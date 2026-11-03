/**
 * The top-level routes of the `sentry` CLI, in the order help lists them.
 *
 * Each entry says how to load the command or route map that implements it,
 * and holds what the top-level help shows for it, so `sentry`, `sentry help`
 * and `sentry --help` can print that help without loading every command (see
 * `src/root-help-routes.ts`). Loading this module loads no command: entries
 * only hold `import()` loaders.
 *
 * `src/app.ts` builds the full route tree from the same modules.
 * `test/lib/command-manifest.test.ts` fails when an entry disagrees with it, and
 * prints the value to copy here.
 */

import type { SentryRoutes } from "./app-root.js";

/** Loads the command or route map of a top-level route. */
export type RouteLoader = () => Promise<SentryRoutes[string]>;

/** A route group, like `sentry issue list|view|...`. */
export type GroupManifestEntry = {
  readonly hidden?: undefined;
  readonly brief: string;
  /** The names of its visible subcommands, in order. */
  readonly subcommands: readonly string[];
  readonly load: RouteLoader;
};

/** A command directly under `sentry`, like `sentry api`. */
export type CommandManifestEntry = {
  readonly hidden?: undefined;
  readonly brief: string;
  /** Its Stricli usage line after `sentry <name>`, as `sentry --help` shows it. */
  readonly usage: string;
  /** What follows its name in `sentry help`, like `<endpoint>`. */
  readonly placeholder?: string;
  readonly load: RouteLoader;
};

/** A route left out of help: plural aliases, shortcuts, and old names. */
export type HiddenManifestEntry = {
  readonly hidden: true;
  readonly load: RouteLoader;
};

export type ManifestEntry =
  | GroupManifestEntry
  | CommandManifestEntry
  | HiddenManifestEntry;

/** Every top-level route of the `sentry` CLI, by name. */
export const COMMAND_MANIFEST: Readonly<Record<string, ManifestEntry>> = {
  help: {
    brief: "Display help for a command",
    usage: "[--json] [--fields value] <command>...",
    placeholder: "<command...>",
    load: () => import("./commands/help.js").then((m) => m.helpCommand),
  },
  alert: {
    brief: "Manage Sentry alert rules",
    subcommands: ["issues", "metrics"],
    load: () => import("./commands/alert/index.js").then((m) => m.alertRoute),
  },
  attribute: {
    brief: "Explore span, log, and metric attributes",
    subcommands: ["list"],
    load: () =>
      import("./commands/attribute/index.js").then((m) => m.attributeRoute),
  },
  auth: {
    brief: "Authenticate with Sentry",
    subcommands: [
      "list",
      "login",
      "logout",
      "refresh",
      "status",
      "switch",
      "token",
      "whoami",
    ],
    load: () => import("./commands/auth/index.js").then((m) => m.authRoute),
  },
  build: {
    brief: "Manage mobile build artifacts",
    subcommands: ["upload", "download"],
    load: () => import("./commands/build/index.js").then((m) => m.buildRoute),
  },
  cli: {
    brief: "CLI-related commands",
    subcommands: [
      "completion",
      "defaults",
      "feedback",
      "fix",
      "import",
      "setup",
      "uninstall",
      "upgrade",
    ],
    load: () => import("./commands/cli/index.js").then((m) => m.cliRoute),
  },
  "code-mappings": {
    brief: "Manage code mappings for stack trace linking",
    subcommands: ["upload"],
    load: () =>
      import("./commands/code-mappings/index.js").then(
        (m) => m.codeMappingsRoute,
      ),
  },
  "agent-conversation": {
    brief: "List and view agent conversations",
    subcommands: ["list", "view"],
    load: () =>
      import("./commands/agent-conversation/index.js").then(
        (m) => m.conversationRoute,
      ),
  },
  "dart-symbol-map": {
    brief: "Work with Dart/Flutter symbol maps",
    subcommands: ["upload"],
    load: () =>
      import("./commands/dart-symbol-map/index.js").then(
        (m) => m.dartSymbolMapRoute,
      ),
  },
  "debug-files": {
    brief: "Work with debug information files",
    subcommands: [
      "check",
      "find",
      "upload",
      "print-sources",
      "bundle-sources",
      "bundle-jvm",
    ],
    load: () =>
      import("./commands/debug-files/index.js").then((m) => m.debugFilesRoute),
  },
  dashboard: {
    brief: "Manage Sentry dashboards",
    subcommands: ["list", "view", "create", "widget", "revisions", "restore"],
    load: () =>
      import("./commands/dashboard/index.js").then((m) => m.dashboardRoute),
  },
  docs: {
    brief: "Search and query current Sentry documentation",
    subcommands: ["list", "query"],
    load: () => import("./commands/docs/index.js").then((m) => m.docsRoute),
  },
  dsn: {
    brief: "Find Sentry DSNs",
    subcommands: ["list"],
    load: () => import("./commands/dsn/index.js").then((m) => m.dsnRoute),
  },
  org: {
    brief: "Work with Sentry organizations",
    subcommands: ["list", "view"],
    load: () => import("./commands/org/index.js").then((m) => m.orgRoute),
  },
  platform: {
    brief: "List valid Sentry platform identifiers",
    subcommands: ["list"],
    load: () =>
      import("./commands/platform/index.js").then((m) => m.platformRoute),
  },
  project: {
    brief: "Work with Sentry projects",
    subcommands: ["create", "delete", "list", "view"],
    load: () =>
      import("./commands/project/index.js").then((m) => m.projectRoute),
  },
  proguard: {
    brief: "Work with ProGuard/R8 mapping files",
    subcommands: ["upload", "uuid"],
    load: () =>
      import("./commands/proguard/index.js").then((m) => m.proguardRoute),
  },
  "react-native": {
    brief: "Upload React Native sourcemaps from build steps",
    subcommands: ["gradle", "xcode"],
    load: () =>
      import("./commands/react-native/index.js").then(
        (m) => m.reactNativeRoute,
      ),
  },
  replay: {
    brief: "Search and inspect Session Replays",
    subcommands: ["list", "view", "download"],
    load: () => import("./commands/replay/index.js").then((m) => m.replayRoute),
  },
  release: {
    brief: "Work with Sentry releases",
    subcommands: [
      "list",
      "view",
      "create",
      "finalize",
      "delete",
      "archive",
      "restore",
      "deploy",
      "deploys",
      "set-commits",
      "propose-version",
    ],
    load: () =>
      import("./commands/release/index.js").then((m) => m.releaseRoute),
  },
  repo: {
    brief: "Work with Sentry repositories",
    subcommands: ["list"],
    load: () => import("./commands/repo/index.js").then((m) => m.repoRoute),
  },
  team: {
    brief: "Work with Sentry teams",
    subcommands: ["list"],
    load: () => import("./commands/team/index.js").then((m) => m.teamRoute),
  },
  integration: {
    brief: "Work with Sentry integrations",
    subcommands: ["list", "delete"],
    load: () =>
      import("./commands/integration/index.js").then((m) => m.integrationRoute),
  },
  issue: {
    brief: "Manage Sentry issues",
    subcommands: [
      "list",
      "events",
      "tags",
      "explain",
      "plan",
      "view",
      "resolve",
      "unresolve",
      "archive",
      "merge",
      "link",
      "unlink",
    ],
    load: () => import("./commands/issue/index.js").then((m) => m.issueRoute),
  },
  event: {
    brief: "View, list, and send Sentry events",
    subcommands: ["view", "list", "send"],
    load: () => import("./commands/event/index.js").then((m) => m.eventRoute),
  },
  events: {
    hidden: true,
    load: () => import("./commands/event/list.js").then((m) => m.listCommand),
  },
  explore: {
    brief: "Query aggregate event data (Explore)",
    usage:
      "[--field value]... [--metric value] [--agg value] [--dataset value] [--query value] [--sort value] [--environment value]... [--limit number] [--time-series auto|interval] [--period value] [--fresh] [--cursor value] [--json] [--fields value] [<target>]",
    placeholder: "[<target>]",
    load: () => import("./commands/explore.js").then((m) => m.exploreCommand),
  },
  feedback: {
    brief: "Manage User Feedback",
    subcommands: ["list", "view", "resolve", "unresolve", "spam"],
    load: () =>
      import("./commands/feedback/index.js").then((m) => m.feedbackRoute),
  },
  log: {
    brief: "View Sentry logs",
    subcommands: ["list", "view"],
    load: () => import("./commands/log/index.js").then((m) => m.logRoute),
  },
  mcp: {
    brief: "Start a local Sentry MCP server",
    usage:
      "[--access-token value] [--org value] [--project value] [--skills value] [--all-skills] [--disable-skills value] [--experimental] [--agent-provider value] [--openai-base-url value] [--openai-model value] [--anthropic-base-url value] [--anthropic-model value] [--mcp-url value] [--sentry-dsn value] [<org/project>]",
    placeholder: "[<org/project>]",
    load: () => import("./commands/mcp.js").then((m) => m.mcpCommand),
  },
  monitor: {
    brief: "Work with Sentry cron monitors",
    subcommands: ["run", "list"],
    load: () =>
      import("./commands/monitor/index.js").then((m) => m.monitorRoute),
  },
  snapshots: {
    brief: "Manage and compare snapshots",
    subcommands: ["diff", "download", "upload"],
    load: () =>
      import("./commands/snapshots/index.js").then((m) => m.snapshotsRoute),
  },
  sourcemap: {
    brief: "Manage sourcemaps",
    subcommands: ["inject", "upload", "resolve"],
    load: () =>
      import("./commands/sourcemap/index.js").then((m) => m.sourcemapRoute),
  },
  sourcemaps: {
    hidden: true,
    load: () =>
      import("./commands/sourcemap/index.js").then((m) => m.sourcemapRoute),
  },
  span: {
    brief: "List and view spans in projects or traces",
    subcommands: ["list", "view"],
    load: () => import("./commands/span/index.js").then((m) => m.spanRoute),
  },
  status: {
    brief: "Check Sentry service status",
    subcommands: ["show"],
    load: () => import("./commands/status/index.js").then((m) => m.statusRoute),
  },
  trace: {
    brief: "View distributed traces",
    subcommands: ["list", "view", "logs"],
    load: () => import("./commands/trace/index.js").then((m) => m.traceRoute),
  },
  trial: {
    brief: "Manage product trials",
    subcommands: ["list", "start"],
    load: () => import("./commands/trial/index.js").then((m) => m.trialRoute),
  },
  init: {
    brief: "Initialize Sentry in your project (experimental)",
    usage:
      "[--yes] [--dry-run] [--features value]... [--team value] [--app value] [--tui] <target/directory>...",
    placeholder: "[<target>] [<directory>]",
    load: () => import("./commands/init.js").then((m) => m.initCommand),
  },
  info: {
    brief: "Print configuration and verify authentication",
    usage: "[--config-status-json] [--no-defaults] [--json] [--fields value]",
    load: () => import("./commands/info.js").then((m) => m.infoCommand),
  },
  local: {
    brief: "Sentry for local development",
    subcommands: ["daemon", "envelope", "event", "serve", "session", "run"],
    load: () => import("./commands/local/index.js").then((m) => m.localRoute),
  },
  api: {
    brief: "Make an authenticated API request",
    usage:
      "[--method method] [--cursor value] [--data json] [--field value]... [--raw-field value]... [--header value]... [--input file] [--silent] [--verbose] [--dry-run] [--json] [--fields value] <endpoint>",
    placeholder: "<endpoint>",
    load: () => import("./commands/api.js").then((m) => m.apiCommand),
  },
  schema: {
    brief: "Browse the Sentry API schema",
    usage: "[--all] [--search value] [--json] [--fields value] <query>...",
    placeholder: "<query...>",
    load: () => import("./commands/schema.js").then((m) => m.schemaCommand),
  },
  "wasm-split": {
    brief: "Add build ids to WebAssembly modules and split out debug data",
    usage:
      "[--out value] [--debug-out value] [--strip] [--strip-names] [--quiet] [--build-id value] [--external-dwarf-url value] [--json] [--fields value] <input>",
    placeholder: "<input>",
    load: () =>
      import("./commands/wasm-split.js").then((m) => m.wasmSplitCommand),
  },
  // Backward-compat aliases for old sentry-cli
  "send-event": {
    hidden: true,
    load: () =>
      import("./commands/send-event.js").then((m) => m.sendEventCommand),
  },
  "send-envelope": {
    hidden: true,
    load: () =>
      import("./commands/send-envelope.js").then((m) => m.sendEnvelopeCommand),
  },
  "bash-hook": {
    hidden: true,
    load: () =>
      import("./commands/bash-hook.js").then((m) => m.bashHookCommand),
  },
  "agent-conversations": {
    hidden: true,
    load: () =>
      import("./commands/agent-conversation/list.js").then(
        (m) => m.listCommand,
      ),
  },
  attributes: {
    hidden: true,
    load: () =>
      import("./commands/attribute/list.js").then((m) => m.listCommand),
  },
  dashboards: {
    hidden: true,
    load: () =>
      import("./commands/dashboard/list.js").then((m) => m.listCommand),
  },
  dsns: {
    hidden: true,
    load: () => import("./commands/dsn/list.js").then((m) => m.listCommand),
  },
  integrations: {
    hidden: true,
    load: () =>
      import("./commands/integration/list.js").then((m) => m.listCommand),
  },
  issues: {
    hidden: true,
    load: () => import("./commands/issue/list.js").then((m) => m.listCommand),
  },
  orgs: {
    hidden: true,
    load: () => import("./commands/org/list.js").then((m) => m.listCommand),
  },
  platforms: {
    hidden: true,
    load: () =>
      import("./commands/platform/list.js").then((m) => m.listCommand),
  },
  projects: {
    hidden: true,
    load: () => import("./commands/project/list.js").then((m) => m.listCommand),
  },
  replays: {
    hidden: true,
    load: () => import("./commands/replay/list.js").then((m) => m.listCommand),
  },
  releases: {
    hidden: true,
    load: () => import("./commands/release/list.js").then((m) => m.listCommand),
  },
  repos: {
    hidden: true,
    load: () => import("./commands/repo/list.js").then((m) => m.listCommand),
  },
  teams: {
    hidden: true,
    load: () => import("./commands/team/list.js").then((m) => m.listCommand),
  },
  logs: {
    hidden: true,
    load: () => import("./commands/log/list.js").then((m) => m.listCommand),
  },
  monitors: {
    hidden: true,
    load: () => import("./commands/monitor/list.js").then((m) => m.listCommand),
  },
  spans: {
    hidden: true,
    load: () => import("./commands/span/list.js").then((m) => m.listCommand),
  },
  traces: {
    hidden: true,
    load: () => import("./commands/trace/list.js").then((m) => m.listCommand),
  },
  trials: {
    hidden: true,
    load: () => import("./commands/trial/list.js").then((m) => m.listCommand),
  },
  whoami: {
    hidden: true,
    load: () =>
      import("./commands/auth/whoami.js").then((m) => m.whoamiCommand),
  },
};
