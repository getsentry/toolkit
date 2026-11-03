/**
 * What the top-level help shows for each visible top-level route, besides its
 * name (`COMMAND_MANIFEST`) and brief (`TOP_LEVEL_BRIEFS`): a route group's
 * visible subcommands, or a command's usage line and placeholder.
 *
 * These come from each command's flags and positionals and each route map's
 * routes, so `script/generate-top-level-routes.ts` reads them from the loaded
 * route tree instead of anyone writing them down.
 */

import type { DocumentationConfig } from "@stricli/core";
import type { CliRoutes } from "../../src/lib/route-registry.js";
import {
  getPositionalString,
  isCommand,
  isRouteMap,
  type RouteMap,
} from "../../src/lib/introspect.js";
import type { TopLevelRoutes } from "../../src/root-help-routes.js";

/** A command's Stricli usage line, as `sentry --help` formats it. */
type UsageLineFormatter = {
  formatUsageLine: (args: {
    prefix: readonly string[];
    config: DocumentationConfig;
  }) => string;
};

/**
 * Describe the visible top-level routes of `routes` for the top-level help.
 *
 * `config` is the documentation config `sentry --help` formats usage lines
 * with (`app.config.documentation`).
 */
export function describeTopLevelRoutes(
  routes: CliRoutes,
  config: DocumentationConfig,
): TopLevelRoutes {
  const described: TopLevelRoutes = {};
  for (const entry of (routes as unknown as RouteMap).getAllEntries()) {
    if (entry.hidden) {
      continue;
    }
    const name = entry.name.original;
    const { target } = entry;
    if (isRouteMap(target)) {
      described[name] = {
        subcommands: target
          .getAllEntries()
          .filter((sub) => !sub.hidden)
          .map((sub) => sub.name.original),
      };
      continue;
    }
    if (!isCommand(target)) {
      throw new Error(`Top-level route "${name}" is neither kind`);
    }
    const prefix = ["sentry", name];
    const usageLine = (target as unknown as UsageLineFormatter).formatUsageLine(
      { prefix, config },
    );
    const placeholder =
      target.__primaryUsage ??
      getPositionalString(target.parameters.positional);
    described[name] = {
      usage: usageLine.slice(prefix.join(" ").length + 1),
      ...(placeholder ? { placeholder } : {}),
    };
  }
  return described;
}
