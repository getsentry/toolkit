/**
 * What shell completion suggests for each argument, read from its parser.
 *
 * A positional or flag completes a kind when its `parse` function is tagged
 * with {@link withCompletionTarget}, or is one of the shared value parsers
 * in {@link PARSER_TARGETS}. `script/generate-completion-targets.ts`
 * collects the kind of every argument at build time, because the
 * `__complete` fast path cannot boot Stricli to walk the route tree, and
 * `src/lib/complete.ts` maps each kind to its completer.
 *
 * Commands get the tag from the bound parsers in `target-positional.ts`
 * and `positional-parse.ts`, which parse the value too, or, for arguments
 * that are not Sentry targets, from the pre-tagged parsers here
 * ({@link parseFilePath}, {@link parseText}, {@link choiceParser}, …).
 */

import { ISSUE_IS_VALUES } from "@sentry/toolkit-core/search-query";
import { ISSUE_LEVELS } from "../types/sentry.js";
import { parseLoginEmail } from "./db/accounts.js";
import { sanitizeIssueQuery } from "./search-query.js";
import { parsePeriod, UNIT_SECONDS } from "./time-range.js";

/** Completes organization slugs only (e.g. `org`, `org/version`, `org/id`). */
export const ORG_TARGET = "org";

/** Completes `org/` prefixes, `org/project` pairs, and project aliases. */
export const ORG_PROJECT_TARGET = "org/project";

/** Completes everything {@link ORG_PROJECT_TARGET} does plus cached issue short IDs. */
export const ISSUE_TARGET = "issue";

/** Completes `org/` prefixes and cached dashboards (`org/<id>`) in the first positional. */
export const DASHBOARD_TARGET = "dashboard";

/** Completes the term at the end of an issue search query (`is:`, `level:`). */
export const ISSUE_QUERY_TARGET = "issue-query";

/** Completes relative `--period` values (`24h`, `7d`, a number plus a unit). */
export const PERIOD_TARGET = "period";

/** Completes `project create` `name:platform` specs: `org/` prefixes, then platforms. */
export const PROJECT_SPEC_TARGET = "project-spec";

/** Completes stored accounts (`sentry auth list`) by email, username, or ID. */
export const ACCOUNT_TARGET = "account";

/** Completes file and directory paths. */
export const FILE_TARGET = "file";

/** Completes directory paths only. */
export const DIRECTORY_TARGET = "directory";

/**
 * Completes what {@link ORG_PROJECT_TARGET} does, or directories once the
 * word looks like a path (`./`, `../`, `/`, `~/`), as `sentry init` reads
 * its `[<target>] [<directory>]` arguments.
 */
export const ORG_PROJECT_OR_DIRECTORY_TARGET = "org-project-or-directory";

/** Completes a CLI command path, one route segment per word (`help issue list`). */
export const COMMAND_PATH_TARGET = "command-path";

/** Completes the values its parser was made with by {@link choiceParser}. */
export const CHOICE_TARGET = "choice";

/**
 * Free text with nothing to suggest (messages, queries, names of new
 * things). Declared, so that every positional says how it completes.
 */
export const TEXT_TARGET = "text";

/** Every completion target kind, in a stable order. */
export const COMPLETION_TARGETS = [
  ORG_TARGET,
  ORG_PROJECT_TARGET,
  ISSUE_TARGET,
  DASHBOARD_TARGET,
  ISSUE_QUERY_TARGET,
  PERIOD_TARGET,
  PROJECT_SPEC_TARGET,
  ACCOUNT_TARGET,
  FILE_TARGET,
  DIRECTORY_TARGET,
  ORG_PROJECT_OR_DIRECTORY_TARGET,
  COMMAND_PATH_TARGET,
  CHOICE_TARGET,
  TEXT_TARGET,
] as const;

/** What shell completion suggests for an argument. */
export type CompletionTarget = (typeof COMPLETION_TARGETS)[number];

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
export const parseFilePath = identityParser(FILE_TARGET);

/** Parses a directory path; completes directories. */
export const parseDirectoryPath = identityParser(DIRECTORY_TARGET);

/** Parses free text; completes nothing. */
export const parseText = identityParser(TEXT_TARGET);

/** Parses one segment of a CLI command path; completes route names. */
export const parseCommandPath = identityParser(COMMAND_PATH_TARGET);

/** Parses a stored-account selector; completes stored accounts. */
export const parseAccountSelector = identityParser(ACCOUNT_TARGET);

/**
 * Build a parser that completes `values`. It returns its input unchanged,
 * so the command still validates it: the values are suggestions, and a
 * command may accept others (`cli upgrade 0.5.0` next to `nightly`).
 */
export function choiceParser(
  values: readonly string[],
): (input: string) => string {
  const parse = identityParser(CHOICE_TARGET);
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
  [sanitizeIssueQuery, ISSUE_QUERY_TARGET],
  [parsePeriod, PERIOD_TARGET],
  [parseLoginEmail, ACCOUNT_TARGET],
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
  /** Issue search keys with a fixed set of values, for {@link ISSUE_QUERY_TARGET} */
  issueSearch: Readonly<Record<string, readonly string[]>>;
  /** Units of a relative period, for {@link PERIOD_TARGET} (`7` → `7d`) */
  periodUnits: readonly string[];
  /** Relative periods offered for {@link PERIOD_TARGET}, with descriptions */
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
