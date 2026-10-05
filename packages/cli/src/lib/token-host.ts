/**
 * Host-Scoped Token Trust Model
 *
 * Tokens (env or stored OAuth) are bound to a specific Sentry host. The fetch
 * layer (and the `.sentryclirc` / URL-arg entry points) check each request's
 * destination against the token's recorded host and refuse to attach
 * credentials when they don't match — so untrusted routing inputs can't leak
 * credentials to an attacker's host.
 *
 * Host equivalence:
 * - Exact origin match (scheme + host + explicit port).
 * - SaaS equivalence class: a token scoped to `https://sentry.io` is valid for
 *   any `*.sentry.io` subdomain. Non-SaaS hosts match exactly — no subdomain
 *   suffix matching (a `sentry.acme.com` token does NOT match
 *   `sentry.acme.evil.com`).
 */

import { getRawEnvToken, getUsableStoredTokenHost } from "./db/auth.js";
import { isTrustedRegionOrigin } from "./db/regions.js";
import { getEnv } from "./env.js";
import { getEnvTokenHost } from "./env-token-host.js";
import { isSaaSTrustOrigin, normalizeOrigin } from "./sentry-urls.js";

/**
 * Check whether `candidate` matches `trusted` under the host-scoping trust
 * model. SaaS tokens accept any `*.sentry.io` subdomain (with strict
 * https + default port); non-SaaS hosts must match exact origin.
 *
 * Returns `false` when either argument fails to parse.
 */
export function isHostTrusted(
  candidate: string | URL | Request | undefined | null,
  trusted: string | undefined | null
): boolean {
  if (!trusted) {
    return false;
  }
  const candidateOrigin = normalizeOrigin(candidate);
  const trustedOrigin = normalizeOrigin(trusted);
  if (!(candidateOrigin && trustedOrigin)) {
    return false;
  }
  if (candidateOrigin === trustedOrigin) {
    return true;
  }
  // SaaS equivalence requires the strict check (https + default port) on
  // both sides — `http://sentry.io` or `:8443` must not inherit SaaS trust.
  return isSaaSTrustOrigin(trustedOrigin) && isSaaSTrustOrigin(candidateOrigin);
}

/**
 * Resolve the origin of the currently active Sentry token, if any.
 *
 * Mirrors {@link getAuthConfig}'s precedence: stored OAuth wins over env
 * token unless `SENTRY_FORCE_ENV_TOKEN` is set.
 */
export function getActiveTokenHost(): string | undefined {
  const hasEnvToken = !!getRawEnvToken();
  const forceEnv = hasEnvToken && !!getEnv().SENTRY_FORCE_ENV_TOKEN?.trim();

  if (!forceEnv) {
    const storedHost = getUsableStoredTokenHost();
    if (storedHost) {
      return storedHost;
    }
  }
  return hasEnvToken ? getEnvTokenHost() : undefined;
}

/**
 * Process-local login trust anchor — set by `applyLoginUrl` from `--url` or
 * the boot-time env snapshot. Used by {@link isRequestOriginTrustedForCustomHeaders}
 * during the no-token bootstrap window so OAuth device-flow requests against
 * IAP-protected self-hosted instances can carry `SENTRY_CUSTOM_HEADERS`.
 *
 * The shell argv / boot env is at the same trust boundary as `SENTRY_AUTH_TOKEN`
 * itself (per the plan's threat model), so this is safe. Crucially, the
 * `.sentryclirc` shim does NOT register an anchor — only explicit `--url` or
 * boot-time env values do.
 */
let loginTrustAnchor: string | undefined;

/** Register an explicit login-time trust anchor. URLs are normalized. */
export function registerLoginTrustAnchor(url: string): void {
  const origin = normalizeOrigin(url);
  if (origin) {
    loginTrustAnchor = origin;
  }
}

/**
 * Whether the current process's login trust anchor matches `host` under the
 * host-scoping trust model (exact origin or SaaS equivalence). The match
 * check is load-bearing: an existence-only check would let a stale anchor
 * from a prior `auth login --url <other-host>` (in library/test mode) admit
 * a login against a different host.
 */
export function isLoginTrustAnchorFor(host: string): boolean {
  return isHostTrusted(host, loginTrustAnchor);
}

/** @internal exported for testing */
export function resetLoginTrustAnchorForTesting(): void {
  loginTrustAnchor = undefined;
}

/**
 * Check whether a request's origin is trusted for a given anchor host,
 * including dynamically-discovered regional silos.
 */
function isOriginTrustedFor(
  requestInput: string | URL | Request | undefined | null,
  anchorHost: string
): boolean {
  if (isHostTrusted(requestInput, anchorHost)) {
    return true;
  }
  const requestOrigin = normalizeOrigin(requestInput);
  return requestOrigin !== undefined && isTrustedRegionOrigin(requestOrigin);
}

/**
 * Check whether a request's origin is trusted under the active token's scope.
 * Returns `true` when no token is active (nothing to protect).
 */
export function isRequestOriginTrusted(
  requestInput: string | URL | Request | undefined | null
): boolean {
  const tokenHost = getActiveTokenHost();
  if (!tokenHost) {
    return true;
  }
  return isOriginTrustedFor(requestInput, tokenHost);
}

/**
 * Like {@link isRequestOriginTrusted}, but anchored on the `sntrys_` claim
 * url instead of `getActiveTokenHost()`.
 */
export function isHostTrustedForClaim(
  requestInput: string | URL | Request | undefined | null,
  claimUrl: string
): boolean {
  return isOriginTrustedFor(requestInput, claimUrl);
}

/**
 * Trust check for `applyCustomHeaders` (IAP tokens, mTLS headers, etc.).
 *
 * Token present → same as {@link isRequestOriginTrusted}. No token but an
 * explicit login trust anchor → check against the anchor (allows OAuth
 * device-flow against IAP-protected self-hosted to carry custom headers).
 * No anchor at all → fail closed.
 */
export function isRequestOriginTrustedForCustomHeaders(
  requestInput: string | URL | Request | undefined | null
): boolean {
  if (getActiveTokenHost()) {
    return isRequestOriginTrusted(requestInput);
  }
  if (loginTrustAnchor) {
    return isHostTrusted(requestInput, loginTrustAnchor);
  }
  return false;
}
