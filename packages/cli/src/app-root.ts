/**
 * Settings of the `sentry` CLI's top-level route map, shared by the full
 * application (`app.ts`) and the one `app-for-args.ts` builds with only the
 * command being run.
 */

import type { RouteMapBuilderArguments } from "@stricli/core";
import { COMMAND_MANIFEST } from "./command-manifest.js";
import type { SentryContext } from "./context.js";
import { buildCliApplication, type CliApplication } from "./lib/application.js";
import { buildRouteMap } from "./lib/route-map.js";
import type { CliRoutes } from "./lib/route-registry.js";

/**
 * Plural alias → singular route name mapping.
 * Used to suggest the correct command when users type e.g. `sentry projects view cli`.
 */
export const PLURAL_TO_SINGULAR: Readonly<Record<string, string>> = {
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
  tokens: "token",
  logs: "log",
  monitors: "monitor",
  replays: "replay",

  spans: "span",
  traces: "trace",
  trials: "trial",
};

/** The top-level routes of a `sentry` route map, by name. */
export type SentryRoutes = RouteMapBuilderArguments<
  string,
  SentryContext
>["routes"];

/** Build the top-level route map of the `sentry` CLI from `routes`. */
export function buildSentryRoutes(routes: SentryRoutes): CliRoutes {
  return buildRouteMap({
    routes,
    defaultCommand: "help",
    docs: {
      brief: "A gh-like CLI for Sentry",
      fullDescription:
        "sentry is a command-line interface for interacting with Sentry. " +
        "It provides commands for authentication, viewing issues, and making API calls.",
      hideRoute: Object.fromEntries(
        Object.keys(routes)
          .filter((name) => COMMAND_MANIFEST[name]?.hidden)
          .map((name) => [name, true]),
      ),
    },
  });
}

/** Build the `sentry` application over `routes`, and register them. */
export function buildSentryApp(routes: CliRoutes): CliApplication {
  return buildCliApplication(routes, { pluralAliases: PLURAL_TO_SINGULAR });
}
