/**
 * Load the `sentry` application for one invocation.
 *
 * `app.ts` imports every command, so loading it runs every command module and
 * everything those import. When the first argument names a top-level route,
 * this builds the application with only that route, which `COMMAND_MANIFEST`
 * (`command-manifest.ts`) loads on its own. Global flags before the route
 * name (`sentry --verbose issue list`) are skipped, and a bare
 * `sentry --version` loads only `help`. The top-level help (`sentry`,
 * `sentry help`, and `sentry --help`) loads only `help`, and stands in for
 * the other routes with what the manifest says about them (see
 * `root-help-routes.ts`). Everything else gets the full application: JSON
 * help, `--help` before a route name or another flag first, an unknown name
 * (for the suggestions), and the commands that read the whole command tree.
 */

import {
  buildSentryApp,
  buildSentryRoutes,
  PLURAL_TO_SINGULAR,
  type SentryRoutes,
} from "./app-root.js";
import { COMMAND_MANIFEST } from "./command-manifest.js";
import type { CliApplication } from "./lib/application.js";
import { getEnv } from "./lib/env.js";
import { buildTopLevelFlags } from "./lib/global-flags.js";
import type { CliRoutes } from "./lib/route-registry.js";
import { buildRootHelpRoutes } from "./root-help-routes.js";

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
  return Object.hasOwn(COMMAND_MANIFEST, name);
}

/** Load the command or route map of the top-level route `name`. */
export async function loadRoute(name: string): Promise<SentryRoutes[string]> {
  const entry = isRoute(name) ? COMMAND_MANIFEST[name] : undefined;
  if (!entry) {
    throw new Error(`No top-level route "${name}" in COMMAND_MANIFEST`);
  }
  return await entry.load();
}

/**
 * Global flag tokens the route scanner accepts before the route name. Same
 * allow-list as the application's `scanner.topLevelFlags`.
 */
const TOP_LEVEL_FLAGS = buildTopLevelFlags();

/** The tokens before the route name, read the way the route scanner does. */
type LeadingTokens = {
  /** The first token that is neither a flag nor a global flag's value. */
  readonly name: string | undefined;
  /** The tokens after {@link name}. */
  readonly rest: readonly string[];
  /** `--version` came before the name. */
  readonly version: boolean;
  /** `--help` or `-h` came before the name. */
  readonly help: boolean;
  /** `--json` or `--fields` came before the name. */
  readonly json: boolean;
};

/** Whether `token` is `--json` or `--fields`, which ask for JSON output. */
function isJsonFlag(token: string): boolean {
  return token === "--json" || /^--fields(=|$)/.test(token);
}

/**
 * Read the tokens before the route name the way the route scanner does:
 * skip global flags and their values, and note `--version` and `--help`.
 *
 * Returns `undefined` when a token the scanner handles differently comes
 * first (`--`, any other flag), so the caller loads the full app.
 */
function scanLeadingTokens(args: readonly string[]): LeadingTokens | undefined {
  let version = false;
  let help = false;
  let json = false;
  let expectValue = false;
  for (const [index, token] of args.entries()) {
    if (!token.startsWith("-")) {
      if (expectValue) {
        expectValue = false;
        continue;
      }
      return { name: token, rest: args.slice(index + 1), version, help, json };
    }
    // The scanner takes the token after a value flag as its value unless it
    // is a flag itself.
    expectValue = false;
    json ||= isJsonFlag(token);
    if (token === "--version") {
      version = true;
    } else if (token === "--help" || token === "-h") {
      help = true;
    } else if (TOP_LEVEL_FLAGS.valueFlags.has(token)) {
      expectValue = true;
    } else if (
      !TOP_LEVEL_FLAGS.booleanFlags.has(token) &&
      !TOP_LEVEL_FLAGS.valueFlags.has(token.split("=", 1)[0] ?? "")
    ) {
      return;
    }
  }
  return { name: undefined, rest: [], version, help, json };
}

/**
 * Whether `args` print the top-level help in text: `sentry` or
 * `sentry --help` (with global flags), or `sentry help` with only flags
 * after it. JSON help lists every command with its flags, so it needs the
 * full application.
 */
export function isRootHelpRequest(
  args: readonly string[],
  env: NodeJS.ProcessEnv = getEnv(),
): boolean {
  const scanned = scanLeadingTokens(args);
  if (
    !scanned ||
    scanned.version ||
    scanned.json ||
    env.SENTRY_OUTPUT_FORMAT === "json"
  ) {
    return false;
  }
  if (scanned.name === undefined) {
    return true;
  }
  return (
    scanned.name === "help" &&
    !scanned.help &&
    scanned.rest.every((token) => token.startsWith("-") && !isJsonFlag(token))
  );
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
  const { name, version, help } = scanned;
  if (name === undefined) {
    // `sentry --version` prints the version before it would run any command.
    return version ? ["help"] : undefined;
  }
  if (help || FULL_TREE_ROUTES.has(name) || !isRoute(name)) {
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
  if (isRootHelpRequest(args)) {
    const [help, { registerGraphicsBanner }] = await Promise.all([
      loadRoute("help"),
      import("./graphics-banner.js"),
    ]);
    registerGraphicsBanner();
    const routes = buildRootHelpRoutes(help);
    return { app: buildSentryApp(routes), routes };
  }
  const names = routesForArgs(args);
  if (!names) {
    return await import("./app.js");
  }
  const loaded = await Promise.all(
    names.map(async (name) => [name, await loadRoute(name)] as const),
  );
  const routes = buildSentryRoutes(Object.fromEntries(loaded));
  return { app: buildSentryApp(routes), routes };
}
