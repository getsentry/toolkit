/**
 * Command example metadata shared by `buildCommand`, introspection, and the
 * doc generators. Kept dependency-free so scripts can import it cheaply.
 */

/**
 * A runnable example stored with its command for generated documentation.
 *
 * `command` is one invocation, or the ordered steps of a workflow that spans
 * several commands (e.g. create → set-commits → finalize). Every step is
 * checked against the route tree by `check:doc-examples`, so workflows belong
 * here rather than in hand-written fragment code blocks.
 */
export type CommandExample = {
  readonly description: string;
  readonly command: string | readonly string[];
};

/** The invocations of an example, one per step. */
export function exampleSteps(example: CommandExample): readonly string[] {
  return typeof example.command === "string"
    ? [example.command]
    : example.command;
}
