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
 */

import {
  type CompletionTarget,
  withCompletionTarget,
} from "./completion-target.js";

/** Destructive-command checks of {@link boundPositional} values. */
const destructiveChecks = new WeakMap<object, () => void>();

/** Parsers made by {@link boundPositional}. */
const boundParsers = new WeakSet<object>();

/**
 * A parsed positional value bound to its resolver, which runs once, on the
 * first `resolved` read.
 */
export class BoundPositional<T, R> {
  #resolved: Promise<R> | undefined;
  readonly #resolve: (value: T) => Promise<R>;

  /** What the user typed; `undefined` for an omitted positional. */
  readonly raw: string | undefined;
  /** The parsed value. */
  readonly parsed: T;

  constructor(
    raw: string | undefined,
    parsed: T,
    resolve: (value: T) => Promise<R>,
  ) {
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

/** A Stricli positional definition — the subset that carries the parsers. */
type PositionalDef =
  | { kind: "tuple"; parameters: readonly { parse?: unknown }[] }
  | { kind: "array"; parameter: { parse?: unknown } };

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
 * leaves `undefined`. Other positionals are left as they are.
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
 * What the user typed for a positional value.
 *
 * @returns `value.raw` for a {@link BoundPositional}, otherwise `value`
 */
export function rawPositional(value: unknown): unknown {
  return value instanceof BoundPositional ? value.raw : value;
}
