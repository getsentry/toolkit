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
 * so parsers and resolvers see `destructive: true`. A parser that refuses
 * input there (an auto-detected target) guards both `parsed` and `resolved`.
 */

import {
  type CompletionTarget,
  withCompletionTarget,
} from "./completion-target.js";

/** What the running command tells a positional's parser and resolver. */
export type ResolveOptions = {
  /** The command is destructive (see {@link markDestructive}). */
  readonly destructive: boolean;
};

/** Values whose command is destructive (see {@link markDestructive}). */
const destructiveValues = new WeakSet<object>();

/** Values whose parse has run, so marking them is too late. */
const parsedValues = new WeakSet<object>();

/** Parsers made by {@link lazyPositional}. */
const lazyParsers = new WeakSet<object>();

/** The outcome of a parse: its value or what it threw. */
type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * A positional value that parses on first `parsed` read and resolves on
 * first `resolved` read. Each step runs once; a parse error is rethrown on
 * later reads without parsing again.
 */
export class LazyPositional<T, R> {
  #parsed: ParseOutcome<T> | undefined;
  #resolved: Promise<R> | undefined;
  readonly #parse: (raw: string | undefined, options: ResolveOptions) => T;
  readonly #resolve: (value: T, options: ResolveOptions) => Promise<R>;

  /** What the user typed; `undefined` for an omitted positional. */
  readonly raw: string | undefined;

  constructor(
    raw: string | undefined,
    parse: (raw: string | undefined, options: ResolveOptions) => T,
    resolve: (value: T, options: ResolveOptions) => Promise<R>,
  ) {
    this.raw = raw;
    this.#parse = parse;
    this.#resolve = resolve;
  }

  /** The parsed value. Throws the parser's error. */
  get parsed(): T {
    this.#parsed ??= this.#runParse();
    if (!this.#parsed.ok) {
      throw this.#parsed.error;
    }
    return this.#parsed.value;
  }

  /** The resolved value; rejects on a parse or resolve error. */
  get resolved(): Promise<R> {
    this.#resolved ??= (async () =>
      await this.#resolve(this.parsed, this.#options()))();
    return this.#resolved;
  }

  #runParse(): ParseOutcome<T> {
    parsedValues.add(this);
    try {
      return { ok: true, value: this.#parse(this.raw, this.#options()) };
    } catch (error) {
      // Rethrown by every `parsed` read; parsing again could repeat side
      // effects such as applying a pasted URL's host.
      return { ok: false, error };
    }
  }

  #options(): ResolveOptions {
    return { destructive: destructiveValues.has(this) };
  }
}

/**
 * Build a positional parser that hands the command a {@link LazyPositional}.
 *
 * @param kind - Shell completion kind for the positional
 * @param parse - Parses the raw input (`undefined` when omitted); may throw a
 *   `CliError`. Gets the command context that Stricli passes to parsers as
 *   `this`, and {@link ResolveOptions}; checks that must hold before any use
 *   of the value, such as refusing auto-detect in a destructive command,
 *   belong here
 * @param resolve - Resolves the parsed value; gets the same context and
 *   options
 */
export function lazyPositional<T, R, C>(
  kind: CompletionTarget,
  parse: (raw: string | undefined, context: C, options: ResolveOptions) => T,
  resolve: (value: T, context: C, options: ResolveOptions) => Promise<R>,
): (this: C, input?: string) => LazyPositional<T, R> {
  const parser = withCompletionTarget(kind, function (this: C, input?: string) {
    return new LazyPositional(
      input,
      (raw, options) => parse(raw, this, options),
      (value: T, options) => resolve(value, this, options),
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
 * Tell the parsers and resolvers of these positionals that the command is
 * destructive. Other values are ignored.
 *
 * @throws {Error} When a positional was already parsed, so its parser ran
 *   without the destructive checks
 */
export function markDestructive(args: readonly unknown[]): void {
  for (const arg of args) {
    if (arg instanceof LazyPositional) {
      if (parsedValues.has(arg)) {
        throw new Error(
          "markDestructive must run before the positional is parsed",
        );
      }
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
