/**
 * Positionals whose value parses and resolves lazily.
 *
 * A parser made with {@link lazyPositional} gives the command a
 * {@link LazyPositional}:
 *
 * - `target.parsed` runs the parse on first access, inside `func`.
 * - `target.resolved` starts the positional's own resolver on first access
 *   and returns its promise, so `func` awaits it instead of picking and
 *   calling a resolver itself. A parse error rejects it.
 * - `target.raw` is what the user typed (`undefined` if omitted).
 *
 * Until `func` reads it, the value does nothing, so nothing can fail and
 * nothing runs early:
 *
 * - Stricli's argument scanner never sees an error, so invalid input still
 *   throws the parser's `CliError` from the command, with its exit code,
 *   telemetry, and `--json` error output, instead of Stricli's generic
 *   "Failed to parse" (exit -4).
 * - Parser side effects, such as `parseOrgProjectArg` applying the host of a
 *   pasted Sentry URL, run after the auth guard and rc URL check, as they did
 *   when `func` called the parser itself.
 *
 * `buildCommand` also runs these parsers on positionals that reach the
 * command as plain strings (the SDK invoke path and tests calling the loaded
 * func) and on omitted optional ones (parsed from `undefined`), so `func`
 * always gets a {@link LazyPositional} and every caller keeps passing what
 * the user typed.
 *
 * Shared code that handles any positional (plural alias interception, `help`
 * recovery, telemetry) reads the raw input with {@link rawPositional}.
 * `buildCommand` calls {@link markDestructive} on the positionals of
 * destructive commands (`destructive: true`, which `buildDeleteCommand` sets),
 * so resolvers see `destructive: true` and can refuse to auto-detect.
 */

import {
  type CompletionTarget,
  withCompletionTarget,
} from "./completion-target.js";

/** What the running command tells a positional's resolver. */
export type ResolveOptions = {
  /** The command is destructive (see {@link markDestructive}). */
  readonly destructive: boolean;
};

/** Values whose command is destructive (see {@link markDestructive}). */
const destructiveValues = new WeakSet<object>();

/** Parsers made by {@link lazyPositional}. */
const lazyParsers = new WeakSet<object>();

/**
 * A positional value that parses on first `parsed` read and resolves on
 * first `resolved` read. Each step runs once.
 */
export class LazyPositional<T, R> {
  #parsed: { value: T } | undefined;
  #resolved: Promise<R> | undefined;
  readonly #parse: (raw: string | undefined) => T;
  readonly #resolve: (value: T, options: ResolveOptions) => Promise<R>;

  /** What the user typed; `undefined` for an omitted positional. */
  readonly raw: string | undefined;

  constructor(
    raw: string | undefined,
    parse: (raw: string | undefined) => T,
    resolve: (value: T, options: ResolveOptions) => Promise<R>,
  ) {
    this.raw = raw;
    this.#parse = parse;
    this.#resolve = resolve;
  }

  /** The parsed value. Throws the parser's error. */
  get parsed(): T {
    this.#parsed ??= { value: this.#parse(this.raw) };
    return this.#parsed.value;
  }

  /** The resolved value; rejects on a parse or resolve error. */
  get resolved(): Promise<R> {
    this.#resolved ??= (async () =>
      await this.#resolve(this.parsed, {
        destructive: destructiveValues.has(this),
      }))();
    return this.#resolved;
  }
}

/**
 * Build a positional parser that hands the command a {@link LazyPositional}.
 *
 * @param kind - Shell completion kind for the positional
 * @param parse - Parses the raw input (`undefined` when omitted); may throw a
 *   `CliError`
 * @param resolve - Resolves the parsed value; gets the command context that
 *   Stricli passes to parsers as `this`, and {@link ResolveOptions}
 */
export function lazyPositional<T, R, C>(
  kind: CompletionTarget,
  parse: (raw: string | undefined) => T,
  resolve: (value: T, context: C, options: ResolveOptions) => Promise<R>,
): (this: C, input?: string) => LazyPositional<T, R> {
  const parser = withCompletionTarget(kind, function (this: C, input?: string) {
    return new LazyPositional(input, parse, (value: T, options) =>
      resolve(value, this, options),
    );
  });
  lazyParsers.add(parser);
  return parser;
}

/** A Stricli positional definition — the subset that carries the parsers. */
type PositionalDef =
  | { kind: "tuple"; parameters: readonly { parse?: unknown }[] }
  | { kind: "array"; parameter: { parse?: unknown } };

/** The {@link lazyPositional} parser at a positional index, if any. */
function lazyParserAt(
  def: PositionalDef,
  index: number,
): ((this: unknown, input?: string) => unknown) | undefined {
  const parse =
    def.kind === "array" ? def.parameter.parse : def.parameters[index]?.parse;
  return typeof parse === "function" && lazyParsers.has(parse)
    ? (parse as (this: unknown, input?: string) => unknown)
    : undefined;
}

/**
 * Give every {@link lazyPositional} positional its stand-in.
 *
 * Stricli already ran the parsers for typed input. This covers callers that
 * skip its scanner (the SDK invoke path, tests calling the loaded func),
 * which pass raw strings, and omitted optional positionals, which Stricli
 * leaves `undefined`. Lazy parsers never throw and have no side effects, so
 * this is safe to run up front. Other positionals are left as they are.
 *
 * @param context - Passed to each parser as `this`, as Stricli does
 */
export function applyLazyPositionals(
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
    const parse = lazyParserAt(def, index);
    const missing = arg === undefined && def.kind === "tuple";
    return parse && (typeof arg === "string" || missing)
      ? parse.call(context, arg)
      : arg;
  });
}

/**
 * Tell the resolvers of these positionals that the command is destructive.
 * Must run before `func` reads `resolved`. Other values are ignored.
 */
export function markDestructive(args: readonly unknown[]): void {
  for (const arg of args) {
    if (arg instanceof LazyPositional) {
      destructiveValues.add(arg);
    }
  }
}

/**
 * What the user typed for a positional value. Never triggers a parse.
 *
 * @returns `value.raw` for a {@link LazyPositional}, otherwise `value`
 */
export function rawPositional(value: unknown): unknown {
  return value instanceof LazyPositional ? value.raw : value;
}
