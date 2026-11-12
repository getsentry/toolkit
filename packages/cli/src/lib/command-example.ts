/**
 * Command example metadata shared by `buildCommand`, introspection, and the
 * doc generators. Kept dependency-free so scripts can import it cheaply.
 */

/**
 * One invocation in an example, written without the program name:
 * `issue list my-org/frontend`. Each renderer adds the program: `--help`
 * names the running one, generated docs and skills name `sentry`.
 *
 * A step that runs inside other shell text keeps that text around the
 * invocation, as `{ prefix: "sudo ", args: "cli fix" }`.
 */
export type ExampleStep =
  | string
  | {
      readonly prefix?: string;
      readonly args: string;
      readonly suffix?: string;
    };

/**
 * A runnable example stored with its command for generated documentation.
 *
 * `run` is one invocation, or the ordered steps of a workflow that spans
 * several commands (e.g. create → set-commits → finalize). Every step is
 * checked against the route tree by `check:doc-examples`, so workflows belong
 * here rather than in hand-written fragment code blocks.
 */
export type CommandExample = {
  readonly description: string;
  readonly run: ExampleStep | readonly ExampleStep[];
};

function isStepList(run: CommandExample["run"]): run is readonly ExampleStep[] {
  return Array.isArray(run);
}

/** The invocations of an example, one per step, run as `program`. */
export function exampleSteps(
  example: CommandExample,
  program: string,
): readonly string[] {
  const steps = isStepList(example.run) ? example.run : [example.run];
  return steps.map((step) =>
    typeof step === "string"
      ? `${program} ${step}`
      : `${step.prefix ?? ""}${program} ${step.args}${step.suffix ?? ""}`,
  );
}
