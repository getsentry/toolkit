/**
 * Completion-aware positional parsers.
 *
 * Target positionals use these instead of `String` so shell completion can
 * read the target kind straight from the command's `parameters`. Both parsers
 * return their input unchanged; the kind is identified by which function a
 * positional uses. `script/generate-completion-targets.ts` collects them at
 * build time because the `__complete` fast path cannot boot Stricli to walk
 * the route tree.
 */

/**
 * Which cached slugs shell completion suggests for a target positional.
 *
 * - `"org"`: organization slugs only (e.g. `org`, `org/version`, `org/id`)
 * - `"org/project"`: `org/` prefixes, `org/project` pairs, and project aliases
 */
export type CompletionTarget = "org" | "org/project";

/** Parser for positionals whose leading segment is an organization slug. */
export function parseOrgTarget(input: string): string {
  return input;
}

/** Parser for positionals that start with `org/project`, a project, or an alias. */
export function parseOrgProjectTarget(input: string): string {
  return input;
}

/**
 * Read the completion kind from a positional's `parse` function.
 *
 * @returns The kind for {@link parseOrgTarget} / {@link parseOrgProjectTarget},
 *   or `undefined` for any other parser
 */
export function getCompletionTarget(
  parse: unknown,
): CompletionTarget | undefined {
  if (parse === parseOrgTarget) {
    return "org";
  }
  if (parse === parseOrgProjectTarget) {
    return "org/project";
  }
  return;
}
