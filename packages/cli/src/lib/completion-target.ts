/**
 * Completion-aware positional parsers.
 *
 * Target positionals use a parser tagged with {@link withCompletionTarget}
 * instead of `String` so shell completion can read the target kind straight
 * from the command's `parameters`. `script/generate-completion-targets.ts`
 * collects them at build time because the `__complete` fast path cannot boot
 * Stricli to walk the route tree.
 *
 * {@link parseOrgTarget} and {@link parseOrgProjectTarget} return their input
 * unchanged and only mark the kind. Parsers that also parse the value, such
 * as those in `target-positional.ts`, use the same tag.
 */

/** Completes organization slugs only (e.g. `org`, `org/version`, `org/id`). */
export const ORG_TARGET = "org";

/** Completes `org/` prefixes, `org/project` pairs, and project aliases. */
export const ORG_PROJECT_TARGET = "org/project";

/** Every completion target kind, in a stable order. */
export const COMPLETION_TARGETS = [ORG_TARGET, ORG_PROJECT_TARGET] as const;

/** Which cached slugs shell completion suggests for a target positional. */
export type CompletionTarget = (typeof COMPLETION_TARGETS)[number];

const COMPLETION_TARGET_KEY = Symbol("completionTarget");

/**
 * Tag a positional parser with the completion kind it accepts.
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

/**
 * Read the completion kind from a positional's `parse` function.
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
