/**
 * Positionals whose value parses lazily.
 *
 * A parser made with {@link lazyPositional} gives the command a stand-in
 * for the parsed value. The stand-in has the parsed value's type, so `func`
 * reads it like any other value (`target.type`, `target.org`), but the parse
 * only runs on the first property access inside `func`. Until then nothing
 * can fail and nothing runs early:
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
 * func), so every caller can keep passing what the user typed.
 *
 * Code that needs the raw input (plural alias interception, `help` recovery,
 * telemetry) reads it with {@link rawPositional}, which never parses.
 */

import {
  type CompletionTarget,
  withCompletionTarget,
} from "./completion-target.js";

/** Raw input behind each stand-in. */
const rawInputs = new WeakMap<object, string>();

/** Parsers made by {@link lazyPositional}. */
const lazyParsers = new WeakSet<object>();

/**
 * A stand-in for `parse(raw)` that parses on first property access.
 *
 * `then` reads as `undefined` without parsing: Stricli awaits parser
 * results, and a promise checks whether a resolved value is thenable.
 */
function lazyValue<T extends object>(
  raw: string,
  parse: (raw: string) => T,
): T {
  let parsed: { value: T } | undefined;
  const value = (): T => {
    parsed ??= { value: parse(raw) };
    return parsed.value;
  };
  const standIn = new Proxy({} as T, {
    get: (_target, key) =>
      key === "then" ? undefined : Reflect.get(value(), key),
    set: (_target, key, newValue) => Reflect.set(value(), key, newValue),
    has: (_target, key) => Reflect.has(value(), key),
    ownKeys: () => Reflect.ownKeys(value()),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(value(), key);
      // The empty proxy target lacks the key, so it must report configurable
      return descriptor && { ...descriptor, configurable: true };
    },
  });
  rawInputs.set(standIn, raw);
  return standIn;
}

/**
 * Build a positional parser that hands the command a lazily parsed value.
 *
 * @param kind - Shell completion kind for the positional
 * @param parse - Parses the raw input; may throw a `CliError`
 */
export function lazyPositional<T extends object>(
  kind: CompletionTarget,
  parse: (raw: string) => T,
): (input: string) => T {
  const parser = withCompletionTarget(kind, (input: string) =>
    lazyValue(input, parse),
  );
  lazyParsers.add(parser);
  return parser;
}

/** A Stricli positional definition — the subset that carries the parsers. */
type PositionalDef =
  | { kind: "tuple"; parameters: readonly { parse?: unknown }[] }
  | { kind: "array"; parameter: { parse?: unknown } };

/**
 * Run {@link lazyPositional} parsers on positionals that are still strings.
 *
 * Stricli already ran them; callers that skip its scanner (the SDK invoke
 * path, tests calling the loaded func) pass raw strings. Lazy parsers never
 * throw and have no side effects, so this is safe to run up front. Other
 * positionals are left as they are.
 */
export function applyLazyPositionals(
  args: unknown[],
  positional: unknown,
): unknown[] {
  const def = positional as PositionalDef | undefined;
  if (!def) {
    return args;
  }
  return args.map((arg, index) => {
    const parse =
      def.kind === "array" ? def.parameter.parse : def.parameters[index]?.parse;
    if (typeof arg !== "string" || typeof parse !== "function") {
      return arg;
    }
    return lazyParsers.has(parse)
      ? (parse as (input: string) => unknown)(arg)
      : arg;
  });
}

/**
 * What the user typed for a positional value. Never triggers a parse.
 *
 * @returns The raw input behind a lazily parsed value, otherwise `value`
 */
export function rawPositional(value: unknown): unknown {
  if (typeof value === "object" && value !== null) {
    return rawInputs.get(value) ?? value;
  }
  return value;
}
