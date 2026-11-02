/**
 * The route map the running CLI was built from.
 *
 * Library modules (help, completions, list-command) need the command tree,
 * but importing `app.ts` for it would pull every command into any bundle
 * that reaches those modules — and every command reaches them through
 * `buildCommand`. Instead, whatever builds the application registers its
 * route map here: `app.ts` for the full CLI, or another entry point with a
 * smaller map. Tests can register a fake one.
 */

import type { RouteMap } from "@stricli/core";
import type { SentryContext } from "../context.js";

/** Top-level route map of the CLI application. */
export type CliRoutes = RouteMap<SentryContext>;

let registeredRoutes: CliRoutes | undefined;

/** Register the route map the CLI application runs. Replaces any earlier one. */
export function setRoutes(routes: CliRoutes): void {
  registeredRoutes = routes;
}

/** The registered route map, or `undefined` before registration. */
export function findRoutes(): CliRoutes | undefined {
  return registeredRoutes;
}

/**
 * The registered route map.
 *
 * @throws {Error} When no entry point has called {@link setRoutes} yet
 */
export function getRoutes(): CliRoutes {
  if (!registeredRoutes) {
    throw new Error(
      "CLI routes are not registered. The entry point that builds the application must call setRoutes() first (src/app.ts does).",
    );
  }
  return registeredRoutes;
}
