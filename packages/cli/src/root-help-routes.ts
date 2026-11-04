/**
 * The route map the top-level help runs with: the real `help` command, and a
 * stand-in for every other visible route.
 *
 * `sentry` and `sentry help` print the branded help (`lib/help.ts`), and
 * `sentry --help` prints Stricli's own route map help. Both read only each
 * route's name and brief, a route group's visible subcommand names, and a
 * command's usage line and placeholder. Names and hidden flags come from
 * `COMMAND_MANIFEST`, briefs from `TOP_LEVEL_BRIEFS`, and the rest from
 * `generated/top-level-routes.json`,
 * which `script/generate-top-level-routes.ts` reads from the route tree. So
 * these runs don't need to load every command module.
 *
 * The stand-ins are never run: `app-for-args.ts` builds this map only for
 * arguments that print the top-level help.
 */

import { buildCommand, type Command } from "@stricli/core";
import { buildSentryRoutes, type SentryRoutes } from "./app-root.js";
import { COMMAND_MANIFEST } from "./command-manifest.js";
import type { SentryContext } from "./context.js";
import generatedTopLevelRoutes from "./generated/top-level-routes.json";
import type { CliRoutes } from "./lib/route-registry.js";
import { buildRouteMap } from "./lib/route-map.js";
import { TOP_LEVEL_BRIEFS } from "./top-level-briefs.js";

/** What the top-level help shows for a visible top-level route. */
export type TopLevelRoute =
  /** A route group: the names of its visible subcommands, in order. */
  | { readonly subcommands: readonly string[] }
  | {
      /** Its usage line after `sentry <name>`, as `sentry --help` shows it. */
      readonly usage: string;
      /** What follows its name in `sentry help`, like `<endpoint>`. */
      readonly placeholder?: string;
    };

/** {@link TopLevelRoute} of each visible top-level route, by name. */
export type TopLevelRoutes = Record<string, TopLevelRoute>;

const TOP_LEVEL_ROUTES: TopLevelRoutes = generatedTopLevelRoutes;

/** A command that only answers help with `brief`, and throws if run. */
function buildStandInCommand(brief: string): Command<SentryContext> {
  return buildCommand<Record<string, never>, [], SentryContext>({
    func() {
      throw new Error(`A help-only stand-in for "${brief}" was run`);
    },
    parameters: { flags: {} },
    docs: { brief },
  });
}

const BRIEFS: Readonly<Record<string, string | undefined>> = TOP_LEVEL_BRIEFS;

/** A stand-in for the visible top-level route `name`. */
function buildStandIn(name: string): SentryRoutes[string] {
  const brief = BRIEFS[name];
  if (brief === undefined) {
    throw new Error(`No brief for "${name}" in TOP_LEVEL_BRIEFS`);
  }
  const route = TOP_LEVEL_ROUTES[name];
  if (!route) {
    throw new Error(
      `No generated help data for "${name}"; run \`pnpm run generate:docs\``,
    );
  }
  if ("subcommands" in route) {
    const subcommand = buildStandInCommand("");
    return buildRouteMap({
      routes: Object.fromEntries(
        route.subcommands.map((sub) => [sub, subcommand]),
      ),
      docs: { brief },
    });
  }
  const standIn: Command<SentryContext> = {
    ...buildStandInCommand(brief),
    formatUsageLine: (args) => [...args.prefix, route.usage].join(" "),
  };
  // Read by the branded help, like the `__primaryUsage` `buildCommand` keeps
  (standIn as unknown as Record<string, unknown>).__primaryUsage =
    route.placeholder;
  return standIn;
}

/**
 * Build the top-level route map for the top-level help, with the loaded
 * `help` command and a stand-in for every other visible route.
 */
export function buildRootHelpRoutes(help: SentryRoutes[string]): CliRoutes {
  const routes = Object.entries(COMMAND_MANIFEST).flatMap(([name, entry]) => {
    if (name === "help") {
      return [[name, help] as const];
    }
    return entry.hidden ? [] : [[name, buildStandIn(name)] as const];
  });
  return buildSentryRoutes(Object.fromEntries(routes));
}
