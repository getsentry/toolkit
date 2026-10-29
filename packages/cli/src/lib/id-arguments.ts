/**
 * Positionals that end in an ID, parsed by `grammar/id-arguments.pegjs`.
 *
 * What these arguments mean depends on how many were given:
 * `[<org>/[<project>/]]<id>` in one argument, `<target> <id>` in two, or a
 * Sentry URL. The grammar sees every argument at once, decides which one is
 * the ID and which is the target, and names the target's parts. Callers turn
 * the result into their own target type (see `trace-target.ts` and
 * `commands/replay/view.ts`).
 *
 * Parsing has no side effects: a pasted URL's server comes back as `baseUrl`
 * and ignored arguments as `warnings`, for the caller to apply.
 */

import { parse } from "../generated/id-arguments-grammar.js";
import { ContextError, ValidationError } from "./errors.js";
import { tryNormalizeHexId, validateHexId } from "./hex-id.js";
import { parseSentryUrl } from "./sentry-url-parser.js";

/** What the arguments said to look the ID up in. */
export type IdScope =
  /** Nothing: `<id>` or a URL without an org */
  | { readonly type: "none" }
  /** `<org>/<id>` or a URL's org */
  | { readonly type: "org"; readonly org: string }
  /** `<org>/<project>/<id>` */
  | {
      readonly type: "org-project";
      readonly org: string;
      readonly project: string;
    }
  /** `<target> <id>`: a separate target argument, not parsed yet */
  | { readonly type: "target"; readonly target: string };

/** Arguments that end in an ID, parsed. */
export type IdArguments = {
  /** The normalized ID */
  readonly id: string;
  readonly scope: IdScope;
  /** Server of a pasted Sentry URL, for `applySentryUrlContext` */
  readonly baseUrl?: string;
  /** Warnings to log, such as for ignored arguments */
  readonly warnings: readonly string[];
};

/** Arguments that list a project's items or, ending in a trace ID, a trace's. */
export type TraceOrProjectArguments =
  /** `target` is the first argument, if any */
  | { readonly mode: "project"; readonly target?: string }
  | { readonly mode: "trace"; readonly trace: IdArguments };

/** The grammar's start rules that parse {@link IdArguments}. */
type IdArgumentsRule = "trace" | "tracePath" | "replay";

/** What an ID is called, and how the command is used, for errors. */
type IdArgumentsContext = {
  /** e.g. `"Trace ID"` */
  readonly idLabel: string;
  readonly usageHint: string;
};

/**
 * Parse arguments that end in an ID.
 *
 * @param rule - `trace` or `replay` for the arguments of those commands,
 *   `tracePath` for one `[<org>/[<project>/]]<trace-id>` argument
 * @throws {ContextError} When the ID is missing
 * @throws {ValidationError} When the ID is invalid or there are too many
 *   arguments
 */
export function parseIdArguments(
  args: readonly string[],
  rule: IdArgumentsRule,
  context: IdArgumentsContext,
): IdArguments {
  return parse(grammarInput(args), { ...hooks(context), startRule: rule });
}

/**
 * Parse the arguments of a command that lists a project's items or a
 * trace's: trace mode when they are a trace URL, end in a trace ID, or start
 * with `[<org>/[<project>/]]<trace-id>`.
 */
export function parseTraceOrProjectArguments(
  args: readonly string[],
  usageHint: string,
): TraceOrProjectArguments {
  return parse(grammarInput(args), {
    ...hooks({ idLabel: "Trace ID", usageHint }),
    startRule: "traceOrProject",
  });
}

/**
 * The grammar's input: every argument, trimmed, after a NUL. A command line
 * cannot contain NUL, so the grammar can always tell the arguments apart.
 */
function grammarInput(args: readonly string[]): string {
  return args
    .map((arg) => {
      if (arg.includes("\0")) {
        throw new ValidationError(
          "Arguments cannot contain NUL characters.",
          "positional",
        );
      }
      return `\0${arg.trim()}`;
    })
    .join("");
}

function hooks({ idLabel, usageHint }: IdArgumentsContext) {
  const label = idLabel.charAt(0).toLowerCase() + idLabel.slice(1);
  return {
    usageHint,
    isId: (value: string) => tryNormalizeHexId(value) !== undefined,
    id: (value: string) => validateHexId(value, label),
    sentryUrl: parseSentryUrl,
    missing: (suggestions: string[] = []): never => {
      throw new ContextError(idLabel, usageHint, suggestions);
    },
    invalid: (message: string, field?: string): never => {
      throw new ValidationError(message, field);
    },
  };
}
