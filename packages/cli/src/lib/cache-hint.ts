/**
 * Cache-age hint for command output.
 *
 * Reads the process-global cache-hit state from `response-cache.ts` and
 * formats a human-readable hint like "cached · 3m ago · use -f to refresh".
 * Applied automatically by `buildCommand` in `command.ts` — individual
 * commands don't need to call this themselves.
 *
 * The refresh flag named in the hint is derived from each command's own
 * parameters via {@link resolveRefreshFlag}, never hardcoded, so the hint
 * names `--fresh` when a command has no `-f` for it and drops the
 * suggestion when the command cannot bypass the cache at all.
 *
 * getsentry/cli#785 item #1 — `-f/--fresh` flag discoverability.
 *
 * @module
 */

import { getLastCacheHitAge } from "./response-cache.js";

/**
 * Format a millisecond duration as a compact human-readable string.
 *
 * - `< 5s` → `"just now"`
 * - `5s–59s` → `"Ns ago"`
 * - `1m–59m` → `"Nm ago"`
 * - `1h–23h` → `"Nh ago"`
 * - `≥ 24h` → `"Nd ago"`
 *
 * @internal Exported for testing
 */
export function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 5) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Resolve the shortest spelling of a command's `--fresh` flag.
 *
 * Returns `-<alias>` when an alias maps to `fresh`, `--fresh` when the flag
 * exists without an alias, and `undefined` when the command has no `fresh`
 * flag at all (so the hint must not suggest one).
 *
 * @param flags - The command's final flag definitions
 * @param aliases - The command's final alias map (short name → flag name)
 */
export function resolveRefreshFlag(
  flags: Readonly<Record<string, unknown>>,
  aliases: Readonly<Record<string, unknown>>,
): string | undefined {
  if (!("fresh" in flags)) {
    return;
  }
  for (const [short, target] of Object.entries(aliases)) {
    if (target === "fresh") {
      return `-${short}`;
    }
  }
  return "--fresh";
}

/**
 * Build a cache-age hint string, or `undefined` when the last request was
 * not served from cache.
 *
 * When multiple API calls run in parallel (e.g. `Promise.all`), the
 * displayed age corresponds to whichever resolves last — acceptable
 * since all hits share similar ages in practice.
 *
 * Example output: `"cached · 3m ago · use -f to refresh"`, or
 * `"cached · 3m ago"` when `refreshFlag` is omitted.
 *
 * @param refreshFlag - Flag that bypasses the cache for the running
 *   command, from {@link resolveRefreshFlag}
 */
export function formatCacheHint(refreshFlag?: string): string | undefined {
  const ageMs = getLastCacheHitAge();
  if (ageMs === undefined) {
    return;
  }
  const base = `cached · ${formatAge(ageMs)}`;
  return refreshFlag ? `${base} · use ${refreshFlag} to refresh` : base;
}

/**
 * Append a cache-age hint to an existing hint string.
 *
 * - Both present → `"existingHint | cached · 3m ago · ..."`
 * - Only cache hint → `"cached · 3m ago · ..."`
 * - Only existing → `"existingHint"` (unchanged)
 * - Neither → `undefined`
 *
 * @param existingHint - Hint returned by the command, if any
 * @param refreshFlag - Flag that bypasses the cache, see {@link formatCacheHint}
 */
export function appendCacheHint(
  existingHint: string | undefined,
  refreshFlag?: string,
): string | undefined {
  const cacheHint = formatCacheHint(refreshFlag);
  if (existingHint && cacheHint) {
    return `${existingHint} | ${cacheHint}`;
  }
  return cacheHint ?? existingHint;
}
