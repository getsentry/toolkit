/**
 * Background Org Detection Prefetch
 *
 * Provides a warm/consume pattern for org resolution during `sentry init`.
 * Call {@link warmOrgDetection} early (before the preamble) to start DSN
 * scanning in the background.  Later, call {@link resolveOrgPrefetched} —
 * it returns the cached result instantly if the background work has
 * finished, or falls back to a live call if it hasn't been warmed.
 *
 * `listOrganizations()` does NOT need prefetching because it has its own
 * SQLite cache layer (PR #446).  After `sentry login`, the org cache is
 * pre-populated (PR #490), so subsequent calls return from cache instantly
 * without any HTTP requests.  Only `resolveOrg()` (DSN scanning) benefits
 * from background prefetching since it performs filesystem I/O.
 *
 * This keeps init preflight free of explicit promise-threading — callers
 * just swap in the prefetch-aware functions.
 */

import type { ResolvedOrg } from "../resolve-target.js";
import { resolveOrg } from "../resolve-target.js";

type OrgResult = ResolvedOrg | null;

let orgPromise: Promise<OrgResult> | undefined;
let warmedCwd: string | undefined;

/**
 * Kick off background DSN scanning + env var / config checks.
 *
 * Safe to call multiple times — subsequent calls are no-ops.
 * Errors are silently swallowed so the foreground path can retry.
 */
export function warmOrgDetection(cwd: string): void {
  if (!orgPromise) {
    warmedCwd = cwd;
    orgPromise = resolveOrg({ cwd }).catch(() => null);
  }
}

/**
 * Resolve the org, using the prefetched result if available.
 *
 * Returns the cached background result only when `cwd` matches the
 * directory that was passed to {@link warmOrgDetection}.  If `cwd`
 * differs (or warming was never called), falls back to a live
 * `resolveOrg()` call so callers always get results for the correct
 * working directory.
 */
export function resolveOrgPrefetched(cwd: string): Promise<OrgResult> {
  if (orgPromise && cwd === warmedCwd) {
    return orgPromise;
  }
  return resolveOrg({ cwd }).catch(() => null);
}

/**
 * Reset prefetch state.  Used by tests to prevent cross-test leakage.
 */
export function resetPrefetch(): void {
  orgPromise = undefined;
  warmedCwd = undefined;
}
