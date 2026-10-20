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

import { DEFAULT_SENTRY_URL, normalizeUrl } from "./constants.js";
import { getRawEnvToken } from "./db/auth.js";
import { getEnv } from "./env.js";
import { ConfigError } from "./errors.js";
import { parseSntrysClaim } from "./token-claims.js";

type HostSnapshot = {
  host: string;
  configuredHost: string | null;
  claimError?: ConfigError;
};
const EXPLICIT_SCHEME_RE = /^([a-z][a-z\d+.-]*):\/\//i;

function normalizeHost(
  input: string | undefined,
  source: string,
): string | undefined {
  if (!input) {
    return;
  }
  const scheme = input.trim().match(EXPLICIT_SCHEME_RE)?.[1]?.toLowerCase();
  try {
    if (scheme && scheme !== "http" && scheme !== "https") {
      throw new TypeError("Unsupported URL scheme");
    }
    const parsed = new URL(normalizeUrl(input) as string);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      throw new TypeError("Invalid URL");
    }
    return parsed.origin;
  } catch {
    throw new ConfigError(`${source} must be a credential-free HTTP(S) URL.`);
  }
}

function captureClaimHost(token: string | undefined): {
  host?: string;
  error?: ConfigError;
} {
  if (!token?.startsWith("sntrys_")) {
    return {};
  }
  const claim = parseSntrysClaim(token);
  if (!claim) {
    // Opaque tokens, including legacy sntrys_ strings without a usable claim,
    // still use the configured URL or SaaS. No claimed host was trusted.
    return {};
  }
  try {
    return { host: normalizeHost(claim.url, "The active token URL claim") };
  } catch (error) {
    if (error instanceof ConfigError) {
      return { error };
    }
    throw error;
  }
}

const snapshotState = {
  byEnv: new WeakMap<NodeJS.ProcessEnv, HostSnapshot>(),
};

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
  const env = getEnv();
  if (snapshotState.byEnv.has(env)) {
    return;
  }
  const configuredHost =
    normalizeHost(
      env.SENTRY_HOST?.trim() || env.SENTRY_URL?.trim(),
      env.SENTRY_HOST?.trim() ? "SENTRY_HOST" : "SENTRY_URL",
    ) ?? null;
  // Claim first: for sntrys_ tokens, the embedded url is authoritative.
  const claim = captureClaimHost(getRawEnvToken());
  snapshotState.byEnv.set(env, {
    configuredHost,
    host: claim.host ?? configuredHost ?? DEFAULT_SENTRY_URL,
    ...(claim.error ? { claimError: claim.error } : {}),
  });
}

/**
 * Return the pinned env-token host, auto-capturing on first call. The
 * standard boot path calls `captureEnvTokenHost()` explicitly; this
 * auto-capture covers library-mode callers that bypass the boot.
 */
export function getEnvTokenHost(): string {
  const env = getEnv();
  if (!snapshotState.byEnv.has(env)) {
    captureEnvTokenHost();
  }
  const snapshot = snapshotState.byEnv.get(env);
  if (snapshot?.claimError) {
    throw snapshot.claimError;
  }
  return snapshot?.host ?? DEFAULT_SENTRY_URL;
}

/** Only the explicit URL captured at boot may migrate a legacy stored login. */
export function getBootConfiguredSentryUrl(): string | undefined {
  const env = getEnv();
  if (!snapshotState.byEnv.has(env)) {
    captureEnvTokenHost();
  }
  return snapshotState.byEnv.get(env)?.configuredHost ?? undefined;
}

/** @internal */
export function resetEnvTokenHostForTesting(): void {
  snapshotState.byEnv = new WeakMap<NodeJS.ProcessEnv, HostSnapshot>();
}
