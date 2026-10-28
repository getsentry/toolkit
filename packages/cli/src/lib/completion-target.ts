/**
 * Completion-aware argument parsers.
 *
 * Positionals and flags use a parser tagged with {@link withCompletionTarget}
 * so shell completion can read what an argument completes straight from the
 * command's `parameters`, the same place that says how it parses.
 * `script/generate-completion-targets.ts` collects the kind of every
 * positional and flag at build time because the `__complete` fast path
 * cannot boot Stricli to walk the route tree. `src/lib/complete.ts` maps
 * each kind to its completer.
 *
 * {@link parseOrgTarget}, {@link parseOrgProjectTarget},
 * {@link parseIssueTarget}, and {@link parseDashboardTarget} return their
 * input unchanged and only mark the kind. Parsers that also parse the value,
 * such as those in `target-positional.ts`, `sanitizeIssueQuery`, and
 * `parsePeriod`, use the same tag.
 */

/** Completes organization slugs only (e.g. `org`, `org/version`, `org/id`). */
export const ORG_TARGET = "org";

/** Completes `org/` prefixes, `org/project` pairs, and project aliases. */
export const ORG_PROJECT_TARGET = "org/project";

/** Completes everything {@link ORG_PROJECT_TARGET} does plus cached issue short IDs. */
export const ISSUE_TARGET = "issue";

/**
 * Completes `org/` prefixes and cached dashboards: `org/<id>` in the first
 * positional, bare IDs after an org positional.
 */
export const DASHBOARD_TARGET = "dashboard";

/** Completes the term at the end of an issue search query (`is:` values). */
export const ISSUE_QUERY_TARGET = "issue-query";

/** Completes relative `--period` values (`24h`, `7d`, a number plus a unit). */
export const PERIOD_TARGET = "period";

/** Every completion target kind, in a stable order. */
export const COMPLETION_TARGETS = [
  ORG_TARGET,
  ORG_PROJECT_TARGET,
  ISSUE_TARGET,
  DASHBOARD_TARGET,
  ISSUE_QUERY_TARGET,
  PERIOD_TARGET,
] as const;

/** What shell completion suggests for an argument. */
export type CompletionTarget = (typeof COMPLETION_TARGETS)[number];

const COMPLETION_TARGET_KEY = Symbol("completionTarget");

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

/** Parser for positionals whose leading segment is an organization slug. */
export const parseOrgTarget = withCompletionTarget(
  ORG_TARGET,
  (input: string): string => input,
);

/** Parser for positionals that start with `org/project`, a project, or an alias. */
export const parseOrgProjectTarget = withCompletionTarget(
  ORG_PROJECT_TARGET,
  (input: string): string => input,
);

/** Parser for positionals that name an issue (short ID, `org/ID`, ...). */
export const parseIssueTarget = withCompletionTarget(
  ISSUE_TARGET,
  (input: string): string => input,
);

/** Parser for `[<org/project>] <dashboard-id-or-title>` positionals. */
export const parseDashboardTarget = withCompletionTarget(
  DASHBOARD_TARGET,
  (input: string): string => input,
);

/**
 * Read the completion kind from a positional's or flag's `parse` function.
 *
 * @returns The kind a parser was tagged with by {@link withCompletionTarget},
 *   or `undefined` for any other parser
 */
export function getCompletionTarget(
  parse: unknown,
): CompletionTarget | undefined {
  if (typeof parse !== "function") {
    return;
  }
  return (parse as { [COMPLETION_TARGET_KEY]?: CompletionTarget })[
    COMPLETION_TARGET_KEY
  ];
}
