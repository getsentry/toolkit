/**
 * Plain-output detection and ANSI stripping utilities.
 *
 * Extracted to its own module to avoid circular dependencies between
 * `markdown.ts` (which imports from `colors.ts`) and `colors.ts`
 * (which needs `isPlainOutput()` to gate terminal hyperlinks).
 *
 * ## Output mode resolution (highest → lowest priority)
 *
 * 1. `SENTRY_PLAIN_OUTPUT=1` → plain
 * 2. `SENTRY_PLAIN_OUTPUT=0` → rendered (force rich, even when piped)
 * 3. `NO_COLOR` (any non-empty value) → plain
 * 4. `FORCE_COLOR=0` → plain (only when stdout is a TTY)
 * 5. `FORCE_COLOR=1` on a TTY → rendered
 * 6. `!process.stdout.isTTY` → plain
 * 7. default (TTY, no overrides) → rendered
 */

import { getEnv } from "../env.js";

/**
 * Returns true if an env var value should be treated as "truthy" for
 * purposes of enabling/disabling output modes.
 *
 * Falsy values: `"0"`, `"false"`, `""` (case-insensitive).
 * Everything else (e.g. `"1"`, `"true"`, `"yes"`) is truthy.
 */
export function isTruthyEnv(val: string): boolean {
  const normalized = val.toLowerCase().trim();
  return normalized !== "0" && normalized !== "false" && normalized !== "";
}

/**
 * Determines whether output should be plain (no ANSI codes, no raw
 * markdown syntax).
 *
 * Evaluated fresh on each call so tests can flip env vars between assertions
 * and changes to `process.stdout.isTTY` are picked up immediately.
 *
 * Priority (highest first):
 * 1. `SENTRY_PLAIN_OUTPUT` — explicit project-specific override (custom
 *    semantics: `"0"` / `"false"` / `""` force color on)
 * 2. `NO_COLOR` — follows the no-color.org spec: any **non-empty** value
 *    disables color, regardless of its content (including `"0"` / `"false"`)
 * 3. `FORCE_COLOR` — follows chalk/supports-color convention, but only
 *    applies to interactive terminals. When stdout is piped, FORCE_COLOR
 *    is ignored so that `cmd | less` always produces clean output.
 *    Users who truly want color in pipes can use `SENTRY_PLAIN_OUTPUT=0`.
 * 4. `process.stdout.isTTY` — auto-detect interactive terminal
 */
export function isPlainOutput(): boolean {
  const plain = getEnv().SENTRY_PLAIN_OUTPUT;
  if (plain !== undefined) {
    return isTruthyEnv(plain);
  }

  // no-color.org spec: presence of a non-empty value disables color.
  // Unlike SENTRY_PLAIN_OUTPUT, "0" and "false" still mean "disable color".
  const noColor = getEnv().NO_COLOR;
  if (noColor !== undefined) {
    return noColor !== "";
  }

  // FORCE_COLOR only applies to interactive terminals. When stdout is
  // piped/redirected, FORCE_COLOR is ignored so that `cmd | less` always
  // produces clean output without ANSI codes.
  const forceColor = getEnv().FORCE_COLOR;
  if (process.stdout.isTTY && forceColor !== undefined && forceColor !== "") {
    return forceColor === "0";
  }

  return !process.stdout.isTTY;
}

export { stripAnsi } from "./strip-ansi.js";
