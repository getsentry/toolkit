/**
 * The brief help shows for each visible top-level route of the `sentry` CLI,
 * in the order help lists them.
 *
 * The top-level route maps and commands set `brief: topLevelBrief(name)`, and
 * the top-level help reads it from here without loading them, so each brief
 * is written only once.
 *
 * Not part of `COMMAND_MANIFEST` (`command-manifest.ts`): that module holds
 * an `import()` of every command, and a bundle that cannot split chunks
 * inlines them all. `@sentry/mcp-server` bundles `help`, `mcp` and `auth`
 * that way, and they import this module. `test/lib/command-manifest.test.ts`
 * fails when these names differ from the manifest's visible routes.
 */

export const TOP_LEVEL_BRIEFS = {
  help: "Display help for a command",
  alert: "Manage Sentry alert rules",
  attribute: "Explore span, log, and metric attributes",
  auth: "Authenticate with Sentry",
  build: "Manage mobile build artifacts",
  cli: "CLI-related commands",
  "code-mappings": "Manage code mappings for stack trace linking",
  "agent-conversation": "List and view agent conversations",
  "dart-symbol-map": "Work with Dart/Flutter symbol maps",
  "debug-files": "Work with debug information files",
  dashboard: "Manage Sentry dashboards",
  docs: "Search and query current Sentry documentation",
  dsn: "Find Sentry DSNs",
  org: "Work with Sentry organizations",
  platform: "List valid Sentry platform identifiers",
  project: "Work with Sentry projects",
  proguard: "Work with ProGuard/R8 mapping files",
  "react-native": "Upload React Native sourcemaps from build steps",
  replay: "Search and inspect Session Replays",
  release: "Work with Sentry releases",
  repo: "Work with Sentry repositories",
  team: "Work with Sentry teams",
  integration: "Work with Sentry integrations",
  issue: "Manage Sentry issues",
  event: "View, list, and send Sentry events",
  explore: "Query aggregate event data (Explore)",
  feedback: "Manage User Feedback",
  games: "Terminal games",
  log: "View Sentry logs",
  mcp: "Start a local Sentry MCP server",
  monitor: "Work with Sentry cron monitors",
  snapshots: "Manage and compare snapshots",
  sourcemap: "Manage sourcemaps",
  span: "List and view spans in projects or traces",
  status: "Check Sentry service status",
  trace: "View distributed traces",
  trial: "Manage product trials",
  init: "Initialize Sentry in your project (experimental)",
  info: "Print configuration and verify authentication",
  local: "Sentry for local development",
  api: "Make an authenticated API request",
  schema: "Browse the Sentry API schema",
  "wasm-split": "Add build ids to WebAssembly modules and split out debug data",
} as const satisfies Readonly<Record<string, string>>;

/** The name of a visible top-level route. */
export type TopLevelRouteName = keyof typeof TOP_LEVEL_BRIEFS;

/** The brief help shows for the visible top-level route `name`. */
export function topLevelBrief(name: TopLevelRouteName): string {
  return TOP_LEVEL_BRIEFS[name];
}
