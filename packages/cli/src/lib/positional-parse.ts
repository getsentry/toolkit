/**
 * Positionals whose value parses and resolves lazily.
 *
 * A parser made with {@link lazyPositional} gives the command a stand-in
 * typed as `T & { resolved: Promise<R> }`:
 *
 * - Reading a property of `T` (e.g. `target.type`) runs the parse on first
 *   access, inside `func`.
 * - Reading `resolved` starts the positional's own resolver on first access
 *   and returns its promise, so `func` awaits `target.resolved` instead of
 *   picking and calling a resolver itself. A parse error rejects it.
 *
 * Until `func` reads it, the stand-in does nothing, so nothing can fail and
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
 * always gets a stand-in and every caller keeps passing what the user typed.
 *
 * Code that needs the raw input (plural alias interception, `help` recovery,
 * telemetry) reads it with {@link rawPositional}, which never parses.
 * `buildDeleteCommand` calls {@link markDestructive} on its positionals, so
 * resolvers see `destructive: true` and can refuse to auto-detect.
 */

import {
  type CompletionTarget,
  withCompletionTarget,
} from "./completion-target.js";

/** A lazily parsed positional value with a lazily started resolution. */
export type LazyPositional<T, R> = T & {
  /** Resolves the value on first access; rejects on a parse or resolve error. */
  readonly resolved: Promise<R>;
};

/** What the running command tells a positional's resolver. */
export type ResolveOptions = {
  /** The command is destructive (see {@link markDestructive}). */
  readonly destructive: boolean;
};

/** Per stand-in state: the raw input (`undefined` if omitted) and options. */
type StandInState = { raw: string | undefined; destructive: boolean };

const standIns = new WeakMap<object, StandInState>();

/** Parsers made by {@link lazyPositional}. */
const lazyParsers = new WeakSet<object>();

const RESOLVED_KEY = "resolved";

/**
 * A stand-in for `parse(raw)` that parses on first property access.
 *
 * `then` reads as `undefined` without parsing: Stricli awaits parser
 * results, and a promise checks whether a resolved value is thenable.
 * `resolved` is not an own key, so spreading or comparing the stand-in sees
 * only the parsed value.
 */
function lazyValue<T extends object, R, C>(
  raw: string | undefined,
  parse: (raw: string | undefined) => T,
  resolve: (value: T, context: C, options: ResolveOptions) => Promise<R>,
  context: C,
): LazyPositional<T, R> {
  const state: StandInState = { raw, destructive: false };
  let parsed: { value: T } | undefined;
  let resolved: Promise<R> | undefined;
  const value = (): T => {
    parsed ??= { value: parse(raw) };
    return parsed.value;
  };
  const standIn = new Proxy({} as LazyPositional<T, R>, {
    get: (_target, key) => {
      if (key === "then") {
        return;
      }
      if (key === RESOLVED_KEY) {
        resolved ??= (async () =>
          await resolve(value(), context, {
            destructive: state.destructive,
          }))();
        return resolved;
      }
      return Reflect.get(value(), key);
    },
    set: (_target, key, newValue) => Reflect.set(value(), key, newValue),
    has: (_target, key) => key === RESOLVED_KEY || Reflect.has(value(), key),
    ownKeys: () => Reflect.ownKeys(value()),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(value(), key);
      // The empty proxy target lacks the key, so it must report configurable
      return descriptor && { ...descriptor, configurable: true };
    },
  });
  standIns.set(standIn, state);
  return standIn;
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
export function lazyPositional<T extends object, R, C>(
  kind: CompletionTarget,
  parse: (raw: string | undefined) => T,
  resolve: (value: T, context: C, options: ResolveOptions) => Promise<R>,
): (this: C, input?: string) => LazyPositional<T, R> {
  const parser = withCompletionTarget(kind, function (this: C, input?: string) {
    return lazyValue(input, parse, resolve, this);
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
    if (typeof arg === "object" && arg !== null) {
      const state = standIns.get(arg);
      if (state) {
        state.destructive = true;
      }
    }
  }
}

/**
 * What the user typed for a positional value. Never triggers a parse.
 *
 * @returns The raw input behind a stand-in (`undefined` if omitted),
 *   otherwise `value`
 */
export function rawPositional(value: unknown): unknown {
  if (typeof value === "object" && value !== null) {
    const state = standIns.get(value);
    return state ? state.raw : value;
  }
  return value;
}
