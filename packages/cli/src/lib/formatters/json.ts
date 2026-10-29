/**
 * JSON output utilities
 *
 * Provides formatting, field filtering, and streaming helpers for
 * `--json` output across all CLI commands.
 */

import { createRequire } from "node:module";
import type { Writer } from "../../types/index.js";

const _require = createRequire(import.meta.url);

/**
 * Get a nested value from an object using a dot-notated path.
 *
 * First checks for the path as a literal property name (e.g.,
 * `"gen_ai.usage.input_tokens"` as a flat key), then falls back to
 * dot-separated nested traversal (e.g., `"contexts.trace.traceId"`).
 * This ensures custom span attributes with dotted names are found.
 *
 * Returns `{ found: true, value }` when the path resolves, even if the
 * leaf value is `undefined` or `null`. Returns `{ found: false }` when
 * any intermediate segment is not an object (or is missing).
 *
 * @param obj - Source object to traverse
 * @param path - Key path: literal property name or dot-separated nesting
 */
export function getNestedValue(
  obj: unknown,
  path: string,
): { found: true; value: unknown } | { found: false } {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return { found: false };
  }

  // Fast path: literal property name (handles dotted keys like "gen_ai.usage.input_tokens")
  if (Object.hasOwn(obj, path)) {
    return { found: true, value: (obj as Record<string, unknown>)[path] };
  }

  // Fall back to dot-separated nested traversal
  let current: unknown = obj;
  for (const segment of path.split(".")) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return { found: false };
    }
    if (!Object.hasOwn(current, segment)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

type FieldProjection = { found: true; value: unknown } | { found: false };

const INDEXED_FIELD_PATTERN = /^(0|[1-9]\d*)(?:\.(.*))?$/;

/** Keep array positions without exposing unselected object properties. */
function emptyArrayItem(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(emptyArrayItem);
  }
  return value !== null && typeof value === "object" ? {} : null;
}

/**
 * Project nested arrays without turning numeric paths into object keys.
 * Named paths apply to every item; explicit indices retain their position.
 */
function projectArray(data: unknown[], fields: string[]): FieldProjection {
  const shared: string[] = [];
  const indexed = new Map<number, string[] | null>();
  for (const field of fields) {
    const match = INDEXED_FIELD_PATTERN.exec(field);
    if (!match) {
      shared.push(field);
      continue;
    }
    const index = Number(match[1]);
    if (index >= data.length) {
      continue;
    }
    const suffix = match[2];
    if (suffix === undefined) {
      indexed.set(index, null);
    } else if (indexed.get(index) !== null) {
      indexed.set(index, [...(indexed.get(index) ?? []), suffix]);
    }
  }

  if (shared.length === 0 && indexed.size === 0) {
    return { found: false };
  }
  return {
    found: true,
    value: data.map((item, index) => {
      const specific = indexed.get(index);
      if (specific === null) {
        return item;
      }
      const itemFields = [...shared, ...(specific ?? [])];
      const projection = projectFields(item, itemFields);
      return projection.found ? projection.value : emptyArrayItem(item);
    }),
  };
}

/**
 * Group selections by the actual source key before descending. Selecting a
 * whole property dominates its descendants, regardless of selector order.
 * Checking literal keys at every level preserves dotted attribute names.
 */
function groupObjectFields(
  data: object,
  fields: string[],
): Map<string, string[] | null> {
  const selections = new Map<string, string[] | null>();
  for (const field of fields) {
    if (Object.hasOwn(data, field)) {
      selections.set(field, null);
      continue;
    }
    const separator = field.indexOf(".");
    if (separator < 0) {
      continue;
    }
    const key = field.slice(0, separator);
    if (!Object.hasOwn(data, key) || selections.get(key) === null) {
      continue;
    }
    selections.set(key, [
      ...(selections.get(key) ?? []),
      field.slice(separator + 1),
    ]);
  }

  return selections;
}

/** Recursively project the selected source containers and literal keys. */
function projectFields(data: unknown, fields: string[]): FieldProjection {
  if (Array.isArray(data)) {
    return projectArray(data, fields);
  }
  if (data === null || typeof data !== "object") {
    return { found: false };
  }

  const selections = groupObjectFields(data, fields);
  const entries: [string, unknown][] = [];
  for (const [key, nestedFields] of selections) {
    const value = (data as Record<string, unknown>)[key];
    const projection =
      nestedFields === null
        ? { found: true, value }
        : projectFields(value, nestedFields);
    if (projection.found) {
      entries.push([key, projection.value]);
    }
  }
  return entries.length > 0
    ? { found: true, value: Object.fromEntries(entries) }
    : { found: false };
}

/**
 * Filter an object (or array of objects) to include only the specified fields.
 *
 * Supports dot-notation for nested field access, including array elements:
 * ```ts
 * filterFields({ spans: [{ data: { "http.method": "GET" } }] }, [
 *   "spans.data.http.method",
 * ])
 * // → { spans: [{ data: { "http.method": "GET" } }] }
 * ```
 *
 * Literal keys take precedence over dot-separated paths at each level.
 * Nested arrays keep their order and shape; absent object fields yield `{}`
 * at their original position. Numeric paths select an explicit array index.
 * When `data` itself is an array, each element is filtered independently.
 * Missing fields are skipped and the original data is never mutated.
 *
 * @param data - Source data to filter
 * @param fields - Field paths to include (dot-separated for nesting)
 * @returns Filtered copy of the data
 */
export function filterFields<T>(data: T, fields: string[]): Partial<T> {
  if (Array.isArray(data)) {
    return data.map((item) =>
      filterFields(item, fields),
    ) as unknown as Partial<T>;
  }
  if (data === null || data === undefined || typeof data !== "object") {
    return data as Partial<T>;
  }
  const projection = projectFields(data, fields);
  return (projection.found ? projection.value : {}) as Partial<T>;
}

/**
 * Parse a comma-separated fields string into a trimmed, deduplicated array.
 *
 * Handles whitespace around commas and filters out empty segments:
 * ```ts
 * parseFieldsList("id, title , status")              // → ["id", "title", "status"]
 * parseFieldsList("id,,title")                       // → ["id", "title"]
 * parseFieldsList("id,tags[cart.total,number]")      // → ["id", "tags[cart.total,number]"]
 * ```
 *
 * @param input - Raw `--fields` flag value
 * @returns Parsed field path list (may be empty if input is all whitespace/commas)
 */
export function parseFieldsList(input: string): string[] {
  // The local viewer imports other helpers here before CLI artifacts are built.
  // Load the generated parser only when a command actually parses --fields.
  const { parse } = _require(
    "../../generated/field-list-grammar.js",
  ) as typeof import("../../generated/field-list-grammar.js");
  return Array.from(new Set(parse(input)));
}

/**
 * Format data as pretty-printed JSON
 */
export function formatJson<T>(data: T): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Output JSON to a write stream.
 *
 * When `fields` is provided, the output is filtered to include only
 * the specified field paths before serialization. This supports the
 * `--fields` flag for reducing token consumption in agent workflows.
 *
 * @param stream - Output writer (typically stdout)
 * @param data - Data to serialize
 * @param fields - Optional field paths to include (dot-notation supported)
 */
export function writeJson<T>(stream: Writer, data: T, fields?: string[]): void {
  const output =
    fields && fields.length > 0 ? filterFields(data, fields) : data;
  stream.write(`${formatJson(output)}\n`);
}

/**
 * Output a paginated list as JSON with metadata wrapper.
 *
 * Wraps an array of items in a `{ data, hasMore, nextCursor? }` envelope.
 * When `fields` is provided, filtering is applied to each **array element**
 * inside `data`, not to the wrapper itself. This ensures that
 * `--fields id,title` filters each item, while metadata keys (`hasMore`,
 * `nextCursor`) are always preserved.
 *
 * @param stream - Output writer (typically stdout)
 * @param items - Array of items to wrap in `data`
 * @param options - Pagination metadata and optional field filtering
 *
 * @example
 * ```ts
 * // Without fields: full output
 * writeJsonList(stdout, issues, { hasMore: true, nextCursor: "abc" });
 * // → { "data": [...], "nextCursor": "abc", "hasMore": true }
 *
 * // With fields: each item filtered, wrapper preserved
 * writeJsonList(stdout, issues, { hasMore: true, fields: ["id", "title"] });
 * // → { "data": [{ "id": "1", "title": "Bug" }, ...], "hasMore": true }
 * ```
 */
export function writeJsonList<T>(
  stream: Writer,
  items: T[],
  options: {
    hasMore: boolean;
    nextCursor?: string | null;
    errors?: unknown[];
    fields?: string[];
    /** Arbitrary extra metadata to include in the wrapper (e.g. `{ hint }`) */
    extra?: Record<string, unknown>;
  },
): void {
  const { hasMore, nextCursor, errors, fields, extra } = options;
  const filtered =
    fields && fields.length > 0
      ? items.map((item) => filterFields(item, fields))
      : items;

  const output: Record<string, unknown> = { data: filtered, hasMore };
  if (nextCursor !== null && nextCursor !== undefined && nextCursor !== "") {
    output.nextCursor = nextCursor;
  }
  if (errors && errors.length > 0) {
    output.errors = errors;
  }
  if (extra) {
    Object.assign(output, extra);
  }

  stream.write(`${formatJson(output)}\n`);
}
