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

import { isSaaSTrustOrigin } from "@sentry/toolkit-core/sentry-origin";
import { normalizeAuthToken } from "./auth-header.js";
import {
  type CredentialContext,
  getActiveAuthHost,
  getCredentialContext,
  getIdentityFingerprint,
} from "./db/auth.js";
import { isTrustedRegionOrigin } from "./db/regions.js";
import { invocationState } from "./env.js";
import { HostScopeError } from "./errors.js";
import { normalizeHttpOrigin, normalizeOrigin } from "./sentry-urls.js";
import { parseSntrysClaim } from "./token-claims.js";

function normalizeTrustOrigin(
  input: string | URL | Request | undefined | null,
): string | undefined {
  const url =
    input instanceof URL
      ? input.href
      : input instanceof Request
        ? input.url
        : input;
  return normalizeHttpOrigin(url);
}

/**
 * Check whether `candidate` matches `trusted` under the host-scoping trust
 * model. SaaS tokens accept any `*.sentry.io` subdomain (with strict
 * https + default port); non-SaaS hosts must match exact origin.
 *
 * Returns `false` when either argument fails to parse.
 */
export function isHostTrusted(
  candidate: string | URL | Request | undefined | null,
  trusted: string | undefined | null,
): boolean {
  if (!trusted) {
    return false;
  }
  const candidateOrigin = normalizeTrustOrigin(candidate);
  const trustedOrigin = normalizeTrustOrigin(trusted);
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
  return getActiveAuthHost();
}

/**
 * Per-invocation login trust anchor — set by `applyLoginUrl` from `--url` or
 * the boot-time env snapshot. Used by {@link isRequestOriginTrustedForCustomHeaders}
 * during the no-token bootstrap window so OAuth device-flow requests against
 * IAP-protected self-hosted instances can carry `SENTRY_CUSTOM_HEADERS`.
 *
 * The shell argv / boot env is at the same trust boundary as `SENTRY_AUTH_TOKEN`
 * itself (per the plan's threat model), so this is safe. Crucially, the
 * `.sentryclirc` shim does NOT register an anchor — only explicit `--url` or
 * boot-time env values do.
 */
const loginTrustState = invocationState<{ anchor: string | undefined }>(() => ({
  anchor: undefined,
}));

/** Register an explicit login-time trust anchor. URLs are normalized. */
export function registerLoginTrustAnchor(url: string): void {
  const origin = normalizeHttpOrigin(url);
  if (origin) {
    loginTrustState().anchor = origin;
  }
}

/**
 * Whether the current invocation's login trust anchor matches `host` under the
 * host-scoping trust model (exact origin or SaaS equivalence). The match
 * check is load-bearing: an existence-only check would let a stale anchor
 * from a prior `auth login --url <other-host>` (in library/test mode) admit
 * a login against a different host.
 */
export function isLoginTrustAnchorFor(host: string): boolean {
  return isHostTrusted(host, loginTrustState().anchor);
}

/** @internal exported for testing */
export function resetLoginTrustAnchorForTesting(): void {
  loginTrustState().anchor = undefined;
}

/**
 * Check whether a request's origin is trusted for a given anchor host,
 * including dynamically-discovered regional silos.
 */
function isOriginTrustedFor(
  requestInput: string | URL | Request | undefined | null,
  anchorHost: string,
  identity: string,
): boolean {
  if (isHostTrusted(requestInput, anchorHost)) {
    return true;
  }
  const requestOrigin = normalizeTrustOrigin(requestInput);
  return (
    requestOrigin !== undefined &&
    isTrustedRegionOrigin(requestOrigin, anchorHost, identity)
  );
}

/**
 * Check whether a request's origin is trusted under the active token's scope.
 * Returns `true` when no token is active (nothing to protect).
 */
export function isRequestOriginTrusted(
  requestInput: string | URL | Request | undefined | null,
): boolean {
  const credential = getCredentialContext();
  if (!credential) {
    return true;
  }
  return isOriginTrustedFor(requestInput, credential.host, credential.identity);
}

/** Evaluate the host trust against the credential captured for this request. */
export function isRequestOriginTrustedForContext(
  requestInput: string | URL | Request | undefined | null,
  context: { host: string; identity: string },
): boolean {
  return isOriginTrustedFor(requestInput, context.host, context.identity);
}

/**
 * Refuse to send `credential` to `requestInput` unless it is scoped to that
 * host: the fetch layer's guard on every request, also applied where a
 * credential is handed to another client (`sentry mcp`). `source` names what
 * was refused in the error.
 *
 * Besides the credential's own host, an `sntrys_` token's claim must match
 * too — defense in depth for users with access to multiple Sentry
 * instances. The claim is unsigned (see token-claims.ts); fail-open on parse
 * errors. Multi-region fan-out via the control silo's region URLs still
 * works (see {@link isHostTrustedForClaim}).
 *
 * @throws {HostScopeError} When there is no credential, or it is scoped to
 *   another host
 */
export function assertCredentialScope(
  requestInput: string | URL | Request,
  credential:
    | Pick<CredentialContext, "host" | "identity" | "token">
    | undefined,
  source = "Credentials",
): void {
  const refuse = (scope: string | undefined) =>
    new HostScopeError(
      source,
      normalizeOrigin(requestInput) ?? "<unknown host>",
      scope,
    );
  if (
    !(credential && isRequestOriginTrustedForContext(requestInput, credential))
  ) {
    throw refuse(credential?.host);
  }
  const claimUrl = parseSntrysClaim(normalizeAuthToken(credential.token))?.url;
  if (
    claimUrl &&
    !isHostTrustedForClaim(requestInput, claimUrl, credential.identity)
  ) {
    throw refuse(claimUrl);
  }
}

/**
 * Like {@link isRequestOriginTrusted}, but anchored on the `sntrys_` claim
 * url instead of `getActiveTokenHost()`.
 */
export function isHostTrustedForClaim(
  requestInput: string | URL | Request | undefined | null,
  claimUrl: string,
  identity = getIdentityFingerprint(),
): boolean {
  return isOriginTrustedFor(requestInput, claimUrl, identity);
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
  requestInput: string | URL | Request | undefined | null,
): boolean {
  if (getActiveTokenHost()) {
    return isRequestOriginTrusted(requestInput);
  }
  const { anchor } = loginTrustState();
  if (anchor) {
    return isHostTrusted(requestInput, anchor);
  }
  return false;
}
