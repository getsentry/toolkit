/**
 * Positionals that Stricli parses and the command resolves.
 *
 * A parser made with {@link boundPositional} gives the command a
 * {@link BoundPositional}:
 *
 * - `target.parsed` is the parsed value. Stricli runs the parse in its
 *   argument scanner, so invalid input fails like any other argument:
 *   `Failed to parse "<input>" for <placeholder>: …` and Stricli's
 *   `InvalidArgument` exit code (-4, shown as 252).
 * - `target.resolved` starts the positional's own resolver on first access
 *   and returns its promise, so `func` awaits it instead of picking and
 *   calling a resolver itself. It runs inside `func`, after the auth guard
 *   and rc URL check.
 * - `target.raw` is what the user typed (`undefined` if omitted).
 *
 * The parse must have no side effects: it runs before the auth guard, and
 * also when a later argument fails to parse. Work that changes state, such
 * as applying the host of a pasted Sentry URL, belongs in the resolver.
 *
 * `buildCommand` also runs these parsers on positionals that reach the
 * command as plain strings (the SDK invoke path and tests calling the loaded
 * func) and on omitted optional ones (parsed from `undefined`), so `func`
 * always gets a {@link BoundPositional}. Shared code that handles any
 * positional (plural alias interception, `help` recovery, telemetry) reads
 * the raw input with {@link rawPositional}.
 *
 * {@link boundArguments} does the same for positionals whose meaning depends
 * on how many arguments were given, such as `[<org>/<project>] <id>`: it
 * parses all of them at once (in the scanner, through our Stricli patch's
 * `combine` hook) and hands `func` one {@link BoundArguments}.
 */

import {
  type CompletionTarget,
  withCompletionTarget,
} from "./completion-target.js";

/** Destructive-command checks of {@link boundPositional} values. */
const destructiveChecks = new WeakMap<object, () => void>();

/** Parsers made by {@link boundPositional}. */
const boundParsers = new WeakSet<object>();

/** `combine` functions made by {@link boundArguments}. */
const argumentCombiners = new WeakSet<object>();

/** Parse errors of {@link boundArguments} values, thrown when `func` runs. */
const deferredParseErrors = new WeakMap<object, unknown>();

/**
 * Whether the user typed `help` (or a mistyped help flag) as an argument,
 * which `buildCommand` answers with the command's help.
 */
export function isHelpArgument(raw: unknown): boolean {
  return raw === "help" || raw === "--h" || raw === "-help";
}

/**
 * A parsed positional value bound to its resolver, which runs once, on the
 * first `resolved` read.
 */
export class BoundPositional<T, R, RAW = string | undefined> {
  #resolved: Promise<R> | undefined;
  readonly #resolve: (value: T) => Promise<R>;

  /**
   * What the user typed; `undefined` for an omitted positional, every
   * argument for {@link boundArguments}.
   */
  readonly raw: RAW;
  /** The parsed value. */
  readonly parsed: T;

  constructor(raw: RAW, parsed: T, resolve: (value: T) => Promise<R>) {
    this.raw = raw;
    this.parsed = parsed;
    this.#resolve = resolve;
  }

  /** The resolved value; rejects on a resolve error. */
  get resolved(): Promise<R> {
    this.#resolved ??= this.#resolve(this.parsed);
    return this.#resolved;
  }
}

/**
 * Build a positional parser that hands the command a {@link BoundPositional}.
 *
 * @param kind - Shell completion kind for the positional
 * @param parse - Parses the raw input (`undefined` when omitted); may throw.
 *   Must have no side effects
 * @param resolve - Resolves the parsed value; gets the command context that
 *   Stricli passes to parsers as `this`, and the raw input
 * @param checkDestructive - Throws when the parsed value is not allowed in a
 *   destructive command (see {@link checkDestructive})
 */
export function boundPositional<T, R, C>(
  kind: CompletionTarget,
  parse: (raw: string | undefined) => T,
  resolve: (value: T, context: C, raw: string | undefined) => Promise<R>,
  checkDestructive?: (value: T, context: C) => void,
): (this: C, input?: string) => BoundPositional<T, R> {
  const parser = withCompletionTarget(kind, function (this: C, input?: string) {
    const value = new BoundPositional(input, parse(input), (parsed: T) =>
      resolve(parsed, this, input),
    );
    if (checkDestructive) {
      destructiveChecks.set(value, () => checkDestructive(value.parsed, this));
    }
    return value;
  });
  boundParsers.add(parser);
  return parser;
}

/** Every argument of a {@link boundArguments} positional, parsed and bound. */
export type BoundArguments<T, R> = BoundPositional<T, R, readonly string[]>;

/**
 * Build an array positional whose arguments parse as a whole, for syntaxes
 * where what an argument means depends on how many were given (e.g.
 * `[<org>/<project>] <id>`, or a trailing trace ID). `func` gets one
 * {@link BoundArguments} instead of `...args: string[]`.
 *
 * Each argument completes as `kind`. Stricli then hands every argument to
 * `parse` through the positional's `combine` hook (our Stricli patch), so a
 * parse error fails in the argument scanner like any other (exit 252). When
 * an argument is `help`, the error is thrown when `func` would run instead,
 * so `buildCommand` shows the command's help.
 *
 * @param options.parse - Parses all the arguments, possibly none; may
 *   throw. Must have no side effects
 * @param options.resolve - Resolves the parsed value; gets the command
 *   context and the raw arguments
 */
export function boundArguments<T, R, C>(options: {
  readonly placeholder: string;
  readonly brief: string;
  readonly kind: CompletionTarget;
  readonly parse: (raw: readonly string[]) => T;
  readonly resolve: (
    value: T,
    context: C,
    raw: readonly string[],
  ) => Promise<R>;
}): {
  readonly kind: "array";
  readonly parameter: {
    readonly placeholder: string;
    readonly brief: string;
    readonly parse: (input: string) => string;
  };
  readonly combine: (
    this: C,
    values: readonly string[],
  ) => BoundArguments<T, R>;
} {
  const combine = function (this: C, values: readonly string[]) {
    const raw = [...values];
    let parsed: T;
    try {
      parsed = options.parse(raw);
    } catch (error) {
      if (!raw.some(isHelpArgument)) {
        throw error;
      }
      const failed = new BoundPositional(raw, undefined as T, () =>
        Promise.reject(error),
      );
      deferredParseErrors.set(failed, error);
      return failed;
    }
    return new BoundPositional(raw, parsed, (value: T) =>
      options.resolve(value, this, raw),
    );
  };
  argumentCombiners.add(combine);
  return {
    kind: "array",
    parameter: {
      placeholder: options.placeholder,
      brief: options.brief,
      parse: withCompletionTarget(options.kind, (input: string) => input),
    },
    combine,
  };
}

/** A Stricli positional definition — the subset that carries the parsers. */
type PositionalDef =
  | { kind: "tuple"; parameters: readonly { parse?: unknown }[] }
  | {
      kind: "array";
      parameter: { parse?: unknown };
      combine?: (this: unknown, values: readonly string[]) => unknown;
    };

/** The {@link boundPositional} parser at a positional index, if any. */
function boundParserAt(
  def: PositionalDef,
  index: number,
): ((this: unknown, input?: string) => unknown) | undefined {
  const parse =
    def.kind === "array" ? def.parameter.parse : def.parameters[index]?.parse;
  return typeof parse === "function" && boundParsers.has(parse)
    ? (parse as (this: unknown, input?: string) => unknown)
    : undefined;
}

/**
 * Give every {@link boundPositional} positional its value.
 *
 * Stricli already ran the parsers for typed input. This covers callers that
 * skip its scanner (the SDK invoke path, tests calling the loaded func),
 * which pass raw strings, and omitted optional positionals, which Stricli
 * leaves `undefined`. Other positionals are left as they are. Raw strings
 * for a {@link boundArguments} positional become one {@link BoundArguments}.
 *
 * @param context - Passed to each parser as `this`, as Stricli does
 * @throws The parser's error for an invalid raw string
 */
export function applyBoundPositionals(
  args: readonly unknown[],
  positional: unknown,
  context: unknown,
): unknown[] {
  const def = positional as PositionalDef | undefined;
  if (!def) {
    return [...args];
  }
  if (
    def.kind === "array" &&
    def.combine &&
    argumentCombiners.has(def.combine)
  ) {
    // Stricli's scanner already combined them into one bound value
    if (args.length === 1 && args[0] instanceof BoundPositional) {
      return [...args];
    }
    return [def.combine.call(context, args as readonly string[])];
  }
  const count =
    def.kind === "tuple"
      ? Math.max(args.length, def.parameters.length)
      : args.length;
  return Array.from({ length: count }, (_, index) => {
    const arg = args[index];
    const parse = boundParserAt(def, index);
    const missing = arg === undefined && def.kind === "tuple";
    return parse && (typeof arg === "string" || missing)
      ? parse.call(context, arg)
      : arg;
  });
}

/**
 * Run the destructive-command checks of these positionals, such as a target
 * refusing to auto-detect. Other values are ignored.
 *
 * @throws The first failing check's error
 */
export function checkDestructive(args: readonly unknown[]): void {
  for (const arg of args) {
    if (arg instanceof BoundPositional) {
      destructiveChecks.get(arg)?.();
    }
  }
}

/**
 * Throw the parse error {@link boundArguments} deferred because an argument
 * was `help`. Other values are ignored.
 */
export function throwDeferredParseErrors(args: readonly unknown[]): void {
  for (const arg of args) {
    if (arg instanceof BoundPositional && deferredParseErrors.has(arg)) {
      throw deferredParseErrors.get(arg);
    }
  }
}

/**
 * What the user typed for a positional value.
 *
 * @returns `value.raw` for a {@link BoundPositional} (every argument for
 *   {@link BoundArguments}), otherwise `value`
 */
export function rawPositional(value: unknown): unknown {
  return value instanceof BoundPositional ? value.raw : value;
}
