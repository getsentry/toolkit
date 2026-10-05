/**
 * Cache-age hint for command output.
 *
 * Reads the process-global cache-hit state from `response-cache.ts` and
 * formats a human-readable hint like "cached · 3m ago · use -f to refresh".
 * Applied automatically by `buildCommand` in `command.ts` — individual
 * commands don't need to call this themselves.
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
 * Build a cache-age hint string, or `undefined` when the last request was
 * not served from cache.
 *
 * When multiple API calls run in parallel (e.g. `Promise.all`), the
 * displayed age corresponds to whichever resolves last — acceptable
 * since all hits share similar ages in practice.
 *
 * Example output: `"cached · 3m ago · use -f to refresh"`
 */
export function formatCacheHint(): string | undefined {
  const ageMs = getLastCacheHitAge();
  if (ageMs === undefined) {
    return;
  }
  return `cached · ${formatAge(ageMs)} · use -f to refresh`;
}

/**
 * Append a cache-age hint to an existing hint string.
 *
 * - Both present → `"existingHint | cached · 3m ago · ..."`
 * - Only cache hint → `"cached · 3m ago · ..."`
 * - Only existing → `"existingHint"` (unchanged)
 * - Neither → `undefined`
 */
export function appendCacheHint(
  existingHint: string | undefined
): string | undefined {
  const cacheHint = formatCacheHint();
  if (existingHint && cacheHint) {
    return `${existingHint} | ${cacheHint}`;
  }
  return cacheHint ?? existingHint;
}
