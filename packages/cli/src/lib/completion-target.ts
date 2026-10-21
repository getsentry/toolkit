/**
 * Completion-aware positional parsers.
 *
 * Target positionals use these instead of `String` so shell completion can
 * read the target kind straight from the command's `parameters`. Every
 * parser returns its input unchanged; the kind is identified by which
 * function a positional uses. `script/generate-completion-targets.ts`
 * collects them at build time because the `__complete` fast path cannot boot
 * Stricli to walk the route tree.
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

/** Every completion target kind, in a stable order. */
export const COMPLETION_TARGETS = [
  ORG_TARGET,
  ORG_PROJECT_TARGET,
  ISSUE_TARGET,
  DASHBOARD_TARGET,
] as const;

/** Which cached values shell completion suggests for a target positional. */
export type CompletionTarget = (typeof COMPLETION_TARGETS)[number];

/** Parser for positionals whose leading segment is an organization slug. */
export function parseOrgTarget(input: string): string {
  return input;
}

/** Parser for positionals that start with `org/project`, a project, or an alias. */
export function parseOrgProjectTarget(input: string): string {
  return input;
}

/** Parser for positionals that name an issue (short ID, `org/ID`, ...). */
export function parseIssueTarget(input: string): string {
  return input;
}

/** Parser for `[<org/project>] <dashboard-id-or-title>` positionals. */
export function parseDashboardTarget(input: string): string {
  return input;
}

const PARSER_TARGETS = new Map<unknown, CompletionTarget>([
  [parseOrgTarget, ORG_TARGET],
  [parseOrgProjectTarget, ORG_PROJECT_TARGET],
  [parseIssueTarget, ISSUE_TARGET],
  [parseDashboardTarget, DASHBOARD_TARGET],
]);

/**
 * Read the completion kind from a positional's `parse` function.
 *
 * @returns The kind for one of the parsers above, or `undefined` for any
 *   other parser
 */
export function getCompletionTarget(
  parse: unknown,
): CompletionTarget | undefined {
  return PARSER_TARGETS.get(parse);
}
