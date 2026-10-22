/**
 * Positional parsers that throw CliErrors.
 *
 * Stricli runs positional parsers in its argument scanner and reports a
 * thrown error as a generic "Failed to parse" argument error (exit -4),
 * bypassing our CliError formatting, exit codes, and telemetry.
 * `buildCommand` wraps every positional parser with
 * {@link deferPositionalErrors}: a {@link CliError} becomes a
 * {@link DeferredPositionalError} value, which the command wrapper throws
 * before `func` runs, so the error surfaces like any other command error.
 *
 * The wrapper also remembers the raw input of object results, so code that
 * needs what the user typed (plural alias interception, `help` recovery,
 * telemetry) can read it with {@link rawPositional}.
 */

import {
  getCompletionTarget,
  withCompletionTarget,
} from "./completion-target.js";
import { CliError } from "./errors.js";

/** A positional whose parser threw a {@link CliError}. */
export class DeferredPositionalError {
  readonly raw: string;
  readonly error: CliError;

  constructor(raw: string, error: CliError) {
    this.raw = raw;
    this.error = error;
  }
}

/** Raw input of each object a wrapped positional parser returned. */
const rawInputs = new WeakMap<object, string>();

/** A Stricli positional parser. */
type PositionalParser = (this: unknown, input: string) => unknown;

/**
 * Wrap a positional parser so a {@link CliError} it throws is returned as a
 * {@link DeferredPositionalError} instead. Other errors still propagate.
 * Keeps the parser's completion target.
 */
export function deferPositionalErrors(
  parse: PositionalParser,
): PositionalParser {
  const wrapped = function (this: unknown, input: string): unknown {
    let value: unknown;
    try {
      value = parse.call(this, input);
    } catch (error) {
      if (error instanceof CliError) {
        return new DeferredPositionalError(input, error);
      }
      throw error;
    }
    if (typeof value === "object" && value !== null) {
      rawInputs.set(value, input);
    }
    return value;
  };
  const kind = getCompletionTarget(parse);
  return kind ? withCompletionTarget(kind, wrapped) : wrapped;
}

/** A Stricli positional definition — subset that carries the parsers. */
export type PositionalDef =
  | { kind: "tuple"; parameters: readonly { parse: PositionalParser }[] }
  | { kind: "array"; parameter: { parse: PositionalParser } };

/**
 * Wrap every parser of a command's positional definition with
 * {@link deferPositionalErrors}.
 *
 * @returns A copy of `positional` with wrapped parsers, or `positional`
 *   itself when the command takes no positionals
 */
export function deferPositionalParsers<P>(positional: P): P {
  const def = positional as PositionalDef | undefined;
  if (!def) {
    return positional;
  }
  if (def.kind === "array") {
    return {
      ...def,
      parameter: {
        ...def.parameter,
        parse: deferPositionalErrors(def.parameter.parse),
      },
    } as P;
  }
  return {
    ...def,
    parameters: def.parameters.map((param) => ({
      ...param,
      parse: deferPositionalErrors(param.parse),
    })),
  } as P;
}

/**
 * Throw the first {@link DeferredPositionalError} among a command's
 * positional values.
 */
export function throwDeferredPositionalError(args: readonly unknown[]): void {
  for (const arg of args) {
    if (arg instanceof DeferredPositionalError) {
      throw arg.error;
    }
  }
}

/**
 * What the user typed for a positional value.
 *
 * @returns The raw input of a parsed object or deferred error, otherwise
 *   `value` itself
 */
export function rawPositional(value: unknown): unknown {
  if (value instanceof DeferredPositionalError) {
    return value.raw;
  }
  if (typeof value === "object" && value !== null) {
    return rawInputs.get(value) ?? value;
  }
  return value;
}
