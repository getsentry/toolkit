/**
 * Env-Token Host Snapshot
 *
 * Captures the host an env-var auth token (`SENTRY_AUTH_TOKEN` /
 * `SENTRY_TOKEN`) is scoped to, BEFORE any post-boot code path can mutate
 * `env.SENTRY_HOST`/`env.SENTRY_URL` (specifically before
 * `applySentryCliRcEnvShim` writes from a `.sentryclirc` file).
 *
 * Trust model for the snapshot source:
 *
 * - `SENTRY_HOST`/`SENTRY_URL` from env are NOT unconditionally trusted.
 *   In layered CI environments (e.g. GitHub Actions `$GITHUB_ENV`), a
 *   low-privilege step can write env vars that a later high-privilege step
 *   inherits — without having read access to `SENTRY_AUTH_TOKEN`. So
 *   env-host and env-token may have different integrity levels.
 *
 * - For `sntrys_` org-auth tokens, the embedded `url` claim is the
 *   authoritative source: the real Sentry server wrote it at issuance
 *   time, and it can't be overridden by env injection. The claim wins
 *   over env when both are present.
 *
 * - For non-`sntrys_` tokens (no claim), env is the only signal
 *   available. The residual risk in layered-CI is documented in the PR
 *   description as a workflow-design concern; recommendation is to use
 *   `sntrys_` tokens in CI.
 *
 * - `.sentryclirc` files are never consulted here — they have weaker
 *   integrity than either env or token claims.
 *
 * Boot ordering (see `src/cli.ts::preloadProjectContext`):
 *   1. captureEnvTokenHost()      ← this module, env + claim, synchronous
 *   2. findProjectRoot            ← populates .sentryclirc cache
 *   3. applySentryCliRcEnvShim    ← may write env.SENTRY_URL
 *   4. getDefaultUrl() fallback   ← may write env.SENTRY_URL
 */

import { DEFAULT_SENTRY_URL } from "./constants.js";
import { getRawEnvToken } from "./db/auth.js";
import { getEnv } from "./env.js";
import { normalizeUserInputToOrigin } from "./sentry-urls.js";
import { parseSntrysClaim } from "./token-claims.js";

/** Pinned host. `undefined` means not yet captured. */
let pinnedHost: string | undefined;

/**
 * Snapshot the env-token's scoping host. Idempotent — second and subsequent
 * calls are no-ops.
 *
 * Resolution order:
 * 1. `sntrys_` token claim's `url` — authoritative for org-auth tokens.
 *    Immune to env injection because the claim is embedded in the token
 *    bytes (which the attacker can't read in layered-CI attacks).
 * 2. `SENTRY_HOST`/`SENTRY_URL` from env — fallback for non-`sntrys_`
 *    tokens that don't carry a claim.
 * 3. `DEFAULT_SENTRY_URL` (SaaS).
 */
export function captureEnvTokenHost(): void {
  if (pinnedHost !== undefined) {
    return;
  }
  // Claim first: for sntrys_ tokens, the embedded url is authoritative.
  const claimHost = normalizeUserInputToOrigin(
    parseSntrysClaim(getRawEnvToken())?.url
  );
  if (claimHost) {
    pinnedHost = claimHost;
    return;
  }
  // Env fallback: for non-sntrys_ tokens (no claim available).
  const env = getEnv();
  const envHost = normalizeUserInputToOrigin(
    env.SENTRY_HOST?.trim() || env.SENTRY_URL?.trim()
  );
  pinnedHost = envHost ?? DEFAULT_SENTRY_URL;
}

/**
 * Return the pinned env-token host, auto-capturing on first call. The
 * standard boot path calls `captureEnvTokenHost()` explicitly; this
 * auto-capture covers library-mode callers that bypass the boot.
 */
export function getEnvTokenHost(): string {
  if (pinnedHost === undefined) {
    captureEnvTokenHost();
  }
  return pinnedHost ?? DEFAULT_SENTRY_URL;
}

/** @internal */
export function resetEnvTokenHostForTesting(): void {
  pinnedHost = undefined;
}
