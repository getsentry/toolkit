/**
 * The route map the top-level help runs with: the real `help` command, and a
 * stand-in for every other visible route built from `COMMAND_MANIFEST`.
 *
 * `sentry` and `sentry help` print the branded help (`lib/help.ts`), and
 * `sentry --help` prints Stricli's own route map help. Both read only each
 * route's name and brief, a route group's visible subcommand names, and a
 * command's usage line and placeholder, which the manifest holds. So these
 * runs don't need to load every command module.
 *
 * The stand-ins are never run: `app-for-args.ts` builds this map only for
 * arguments that print the top-level help.
 */

import { buildCommand, type Command } from "@stricli/core";
import { buildSentryRoutes, type SentryRoutes } from "./app-root.js";
import {
  COMMAND_MANIFEST,
  type CommandManifestEntry,
  type ManifestEntry,
} from "./command-manifest.js";
import type { SentryContext } from "./context.js";
import type { CliRoutes } from "./lib/route-registry.js";
import { buildRouteMap } from "./lib/route-map.js";

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

/** A stand-in for a command directly under `sentry`. */
function buildCommandStandIn(
  entry: CommandManifestEntry,
): Command<SentryContext> {
  const command = buildStandInCommand(entry.brief);
  const standIn: Command<SentryContext> = {
    ...command,
    formatUsageLine: (args) => [...args.prefix, entry.usage].join(" "),
  };
  // Read by the branded help, like the `__primaryUsage` `buildCommand` keeps
  (standIn as unknown as Record<string, unknown>).__primaryUsage =
    entry.placeholder;
  return standIn;
}

/** A stand-in for a visible top-level route. */
function buildStandIn(
  entry: Exclude<ManifestEntry, { hidden: true }>,
): SentryRoutes[string] {
  if (!("subcommands" in entry)) {
    return buildCommandStandIn(entry);
  }
  const subcommand = buildStandInCommand("");
  return buildRouteMap({
    routes: Object.fromEntries(
      entry.subcommands.map((name) => [name, subcommand]),
    ),
    docs: { brief: entry.brief },
  });
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
    return entry.hidden ? [] : [[name, buildStandIn(entry)] as const];
  });
  return buildSentryRoutes(Object.fromEntries(routes));
}
