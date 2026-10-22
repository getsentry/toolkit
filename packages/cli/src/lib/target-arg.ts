/**
 * Target positionals that parse their own value.
 *
 * A positional that uses one of these parsers reaches the command function
 * as a {@link TargetArg} instead of a raw string, so the target syntax is
 * defined once, next to the positional, rather than re-parsed in every
 * command's `func`.
 *
 * Parsing is lazy: Stricli only wraps the input, and the parse runs on the
 * first {@link TargetArg.parsed} access inside `func`. Invalid input therefore
 * still throws the parser's `CliError` subclass from the command, with
 * its exit code, telemetry, and `--json` error output, instead of Stricli's
 * generic argument-parse error. Code that needs what the user typed (plural
 * alias interception, `help` recovery, telemetry) reads {@link TargetArg.raw}
 * through {@link rawPositional}.
 */

import { type ParsedOrgProject, parseOrgProjectArg } from "./arg-parsing.js";
import {
  ORG_PROJECT_TARGET,
  withCompletionTarget,
} from "./completion-target.js";

/** A scanned target positional: the raw input and its lazily parsed value. */
export class TargetArg<T> {
  readonly raw: string;
  readonly #parse: (raw: string) => T;
  #parsed: { value: T } | undefined;

  constructor(raw: string, parse: (raw: string) => T) {
    this.raw = raw;
    this.#parse = parse;
  }

  /**
   * The parsed target. Parses on first access.
   *
   * @throws The parser's error (usually a `ValidationError`) for invalid input
   */
  get parsed(): T {
    this.#parsed ??= { value: this.#parse(this.raw) };
    return this.#parsed.value;
  }
}

/** An `[<org>/][<project>]` positional, parsed by `parseOrgProjectArg`. */
export type OrgProjectTargetArg = TargetArg<ParsedOrgProject>;

/**
 * Positional parser for `<org>/`, `<org>/<project>`, `<project>`, and Sentry
 * URLs. Completes like `parseOrgProjectTarget`.
 */
export const parseOrgProjectTargetArg = withCompletionTarget(
  ORG_PROJECT_TARGET,
  (input: string): OrgProjectTargetArg =>
    new TargetArg(input, (raw) => parseOrgProjectArg(raw)),
);

/**
 * The parsed value of an `[<org>/][<project>]` positional.
 *
 * @returns Auto-detect when the positional was omitted, as
 *   `parseOrgProjectArg(undefined)` does
 * @throws The parser's error for invalid input
 */
export function parsedOrgProject(
  target: OrgProjectTargetArg | undefined,
): ParsedOrgProject {
  return target === undefined ? { type: "auto-detect" } : target.parsed;
}

/**
 * What the user typed for a positional value.
 *
 * @returns {@link TargetArg.raw} for a target positional, otherwise `value`
 */
export function rawPositional(value: unknown): unknown {
  return value instanceof TargetArg ? value.raw : value;
}
