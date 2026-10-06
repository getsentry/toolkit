/**
 * Safe JSON parsing for values read from the SQLite cache layer.
 *
 * Cached JSON columns can be corrupted by partial writes, manual DB edits, or
 * incompatible schema migrations. A bare `JSON.parse` on such data throws a
 * `SyntaxError` that crashes whatever command triggered the cache read. This
 * module centralizes the defensive parse so every cache reader treats
 * corruption as a cache miss instead of a fatal error.
 */

import { logger } from "../logger.js";

const log = logger.withTag("db-json");

/**
 * Parse a JSON string read from the cache, returning `undefined` on failure.
 *
 * Failure modes handled:
 * - `raw` is `null`/`undefined` (column was never written) → `undefined`.
 * - `JSON.parse` throws (corrupt JSON) → logged at debug level → `undefined`.
 * - An optional `validate` predicate rejects the parsed shape → `undefined`.
 *
 * Callers should treat `undefined` as a cache miss and recompute the value.
 *
 * @typeParam T - Expected shape of the parsed value.
 * @param raw - Raw JSON string from a SQLite column (may be null/undefined).
 * @param validate - Optional type guard run against the parsed value; when it
 *   returns `false` the result is discarded and `undefined` is returned.
 * @returns The parsed value, or `undefined` if parsing/validation failed.
 */
export function safeParseJson<T>(
  raw: string | null | undefined,
  validate?: (value: unknown) => value is T
): T | undefined {
  if (raw === null || raw === undefined) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log.debug("Failed to parse cached JSON; treating as cache miss", error);
    return;
  }

  if (validate && !validate(parsed)) {
    log.debug("Cached JSON failed validation; treating as cache miss");
    return;
  }

  return parsed as T;
}
