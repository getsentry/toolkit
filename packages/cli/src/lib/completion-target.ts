/**
 * What shell completion suggests for each argument, read from its parser.
 *
 * A positional or flag completes a kind when its `parse` function is tagged
 * with {@link withCompletionTarget}, or is one of the shared value parsers
 * in {@link PARSER_TARGETS}. `script/generate-completion-targets.ts`
 * collects the kind of every argument at build time, because the
 * `__complete` fast path cannot boot Stricli to walk the route tree, and
 * `src/lib/complete.ts` maps each kind to its completer; the kinds are the
 * keys of that map.
 *
 * Commands get the tag from the bound parsers in `target-positional.ts`
 * and `positional-parse.ts`, which parse the value too, or, for arguments
 * that are not Sentry targets, from the pre-tagged parsers here
 * ({@link parseFilePath}, {@link parseText}, {@link choiceParser}, …).
 */

import { ISSUE_IS_VALUES } from "@sentry/toolkit-core/search-query";
import type { CompletionTarget } from "./complete.js";
import { ISSUE_LEVELS } from "../types/sentry.js";
import { parseLoginEmail } from "./db/accounts.js";
import { sanitizeIssueQuery } from "./search-query.js";
import { parsePeriod, UNIT_SECONDS } from "./time-range.js";

/** What shell completion suggests for an argument: a key of the completer map. */
export type { CompletionTarget };

const COMPLETION_TARGET_KEY = Symbol("completionTarget");

const COMPLETION_CHOICES_KEY = Symbol("completionChoices");

/**
 * Tag a positional or flag parser with the completion kind it accepts.
 *
 * @returns `parse` itself, so the tag travels with the function
 */
export function withCompletionTarget<P extends (input: string) => unknown>(
  kind: CompletionTarget,
  parse: P,
): P {
  Object.defineProperty(parse, COMPLETION_TARGET_KEY, { value: kind });
  return parse;
}

/** A parser that returns its input unchanged, tagged with `kind`. */
function identityParser(kind: CompletionTarget): (input: string) => string {
  return withCompletionTarget(kind, (input: string) => input);
}

/** Parses a file or directory path; completes paths. */
export const parseFilePath = identityParser("file");

/** Parses a directory path; completes directories. */
export const parseDirectoryPath = identityParser("directory");

/** Parses free text; completes nothing. */
export const parseText = identityParser("text");

/**
 * Parses a URL; completes nothing. The command validates it, so each one
 * keeps its own error for a URL it cannot use.
 */
export const parseUrl = identityParser("text");

/** Parses one segment of a CLI command path; completes route names. */
export const parseCommandPath = identityParser("command-path");

/** Parses a stored-account selector; completes stored accounts. */
export const parseAccountSelector = identityParser("account");

/**
 * Build a parser that completes `values`. It returns its input unchanged,
 * so the command still validates it: the values are suggestions, and a
 * command may accept others (`cli upgrade 0.5.0` next to `nightly`).
 */
export function choiceParser(
  values: readonly string[],
): (input: string) => string {
  const parse = identityParser("choice");
  Object.defineProperty(parse, COMPLETION_CHOICES_KEY, { value: [...values] });
  return parse;
}

/**
 * Shared value parsers and what their arguments complete. Listed here, not
 * tagged where they are defined, so those modules know nothing about
 * completion: every flag that parses with one completes the same way.
 */
const PARSER_TARGETS: ReadonlyMap<unknown, CompletionTarget> = new Map<
  unknown,
  CompletionTarget
>([
  [sanitizeIssueQuery, "issue-query"],
  [parsePeriod, "period"],
  [parseLoginEmail, "account"],
]);

/**
 * Read the completion kind from a positional's or flag's `parse` function.
 *
 * @returns The kind a parser was tagged with by {@link withCompletionTarget}
 *   or is listed with in {@link PARSER_TARGETS}, or `undefined` for any
 *   other parser
 */
export function getCompletionTarget(
  parse: unknown,
): CompletionTarget | undefined {
  if (typeof parse !== "function") {
    return;
  }
  return (
    (parse as { [COMPLETION_TARGET_KEY]?: CompletionTarget })[
      COMPLETION_TARGET_KEY
    ] ?? PARSER_TARGETS.get(parse)
  );
}

/**
 * Read the values a {@link choiceParser} parser completes.
 *
 * @returns The values, or `undefined` for any other parser
 */
export function getCompletionChoices(
  parse: unknown,
): readonly string[] | undefined {
  return typeof parse === "function"
    ? (parse as { [COMPLETION_CHOICES_KEY]?: readonly string[] })[
        COMPLETION_CHOICES_KEY
      ]
    : undefined;
}

/** Fixed values the completers offer (see {@link COMPLETION_VALUES}). */
export type CompletionValues = {
  /** Issue search keys with a fixed set of values, for `issue-query` */
  issueSearch: Readonly<Record<string, readonly string[]>>;
  /** Units of a relative period, for `period` (`7` → `7d`) */
  periodUnits: readonly string[];
  /** Relative periods offered for `period`, with descriptions */
  periodPresets: Readonly<Record<string, string>>;
};

/**
 * Fixed values the completers offer, taken from the modules that define
 * them. The generator writes them next to the command metadata so the
 * `__complete` fast path gets them without loading those modules.
 */
export const COMPLETION_VALUES: CompletionValues = {
  issueSearch: { is: ISSUE_IS_VALUES, level: ISSUE_LEVELS },
  periodUnits: Object.keys(UNIT_SECONDS),
  // The presets of Sentry's time range selector (`DEFAULT_RELATIVE_PERIODS`
  // in getsentry/sentry).
  periodPresets: {
    "1h": "Last hour",
    "24h": "Last 24 hours",
    "7d": "Last 7 days",
    "14d": "Last 14 days",
    "30d": "Last 30 days",
    "90d": "Last 90 days",
  },
};
