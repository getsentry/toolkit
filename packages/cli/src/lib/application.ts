/**
 * Build a Stricli application for a CLI route map.
 *
 * The `sentry` CLI (`app.ts`) and the `@sentry/mcp-server` bundle
 * (`mcp-server-app.ts`) run different route maps through the same runner
 * (`cli.ts`). Both get the same scanner settings, error text, and help
 * rendering from here. Building an application also registers its routes, so
 * library code (help, completions, list commands) sees the commands that are
 * actually available.
 */

import {
  type Application,
  type ApplicationText,
  ArgumentScannerError,
  buildApplication,
  text_en,
  UnexpectedPositionalError,
  UnsatisfiedPositionalError,
} from "@stricli/core";
import type { SentryContext } from "../context.js";
import { getAppIdentity } from "./app-identity.js";
import {
  getCommandSuggestion,
  getSynonymSuggestionFromArgv,
} from "./command-suggestions.js";
import { CLI_VERSION } from "./constants.js";
import { redactCredentialText } from "./credential-redaction.js";
import { reportArgumentError, reportCliError } from "./error-reporting.js";
import {
  ApiError,
  AuthError,
  CliError,
  formatError,
  getExitCode,
  OutputError,
  WizardError,
} from "./errors.js";
import { error as errorColor, warning } from "./formatters/colors.js";
import { stripAnsi } from "./formatters/plain-detect.js";
import { buildTopLevelFlags } from "./global-flags.js";
import { renderJsonHelp } from "./help.js";
import { isRouteMap, type RouteMap } from "./introspect.js";
import { type CliRoutes, setRoutes } from "./route-registry.js";

/** A Stricli application over the CLI's context. */
export type CliApplication = Application<SentryContext>;

type ArgumentHintOptions = {
  readonly routesWithDefaultCommand: ReadonlySet<string>;
  readonly pluralAliases: Readonly<Record<string, string>>;
};

export type CliApplicationOptions = {
  /**
   * Plural route aliases mapped to their singular route, for the
   * "Did you mean" hint when an alias gets extra arguments.
   */
  readonly pluralAliases?: Readonly<Record<string, string>>;
};

/**
 * Route group names that have `defaultCommand` set.
 *
 * Derived from the route map — no manual list to maintain.
 * Used to detect the no-args case (`sentry issue` with no subcommand)
 * so we can show a usage hint instead of a confusing parse error.
 */
function findRoutesWithDefaultCommand(routes: CliRoutes): ReadonlySet<string> {
  return new Set(
    routes
      .getAllEntries()
      .filter(
        (e) =>
          isRouteMap(e.target as unknown) &&
          (e.target as unknown as RouteMap).getDefaultCommand?.(),
      )
      .map((e) => e.name.original),
  );
}

/**
 * Detect when the user typed a bare route group with no subcommand (e.g., `sentry issue`).
 *
 * With `defaultCommand: "view"` on route groups, Stricli routes to the view
 * command which then fails with UnsatisfiedPositionalError because no issue ID
 * was provided. Returns a usage hint string, or undefined if this isn't the
 * bare-route-group case.
 */
function detectBareRouteGroup(
  routesWithDefaultCommand: ReadonlySet<string>,
  ansiColor: boolean,
): string | undefined {
  const args = process.argv.slice(2);
  const nonFlags = args.filter((t) => !t.startsWith("-"));
  if (
    nonFlags.length <= 1 &&
    nonFlags[0] &&
    routesWithDefaultCommand.has(nonFlags[0])
  ) {
    const route = nonFlags[0];
    const { name } = getAppIdentity();
    const msg = `Usage: ${name} ${route} <command> [args]\nRun "${name} ${route} --help" to see available commands`;
    return ansiColor ? warning(msg) : msg;
  }
  return;
}

/**
 * Detect when a plural alias received extra positional args and suggest the
 * singular form. E.g., `sentry projects view cli` → `sentry project view cli`.
 */
function detectPluralAliasMisuse(
  pluralAliases: Readonly<Record<string, string>>,
  ansiColor: boolean,
): string | undefined {
  const args = process.argv.slice(2);
  const firstArg = args[0];
  if (firstArg && firstArg in pluralAliases) {
    const singular = pluralAliases[firstArg];
    const rest = args.slice(1).join(" ");
    const hint = `\nDid you mean: ${getAppIdentity().name} ${singular} ${rest}\n`;
    return ansiColor ? warning(hint) : hint;
  }
  return;
}

/**
 * Format a CliError with a synonym suggestion when the user typed a known
 * synonym that was consumed as a positional arg by `defaultCommand: "view"`.
 *
 * Returns the formatted error string if a synonym match is found,
 * undefined otherwise. Skips Sentry capture for these known user mistakes.
 */
function formatSynonymError(
  exc: unknown,
  ansiColor: boolean,
): string | undefined {
  if (!(exc instanceof CliError)) {
    return;
  }
  const synonymHint = getSynonymSuggestionFromArgv();
  if (!synonymHint) {
    return;
  }
  const prefix = ansiColor ? errorColor("Error:") : "Error:";
  const tip = ansiColor
    ? warning(`Tip: ${synonymHint}`)
    : `Tip: ${synonymHint}`;
  return `${prefix} ${exc.format()}\n${tip}`;
}

function escapesToOuterMiddleware(exc: unknown): boolean {
  if (exc instanceof OutputError) {
    return true;
  }
  if (exc instanceof AuthError) {
    return exc.reason === "not_authenticated" || exc.reason === "expired";
  }
  return exc instanceof ApiError && (exc.status === 401 || exc.status === 403);
}

/** Message for an argument that failed to parse, with our hints. */
function formatArgumentError(
  options: ArgumentHintOptions,
  exc: unknown,
  ansiColor: boolean,
): string {
  // Case A: bare route group with no subcommand (e.g., `sentry issue`)
  if (exc instanceof UnsatisfiedPositionalError) {
    const bareHint = detectBareRouteGroup(
      options.routesWithDefaultCommand,
      ansiColor,
    );
    if (bareHint) {
      return bareHint;
    }
  }

  // Case B + plural alias: extra args that Stricli can't consume
  if (exc instanceof UnexpectedPositionalError) {
    const pluralHint = detectPluralAliasMisuse(
      options.pluralAliases,
      ansiColor,
    );
    if (pluralHint) {
      return `${text_en.exceptionWhileParsingArguments(exc, ansiColor)}${pluralHint}`;
    }

    // With defaultCommand: "view", unknown tokens like "metrics" fill the
    // positional slot, then extra args (e.g., CLI-AB) trigger this error.
    // Check if the first non-route token is a known synonym.
    const synonymHint = getSynonymSuggestionFromArgv();
    if (synonymHint) {
      const tip = ansiColor
        ? warning(`\nTip: ${synonymHint}`)
        : `\nTip: ${synonymHint}`;
      return `${text_en.exceptionWhileParsingArguments(exc, ansiColor)}${tip}`;
    }
  }

  return text_en.exceptionWhileParsingArguments(exc, ansiColor);
}

/**
 * Custom error formatting for CLI errors.
 *
 * - AuthError (not_authenticated): Re-thrown to allow auto-login flow in bin.ts
 * - Other CliError subclasses: Show clean user-friendly message without stack trace
 * - Other errors: Show stack trace for debugging unexpected issues
 */
function buildApplicationText(options: ArgumentHintOptions): ApplicationText {
  const customText: ApplicationText = {
    ...text_en,
    exceptionWhileParsingArguments: (
      exc: unknown,
      ansiColor: boolean,
    ): string => {
      const message = formatArgumentError(options, exc, ansiColor);
      // Exit 252 never reaches reportCliError; record it for UX research
      reportArgumentError(exc, stripAnsi(message));
      return message;
    },
    noCommandRegisteredForInput: ({
      input,
      corrections,
      ansiColor,
    }): string => {
      // Default error message from Stricli (e.g., "No command registered for `info`")
      const base = text_en.noCommandRegisteredForInput({
        input,
        corrections,
        ansiColor,
      });

      // Check for known synonym suggestions on routes without defaultCommand
      // (e.g., `sentry cli info` → suggest `sentry auth status`).
      // Routes WITH defaultCommand won't reach here — their unknown tokens
      // are consumed as positional args and handled by Cases A/B/C above.
      const args = process.argv.slice(2);
      const nonFlags = args.filter((t) => !t.startsWith("-"));
      const routeContext = nonFlags[0] ?? "";
      const suggestion = getCommandSuggestion(routeContext, input);
      if (suggestion) {
        const hint = suggestion.explanation
          ? `${suggestion.explanation}: ${suggestion.command}`
          : suggestion.command;
        // Stricli wraps our return value in bold-red ANSI codes.
        // Reset before applying warning() color so the tip is yellow, not red.
        const formatted = ansiColor
          ? `\n\x1B[39m\x1B[22m${warning(`Tip: ${hint}`)}`
          : `\nTip: ${hint}`;
        return `${base}${formatted}`;
      }

      return base;
    },
    exceptionWhileRunningCommand: (
      exc: unknown,
      ansiColor: boolean,
    ): string => {
      // `boundArguments` positionals parse in the command wrapper, after
      // Stricli's scanner; their errors still read as argument errors
      if (exc instanceof ArgumentScannerError) {
        return customText.exceptionWhileParsingArguments(exc, ansiColor);
      }

      // These errors are handled outside Stricli: OutputError has already been
      // rendered, while auth errors may trigger login and a single retry.
      if (escapesToOuterMiddleware(exc)) {
        throw exc;
      }

      // Case C: With defaultCommand: "view", unknown tokens like "metrics" are
      // silently consumed as the positional arg. The view command fails at the
      // domain level (e.g., ResolutionError). Check argv for a known synonym
      // and show the suggestion — skip Sentry capture since these are known
      // user mistakes, not real errors.
      const synonymResult = formatSynonymError(exc, ansiColor);
      if (synonymResult) {
        return redactCredentialText(synonymResult);
      }

      // Report command errors to Sentry with stable fingerprinting. Stricli
      // catches exceptions and doesn't re-throw, so we must capture here to
      // get visibility into command failures. Silencing rules (OutputError,
      // expected AuthError, 401–499 ApiError) and fingerprint normalization
      // are enforced inside reportCliError. 400 Bad Request = CLI bug.
      reportCliError(exc);

      if (exc instanceof CliError) {
        // WizardError with rendered=true: clack already displayed the error.
        // Return empty string to avoid double output, exit code flows through.
        if (exc instanceof WizardError && exc.rendered) {
          return "";
        }
        const prefix = ansiColor ? errorColor("Error:") : "Error:";
        return `${prefix} ${formatError(exc)}`;
      }
      if (exc instanceof Error) {
        return `Unexpected error: ${redactCredentialText(exc.stack ?? exc.message)}`;
      }
      return `Unexpected error: ${formatError(exc)}`;
    },
  };
  return customText;
}

/**
 * Build the application for `routes`, named after the running program
 * ({@link getAppIdentity}), and register `routes` with the route registry.
 */
export function buildCliApplication(
  routes: CliRoutes,
  options: CliApplicationOptions = {},
): CliApplication {
  setRoutes(routes);
  const text = buildApplicationText({
    routesWithDefaultCommand: findRoutesWithDefaultCommand(routes),
    pluralAliases: options.pluralAliases ?? {},
  });
  return buildApplication(routes, {
    name: getAppIdentity().name,
    versionInfo: {
      currentVersion: CLI_VERSION,
    },
    scanner: {
      caseStyle: "allow-kebab-for-camel",
      // Allow `--` to stop flag parsing so wrapper commands (e.g.
      // `sentry monitor run <slug> -- <command>`) can pass through flags
      // like `-e` or `--verbose` to the wrapped command unambiguously.
      allowArgumentEscapeSequence: true,
      // Recognize global flags placed before the subcommand
      // (`sentry --verbose issue list`) at any route depth and forward them to
      // the leaf command, via our @stricli/core route-scanner patch. Derived
      // from GLOBAL_FLAGS so adding a global flag there is all that's needed.
      topLevelFlags: buildTopLevelFlags(),
    },
    determineExitCode: getExitCode,
    documentation: {
      // Pluggable help renderer (via our @stricli/core patch): render `--help
      // --json` as structured JSON through the same introspection path as
      // `sentry help --json`, instead of Stricli's text usage. Returns undefined
      // for non-JSON help so the built-in text output is unchanged. This replaces
      // the old argv `--help --json` → `help` command rewrite.
      renderHelp: ({ prefix, unprocessedInputs }) =>
        renderJsonHelp(prefix, unprocessedInputs),
    },
    localization: {
      loadText: () => text,
    },
  });
}
