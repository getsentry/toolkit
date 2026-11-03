/**
 * Load the `sentry` application for one invocation.
 *
 * `app.ts` imports every command, so loading it runs every command module and
 * everything those import. When the first argument names a top-level route,
 * this builds the application with only that route, which
 * `generated/route-loaders.ts` loads on its own (see
 * `script/generate-route-loaders.ts`). Global flags before the route name
 * (`sentry --verbose issue list`) are skipped, and a bare `sentry --version`
 * loads only `help`. Everything else gets the full application: no
 * arguments, `--help` or another flag first, an unknown name (for the
 * suggestions), and the commands that read the whole command tree.
 */

import {
  buildSentryApp,
  buildSentryRoutes,
  PLURAL_TO_SINGULAR,
} from "./app-root.js";
import type { CliApplication } from "./lib/application.js";
import { buildTopLevelFlags } from "./lib/global-flags.js";
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
 * Global flag tokens the route scanner accepts before the route name. Same
 * allow-list as the application's `scanner.topLevelFlags`.
 */
const TOP_LEVEL_FLAGS = buildTopLevelFlags();

/**
 * Read the tokens before the route name the way the route scanner does:
 * skip global flags and their values, and note `--version`.
 *
 * Returns `undefined` when a token the scanner handles differently comes
 * first (`--help`, `--`, any other flag), so the caller loads the full app.
 */
function scanLeadingTokens(
  args: readonly string[],
): { name: string | undefined; version: boolean } | undefined {
  let version = false;
  let expectValue = false;
  for (const token of args) {
    if (!token.startsWith("-")) {
      if (expectValue) {
        expectValue = false;
        continue;
      }
      return { name: token, version };
    }
    // The scanner takes the token after a value flag as its value unless it
    // is a flag itself.
    expectValue = false;
    if (token === "--version") {
      version = true;
    } else if (TOP_LEVEL_FLAGS.valueFlags.has(token)) {
      expectValue = true;
    } else if (
      !TOP_LEVEL_FLAGS.booleanFlags.has(token) &&
      !TOP_LEVEL_FLAGS.valueFlags.has(token.split("=", 1)[0] ?? "")
    ) {
      return;
    }
  }
  return { name: undefined, version };
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
  const scanned = scanLeadingTokens(args);
  if (!scanned) {
    return;
  }
  const { name, version } = scanned;
  if (name === undefined) {
    // `sentry --version` prints the version before it would run any command.
    return version ? ["help"] : undefined;
  }
  if (FULL_TREE_ROUTES.has(name) || !isRoute(name)) {
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
