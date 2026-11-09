/**
 * Shared output utilities
 *
 * Handles the common pattern of JSON vs human-readable output
 * that appears in most CLI commands.
 *
 * Declare formatting in {@link OutputConfig} on `buildCommand`, then
 * yield data from the generator:
 * ```ts
 * buildCommand({
 *   output: { human: formatUser },
 *   async *func() { yield new CommandOutput(data); },
 * })
 * ```
 * The wrapper reads `json`/`fields` from flags and applies formatting
 * automatically. Generators return `{ hint }` for footer text.
 *
 * The same data object is serialized to JSON and passed to the human
 * formatter — there is no divergent-data path.
 */

import type { GenericSchema, InferOutput } from "valibot";
import type { Writer } from "../../types/index.js";
import { plainSafeMuted } from "./human.js";
import { filterFields, formatJson } from "./json.js";

// ---------------------------------------------------------------------------
// Zero-copy object capture (library mode)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Output config (declared on buildCommand)
// ---------------------------------------------------------------------------

/**
 * Stateful human renderer created once per command invocation.
 *
 * The wrapper calls `render()` once per yielded value and `finalize()`
 * once after the generator completes. This enables streaming commands
 * to maintain per-invocation rendering state (e.g., a table that needs
 * a header on first call and a footer on last).
 *
 * For stateless commands, `finalize` can be omitted — the wrapper falls
 * back to `writeFooter(hint)`.
 *
 * @typeParam T - The data type yielded by the command
 */
export type HumanRenderer<T> = {
  /** Render a single yielded data chunk as human-readable text. */
  render: (data: T) => string;
  /**
   * Called once after the generator completes. Returns the final output
   * string (e.g., a streaming table's bottom border + formatted hint).
   *
   * When defined, replaces the default `writeFooter(hint)` behavior —
   * the wrapper writes the returned string directly.
   *
   * When absent, the wrapper falls back to `writeFooter(hint)`.
   */
  finalize?: (hint?: string) => string;
};

/**
 * Resolve the `human` field of an {@link OutputConfig} into a
 * {@link HumanRenderer}. Supports two forms:
 *
 * 1. **Plain function** — `(data: T) => string` — auto-wrapped into a
 *    stateless renderer (no `finalize`).
 * 2. **Factory** — `() => HumanRenderer<T>` — called once per invocation
 *    to produce a renderer with optional `finalize()`.
 *
 * Disambiguation: a function with `.length === 0` is treated as a factory.
 */
export function resolveRenderer<T>(human: HumanOutput<T>): HumanRenderer<T> {
  // Factory: zero-arg function that returns a renderer
  if (human.length === 0) {
    return (human as () => HumanRenderer<T>)();
  }
  // Plain formatter: wrap in a stateless renderer
  return { render: human as (data: T) => string };
}

/**
 * Human rendering for an {@link OutputConfig}.
 *
 * Two forms:
 * - **Plain function** `(data: T) => string` — stateless, auto-wrapped.
 * - **Factory** `() => HumanRenderer<T>` — called per invocation for
 *   stateful renderers (e.g., streaming tables with `finalize()`).
 */
export type HumanOutput<T> = ((data: T) => string) | (() => HumanRenderer<T>);

/**
 * Keys `jsonExclude` can strip: the data's top-level keys, or each item's
 * keys when the data is an array (see `applyJsonExclude`). Distributes over
 * unions, so a key of any member counts.
 */
type JsonExcludeKey<T> = T extends readonly (infer Item)[]
  ? Item extends unknown
    ? keyof Item & string
    : never
  : keyof T & string;

/**
 * The JSON value `--fields` operates on: the data, or each item when the
 * data is an array.
 */
type JsonItem<T> = T extends readonly (infer Item)[] ? Item : T;

/**
 * Holds when the JSON data satisfies `S`, so every field the schema
 * documents exists on the data with a matching type. Otherwise it requires
 * a property no schema has, and the error shows the schema's output type.
 */
export type SchemaMatches<T, S extends GenericSchema> = [JsonItem<T>] extends [
  InferOutput<S>,
]
  ? unknown
  : { "~outputMismatch": InferOutput<S> };

/**
 * The value `--fields` operates on in a `jsonTransform` result: each item of
 * a `{ data: [...] }` envelope or an array, otherwise the result itself.
 * Distributes over unions, so every shape the transform returns counts.
 * `filterFields` on an array types its items as possibly `undefined`, so
 * `null` and `undefined` items are dropped.
 */
type TransformItem<R> = NonNullable<
  R extends { readonly data: readonly (infer Item)[] }
    ? Item
    : R extends readonly (infer Item)[]
      ? Item
      : R
>;

/**
 * Every key of `T` as a required, defined field. A transform's items are
 * `Partial` when `--fields` filters them, so the transform check compares
 * which fields exist and their types, not whether they are optional.
 */
type PresentFields<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };

/** Flattens `T` so errors print its fields instead of the alias. */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * The fields of `Schema` that `Data` lacks or types differently, with the
 * type the schema documents. Index signatures (loose objects) are skipped.
 */
type MismatchedFields<Data, Schema> = {
  [
    K in keyof Schema as string extends K
      ? never
      : number extends K
        ? never
        : K extends keyof Data
          ? [Data[K]] extends [Schema[K]]
            ? never
            : K
          : K
  ]: Schema[K];
};

/**
 * Holds when every field `S` documents exists on the transform's item with
 * a matching type. Otherwise it requires a property no schema has, and the
 * error lists the mismatched fields. A transform that returns `unknown`
 * never matches, so a transform with a schema must return a typed result.
 */
type TransformSchemaMatches<R, S extends GenericSchema> = [
  PresentFields<TransformItem<R>>,
] extends [PresentFields<InferOutput<S>>]
  ? unknown
  : {
      "~outputMismatch": Simplify<
        MismatchedFields<
          PresentFields<TransformItem<R>>,
          PresentFields<InferOutput<S>>
        >
      >;
    };

/** Fields shared by both forms of {@link OutputConfig}. */
type OutputConfigBase<T> = {
  /**
   * Human-readable renderer.
   *
   * Pass a plain `(data: T) => string` for stateless formatting, or a
   * zero-arg factory `() => HumanRenderer<T>` for stateful rendering
   * with `finalize()` support.
   */
  human: HumanOutput<T>;
  /**
   * Top-level keys to strip from JSON output.
   *
   * Use this for fields that exist only for the human formatter
   * (e.g. pre-formatted terminal strings) and should not appear
   * in the JSON contract.
   *
   * Ignored when {@link OutputConfig.jsonTransform} is set — the transform
   * is responsible for shaping the final JSON output.
   */
  jsonExclude?: ReadonlyArray<JsonExcludeKey<T>>;
};

/**
 * Output configuration declared on `buildCommand` for automatic rendering.
 *
 * When present, `--json` and `--fields` flags are injected and the wrapper
 * auto-renders yielded {@link CommandOutput} values.
 *
 * `schema` describes the JSON output: the build-time copy of a valibot
 * schema in `src/output-schemas/`, imported from
 * `src/generated/output-schemas/` (see {@link OutputSchemaFields}). Declare
 * the schema once and derive the command's output type from it; see
 * "Declaring Command Output" in `packages/cli/AGENTS.md`. It drives
 * `--help`, `sentry help <cmd>`, `--fields` completion, and the SKILL.md
 * field tables.
 *
 * Without `jsonTransform`, the data (each item for array data) must satisfy
 * `schema`, so a documented field the command doesn't produce is a compile
 * error. With `jsonTransform`, `schema` describes the transform's **item**
 * (what `--fields` operates on), and every field it documents must exist on
 * that item with a matching type (see {@link TransformItem}).
 *
 * @typeParam T - Type of data the command yields (used by `human` formatter
 *   and serialized as-is to JSON)
 * @typeParam S - The valibot schema `schema` was read from, inferred by the
 *   command builders
 * @typeParam R - Type `jsonTransform` returns, inferred by the builders
 */
export type OutputConfig<
  T,
  S extends GenericSchema = GenericSchema,
  R = unknown,
> = OutputConfigBase<T> &
  (
    | {
        jsonTransform?: undefined;
        schema?: OutputSchemaFields<S> & SchemaMatches<T, S>;
      }
    | {
        /**
         * Custom JSON serialization transform.
         *
         * When set, replaces the default JSON output path entirely.
         * The function receives the raw command data and the parsed
         * `--fields` list, and returns the final object to serialize.
         *
         * This is useful for list commands that wrap items in a
         * `{ data, hasMore, nextCursor }` envelope and need per-element
         * field filtering rather than top-level filtering.
         *
         * When `jsonTransform` is set, `jsonExclude` is ignored.
         */
        jsonTransform: (data: T, fields?: string[]) => R;
        schema?: OutputSchemaFields<S> & TransformSchemaMatches<R, S>;
      }
  );

/**
 * Yield type for commands with {@link OutputConfig}.
 *
 * Commands wrap each yielded value in this class so the `buildCommand`
 * wrapper can unambiguously detect data vs void/raw yields via `instanceof`.
 *
 * Hints are NOT carried on yielded values — they belong on the generator's
 * return value ({@link CommandReturn}) so the framework renders them once
 * after the generator completes.
 *
 * @typeParam T - The data type (matches the `OutputConfig<T>` type parameter)
 */
export class CommandOutput<T> {
  /** The data to render (serialized as-is to JSON, passed to `human` formatter) */
  readonly data: T;
  constructor(data: T) {
    this.data = data;
  }
}

/**
 * Yield token that tells the `buildCommand` wrapper to clear the terminal.
 *
 * On interactive terminals (TTY, non-plain), writes ANSI escape codes
 * to move the cursor home and clear the screen. On piped/plain output
 * or in JSON mode, the token is silently ignored.
 *
 * Use before re-yielding `CommandOutput` in refresh/polling loops
 * so the new output replaces the old in-place rather than appending.
 */
export class ClearScreen {
  /** Brand field for instanceof checks — never read, just exists. */
  readonly _brand = "ClearScreen" as const;
}

/**
 * Values a command generator may yield.
 *
 * `buildCommand` infers `T` from the command's {@link OutputConfig}, so a
 * yielded {@link CommandOutput} must match the type that `human`,
 * `jsonTransform`, and `jsonExclude` take. Commands without an output
 * config get `T = never` and may only yield {@link ClearScreen}.
 */
export type CommandYield<T> = CommandOutput<T> | ClearScreen;

/**
 * Return type for command generators.
 *
 * Carries metadata that applies to the entire command invocation — not to
 * individual yielded chunks. The `buildCommand` wrapper captures this from
 * the generator's return value (the `done: true` result of `.next()`).
 *
 * `hint` is shown in human mode and suppressed in JSON mode.
 */
export type CommandReturn = {
  /**
   * Hint line appended after all output (suppressed in JSON mode).
   *
   * When the renderer has a `finalize()` method, the hint is passed
   * to it — the renderer decides how to render it alongside any
   * cleanup output (e.g., table footer). Otherwise the wrapper writes
   * it via `writeFooter()`.
   */
  hint?: string;
};

/**
 * Rendering context passed to {@link renderCommandOutput}.
 * Contains the wrapper-injected flag values needed for output mode selection.
 */
type RenderContext = {
  /** Whether `--json` was passed */
  json: boolean;
  /** Pre-parsed `--fields` value */
  fields?: string[];
  /** ANSI prefix to prepend to the output (e.g., clear-screen escape) */
  clearPrefix?: string;
};

/**
 * Apply `jsonExclude` keys to data, stripping excluded fields from
 * objects or from each element of an array. Returns the data unchanged
 * when no exclusions are configured.
 */
function applyJsonExclude(
  data: unknown,
  excludeKeys: readonly string[] | undefined,
): unknown {
  if (!excludeKeys || excludeKeys.length === 0) {
    return data;
  }
  if (typeof data !== "object" || data === null) {
    return data;
  }
  if (Array.isArray(data)) {
    return data.map((item: unknown) => {
      if (typeof item !== "object" || item === null) {
        return item;
      }
      const copy = { ...item } as Record<string, unknown>;
      for (const key of excludeKeys) {
        delete copy[key];
      }
      return copy;
    });
  }
  const copy = { ...data } as Record<string, unknown>;
  for (const key of excludeKeys) {
    delete copy[key];
  }
  return copy;
}

/**
 * Write a final JSON object to stdout.
 *
 * When the writer supports zero-copy capture (library mode), the object
 * is handed off directly without serialization. Otherwise it is
 * JSON-stringified and written as a single line.
 */
function emitJsonObject(stdout: Writer, obj: unknown): void {
  if (stdout.captureObject) {
    stdout.captureObject(obj);
    return;
  }
  stdout.write(`${formatJson(obj)}\n`);
}

/**
 * Render a single yielded `CommandOutput<T>` chunk.
 *
 * Called by the `buildCommand` wrapper per yielded value. In JSON mode
 * the data is serialized (with optional field filtering / transform);
 * in human mode the resolved renderer's `render()` is called.
 *
 * Hints are NOT rendered here — the wrapper calls `finalize()` or
 * `writeFooter()` once after the generator completes.
 *
 * @param stdout - Writer to output to
 * @param data - The data yielded by the command
 * @param config - The output config declared on buildCommand
 * @param renderer - Per-invocation renderer (from `config.human()`)
 * @param ctx - Rendering context with flag values
 */
export function renderCommandOutput(
  stdout: Writer,
  data: unknown,
  // oxlint-disable-next-line typescript/no-explicit-any -- Variance erasure — config/renderer are paired at build time, but the framework iterates over unknown yields.
  config: OutputConfig<any>,
  // oxlint-disable-next-line typescript/no-explicit-any -- Renderer type mirrors erased OutputConfig<T>
  renderer: HumanRenderer<any>,
  ctx: RenderContext,
): void {
  // Binary bodies (Uint8Array) must bypass text formatters entirely — no
  // JSON pretty-print, no trailing newline, no string coercion. This is the
  // path `sentry api` uses for attachment downloads and other non-textual
  // Content-Types so redirected stdout stays byte-for-byte faithful.
  if (data instanceof Uint8Array) {
    stdout.write(data);
    return;
  }

  if (ctx.json) {
    if (config.jsonTransform) {
      const transformed = config.jsonTransform(data, ctx.fields);
      if (transformed === undefined) {
        return;
      }
      emitJsonObject(stdout, transformed);
      return;
    }

    const excluded = applyJsonExclude(data, config.jsonExclude);
    const final =
      ctx.fields && ctx.fields.length > 0
        ? filterFields(excluded, ctx.fields)
        : excluded;
    emitJsonObject(stdout, final);
    return;
  }

  const text = renderer.render(data);
  if (text) {
    const prefix = ctx.clearPrefix ?? "";
    stdout.write(`${prefix}${text}\n`);
  }
}

// ---------------------------------------------------------------------------
// Schema introspection
// ---------------------------------------------------------------------------

/**
 * Metadata of one top-level field of an output schema.
 *
 * Read from the valibot schema at build time (`script/lib/output-schema-fields.ts`)
 * and consumed by:
 * - `introspect.ts` → `CommandInfo.jsonFields`
 * - `help.ts` → human help output
 * - `generate-skill.ts` → SKILL.md field tables
 */
export type SchemaFieldInfo = {
  /** Field name (top-level key in the JSON object) */
  name: string;
  /** Human-readable type string (e.g. "string", "number", "object", "string | null") */
  type: string;
  /** Description from valibot's `description()` pipe action */
  description?: string;
  /** Whether the field is optional in the schema */
  optional: boolean;
};

/**
 * What the CLI needs at runtime from a command's output schema, read from it
 * at build time: its top-level fields and every `--fields` path.
 *
 * The schemas themselves live in `src/output-schemas/`, which only the build
 * loads. `script/generate-output-schemas.ts` writes one of these for each of
 * their exports to `src/generated/output-schemas/`, under the same name.
 *
 * @typeParam S - The valibot schema it was read from. Type only: commands
 *   derive their output type from it, and {@link OutputConfig} checks the
 *   command's data against it.
 */
export type OutputSchemaFields<S extends GenericSchema = GenericSchema> = {
  /** Top-level fields, for `--help`, `sentry help <cmd>` and the skill. */
  readonly fields: readonly SchemaFieldInfo[];
  /** Every field path in `--fields` dot notation, parents before children. */
  readonly paths: readonly string[];
  /** Never set; carries the schema's type. */
  readonly "~schema"?: S;
};

/** The valibot schema type an {@link OutputSchemaFields} was read from. */
export type SchemaOfFields<F> =
  F extends OutputSchemaFields<infer S> ? S : never;

/**
 * Format schema fields as a help text block for `--help` output.
 *
 * Produces a compact field list like:
 * ```
 * JSON fields (use --json --fields to select):
 *   id (string) — Numeric issue ID
 *   count (string, optional) — Total event count
 * ```
 */
export function formatSchemaForHelp(
  fields: readonly SchemaFieldInfo[],
): string {
  if (fields.length === 0) {
    return "";
  }
  const lines = ["JSON fields (use --json --fields to select):"];
  for (const field of fields) {
    const optStr = field.optional ? ", optional" : "";
    const desc = field.description ? ` — ${field.description}` : "";
    lines.push(`  ${field.name} (${field.type}${optStr})${desc}`);
  }
  return lines.join("\n");
}

/** Format footer text (muted in TTY, plain when piped, with surrounding newlines). */
export function formatFooter(text: string): string {
  return `\n${plainSafeMuted(text)}\n`;
}

/**
 * Write a formatted footer hint to stdout.
 * Adds empty line separator and applies muted styling.
 */
export function writeFooter(stdout: Writer, text: string): void {
  stdout.write(formatFooter(text));
}
