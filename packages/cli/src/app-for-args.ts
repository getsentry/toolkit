/**
 * Load the `sentry` application for one invocation.
 *
 * `app.ts` imports every command, so loading it runs every command module and
 * everything those import. When the first argument names a top-level route,
 * this builds the application with only that route, which
 * `generated/route-loaders.ts` loads on its own (see
 * `script/generate-route-loaders.ts`). Everything else gets the full
 * application: no arguments, a flag or an unknown name first (for the
 * suggestions), and the commands that read the whole command tree.
 */

import {
  buildSentryApp,
  buildSentryRoutes,
  PLURAL_TO_SINGULAR,
} from "./app-root.js";
import type { CliApplication } from "./lib/application.js";
import type { CliRoutes } from "./lib/route-registry.js";
import { ROUTE_LOADERS } from "./generated/route-loaders.js";

/**
 * Top-level routes that read the whole command tree through `getRoutes()`:
 * the help listing, `schema`, and the shell completion scripts `cli setup`
 * and `cli completion` write.
 */
const FULL_TREE_ROUTES: ReadonlySet<string> = new Set([
  "help",
  "schema",
  "cli",
]);

/** Whether `name` is a top-level route of `app.ts`. */
function isRoute(name: string): boolean {
  return Object.hasOwn(ROUTE_LOADERS, name);
}

/**
 * The top-level routes to load for `args`, or `undefined` for the full
 * application.
 *
 * Besides the route itself: `help`, the default command, and for a plural
 * alias (`projects`) its singular route, whose subcommands the list command
 * recognizes (`sentry projects view` suggests `sentry project view`).
 */
export function routesForArgs(
  args: readonly string[],
): readonly string[] | undefined {
  const [name] = args;
  if (name === undefined || FULL_TREE_ROUTES.has(name) || !isRoute(name)) {
    return;
  }
  const singular = PLURAL_TO_SINGULAR[name];
  const names = new Set(["help", name]);
  if (singular && isRoute(singular)) {
    names.add(singular);
  }
  return [...names];
}

/** Load the application `args` runs in, registering its routes. */
export async function loadAppForArgs(
  args: readonly string[],
): Promise<{ app: CliApplication; routes: CliRoutes }> {
  const names = routesForArgs(args);
  if (!names) {
    return await import("./app.js");
  }
  const loaded = await Promise.all(
    names.map(async (name) => {
      const load = ROUTE_LOADERS[name];
      if (!load) {
        throw new Error(`No loader for the top-level route "${name}"`);
      }
      return [name, await load()] as const;
    }),
  );
  const routes = buildSentryRoutes(Object.fromEntries(loaded));
  return { app: buildSentryApp(routes), routes };
}
