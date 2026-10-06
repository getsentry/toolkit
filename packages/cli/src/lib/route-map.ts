/**
 * Drop-in replacement for `@stricli/core`'s `buildRouteMap`.
 *
 * Analogous to how `buildCommand` in `./command.ts` wraps Stricli's version,
 * this is the **only** place that should import `buildRouteMap` from
 * `@stricli/core`. All other files import from here.
 */

import {
  type CommandContext,
  type RouteMap,
  type RouteMapBuilderArguments,
  buildRouteMap as stricliRouteMap,
} from "@stricli/core";

/**
 * Standard subcommand aliases, auto-injected when the matching route key
 * exists. Each entry maps a canonical route name to the set of short-form
 * aliases that should resolve to it.
 */
const STANDARD_ALIASES = new Map<string, ReadonlySet<string>>([
  ["list", new Set(["ls"])],
  ["view", new Set(["show"])],
  ["delete", new Set(["remove", "rm"])],
  ["create", new Set(["new"])],
]);

/**
 * Build a route map with standard subcommand aliases auto-injected.
 *
 * | Route    | Auto-aliases   |
 * |----------|----------------|
 * | `list`   | `ls`           |
 * | `view`   | `show`         |
 * | `delete` | `remove`, `rm` |
 * | `create` | `new`          |
 *
 * Manually specified aliases in `args.aliases` take precedence over
 * auto-generated ones. Aliases that would collide with actual route
 * names are silently skipped.
 */
export function buildRouteMap<
  R extends string,
  CONTEXT extends CommandContext = CommandContext,
>(args: RouteMapBuilderArguments<R, CONTEXT>): RouteMap<CONTEXT> {
  const routeKeys = new Set(Object.keys(args.routes));
  const autoAliases: Record<string, string> = {};

  for (const [routeName, aliases] of STANDARD_ALIASES) {
    if (routeKeys.has(routeName)) {
      for (const alias of aliases) {
        if (!routeKeys.has(alias)) {
          autoAliases[alias] = routeName;
        }
      }
    }
  }

  return stricliRouteMap({
    ...args,
    aliases: {
      ...autoAliases,
      ...args.aliases,
    } as RouteMapBuilderArguments<R, CONTEXT>["aliases"],
  });
}
