/**
 * OAuth Authentication
 *
 * Implements RFC 8628 Device Authorization Grant for Sentry OAuth.
 * https://datatracker.ietf.org/doc/html/rfc8628
 */

import { safeParse } from "valibot";
import type { TokenResponse } from "../types/index.js";
import {
  DeviceCodeResponseSchema,
  TokenErrorResponseSchema,
  TokenResponseSchema,
} from "../types/index.js";
import { SENTRY_SCOPES } from "./api-scope.js";
import { DEFAULT_SENTRY_URL, getConfiguredSentryUrl } from "./constants.js";
import {
  buildTlsErrorDetail,
  getCustomTlsOptions,
  isTlsCertError,
  warnIfSaasWithEnvCa,
} from "./custom-ca.js";
import { applyCustomHeaders } from "./custom-headers.js";
import { setAuthToken } from "./db/auth.js";
import { getEnv } from "./env.js";
import {
  ApiError,
  AuthError,
  DeviceFlowError,
  HostScopeError,
  ValidationError,
} from "./errors.js";
import { logger } from "./logger.js";
import { normalizeOrigin } from "./sentry-urls.js";
import { withHttpSpan } from "./telemetry.js";
import { getActiveTokenHost, isRequestOriginTrusted } from "./token-host.js";

/**
 * Get the Sentry instance URL for OAuth endpoints.
 *
 * Read lazily (not at module load) so that SENTRY_URL set after import
 * (e.g., from URL argument parsing for self-hosted instances) is respected
 * by the device flow and token refresh.
 */
function getSentryUrl(): string {
  return getConfiguredSentryUrl() ?? DEFAULT_SENTRY_URL;
}

/**
 * Public OAuth client ID for sentry.io.
 *
 * Device Authorization Grant (RFC 8628) is a public-client flow — no client
 * secret is involved, so this value is safe to commit. It is equivalent to the
 * `SENTRY_CLIENT_ID` repo variable used by CI.
 *
 * Self-hosted instances must override this via the `SENTRY_CLIENT_ID` env var
 * or the `SENTRY_CLIENT_ID_BUILD` build-time define.
 */
const DEFAULT_OAUTH_CLIENT_ID =
  "1d673b81d60ef84c951359c36296972ca6fd41bd8f45acd2d3a783a3b3c28e41";

/**
 * OAuth client ID
 *
 * Priority: SENTRY_CLIENT_ID env var → SENTRY_CLIENT_ID_BUILD (build-time) → committed default
 *
 * Read at call time (not module load time) so tests can override SENTRY_CLIENT_ID
 * after module initialization.
 *
 * @see script/build.ts
 */
declare const SENTRY_CLIENT_ID_BUILD: string | undefined;
function getClientId(): string {
  return (
    getEnv().SENTRY_CLIENT_ID ??
    (typeof SENTRY_CLIENT_ID_BUILD !== "undefined"
      ? SENTRY_CLIENT_ID_BUILD
      : DEFAULT_OAUTH_CLIENT_ID)
  );
}

/** OAuth scopes requested by the CLI. Exported for doc generation. */
export const OAUTH_SCOPES: readonly string[] = [
  "project:read",
  "project:write",
  "project:admin",
  "org:read",
  "event:read",
  "event:write",
  "member:read",
  "team:read",
  "team:write",
  "team:admin",
  "alerts:read",
  "alerts:write",
];

/** Space-joined scope string for OAuth requests (full default set). */
const SCOPES = OAUTH_SCOPES.join(" ");

/**
 * Read-only subset of {@link OAUTH_SCOPES}.
 *
 * Derived by keeping only scopes whose action is `:read`. This assumes every
 * read-granting scope the CLI requests carries the `:read` suffix — true for
 * the current list. If a future read-ish scope without that suffix is added to
 * `OAUTH_SCOPES` (e.g. `org:integrations`), update this filter explicitly.
 */
const OAUTH_SCOPES_READ_ONLY: readonly string[] = OAUTH_SCOPES.filter((scope) =>
  scope.endsWith(":read")
);

/** Lookup set of all canonical Sentry scopes for `--scope` validation. */
const KNOWN_SCOPE_SET = new Set<string>(SENTRY_SCOPES);

/**
 * Options for {@link resolveOAuthScopeString}. At most one of `readOnly` /
 * `scopes` should be set by callers; the command layer enforces mutual
 * exclusivity before calling this.
 */
export type OAuthScopeSelection = {
  /** Request only the read-only subset of {@link OAUTH_SCOPES}. */
  readOnly?: boolean;
  /** Explicit list of scopes to request. Validated against {@link SENTRY_SCOPES}. */
  scopes?: readonly string[];
};

/**
 * Resolve the space-joined OAuth scope string for a device-flow request.
 *
 * Precedence: explicit `scopes` → `readOnly` subset → full default
 * ({@link SCOPES}). Explicit scopes are validated against the canonical
 * {@link SENTRY_SCOPES} set and normalized to lowercase; duplicates are
 * collapsed while preserving first-seen order.
 *
 * @throws {ValidationError} when `scopes` is empty after normalization, or
 *   contains a value that is not a known Sentry scope.
 */
export function resolveOAuthScopeString(
  selection: OAuthScopeSelection = {}
): string {
  if (selection.scopes !== undefined) {
    return normalizeExplicitScopes(selection.scopes);
  }
  if (selection.readOnly) {
    return OAUTH_SCOPES_READ_ONLY.join(" ");
  }
  return SCOPES;
}

/**
 * Validate, lowercase, and de-duplicate an explicit scope list into a
 * space-joined string. Order of first appearance is preserved.
 */
function normalizeExplicitScopes(scopes: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of scopes) {
    const scope = raw.trim().toLowerCase();
    if (!scope) {
      continue;
    }
    if (!KNOWN_SCOPE_SET.has(scope)) {
      throw new ValidationError(
        `Invalid scope "${raw}". Must be one of: ${SENTRY_SCOPES.join(", ")}`,
        "scope"
      );
    }
    if (!seen.has(scope)) {
      seen.add(scope);
      out.push(scope);
    }
  }
  if (out.length === 0) {
    throw new ValidationError("No scopes provided to --scope", "scope");
  }
  return out.join(" ");
}

type DeviceFlowCallbacks = {
  onUserCode: (
    userCode: string,
    verificationUri: string,
    verificationUriComplete: string
  ) => void | Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap a fetch call with connection error handling.
 * Converts network errors into user-friendly ApiError messages.
 */
async function fetchWithConnectionError(
  url: string,
  init: RequestInit
): Promise<Response> {
  // Inject custom headers for self-hosted proxies (IAP, mTLS, etc.) —
  // URL-scoped so they don't leak to untrusted hosts.
  const merged = new Headers(init.headers);
  applyCustomHeaders(merged, url);
  const effectiveInit: RequestInit = { ...init, headers: merged };

  try {
    const customTls = getCustomTlsOptions();
    if (customTls) {
      warnIfSaasWithEnvCa(url);
    }

    return await fetch(url, { ...effectiveInit, ...customTls });
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    // TLS certificate errors — give actionable guidance
    if (isTlsCertError(error)) {
      throw new ApiError(
        `TLS certificate error connecting to ${getSentryUrl()}`,
        0,
        buildTlsErrorDetail(error)
      );
    }

    const isConnectionError =
      error.message.includes("ECONNREFUSED") ||
      error.message.includes("fetch failed") ||
      error.message.includes("network");

    if (isConnectionError) {
      throw new ApiError(
        `Cannot connect to Sentry at ${getSentryUrl()}`,
        0,
        "Check your network connection and SENTRY_URL configuration"
      );
    }
    throw error;
  }
}

/**
 * Refuse to POST a refresh token to a host that doesn't match the active
 * token's scope. Defense-in-depth for the rare case where SENTRY_HOST/URL
 * was mutated without going through the URL-arg / rc-shim guards.
 */
function assertRefreshHostTrusted(): void {
  const refreshUrl = getSentryUrl();
  if (!isRequestOriginTrusted(refreshUrl)) {
    throw new HostScopeError(
      "OAuth refresh token",
      normalizeOrigin(refreshUrl) ?? "<unknown host>",
      getActiveTokenHost()
    );
  }
}

/**
 * Request a device code from Sentry's device authorization endpoint.
 *
 * @param scope - Space-joined scope string to request. Defaults to the full
 *   {@link SCOPES} set. Use {@link resolveOAuthScopeString} to build it.
 */
function requestDeviceCode(scope: string = SCOPES) {
  const clientId = getClientId();
  return withHttpSpan("POST", "/oauth/device/code/", async () => {
    const response = await fetchWithConnectionError(
      `${getSentryUrl()}/oauth/device/code/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          scope,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new ApiError(
        "Failed to initiate device flow",
        response.status,
        errorText,
        "/oauth/device/code/"
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (parseError) {
      logger.debug("Non-JSON response from device code endpoint", parseError);
      throw new ApiError(
        "Invalid response from device authorization endpoint",
        response.status,
        "The server returned a non-JSON response body.",
        "/oauth/device/code/"
      );
    }

    const result = safeParse(DeviceCodeResponseSchema, data);
    if (!result.success) {
      throw new ApiError(
        "Invalid response from device authorization endpoint",
        response.status,
        result.issues.map((i) => i.message).join(", "),
        "/oauth/device/code/"
      );
    }

    return result.output;
  });
}

/**
 * Poll Sentry's token endpoint for the access token
 */
function pollForToken(deviceCode: string): Promise<TokenResponse> {
  return withHttpSpan("POST", "/oauth/token/", async () => {
    const response = await fetchWithConnectionError(
      `${getSentryUrl()}/oauth/token/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: getClientId(),
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      }
    );

    let data: unknown;
    try {
      data = await response.json();
    } catch (parseError) {
      logger.debug("Non-JSON response from token endpoint", parseError);
      throw new ApiError(
        "Unexpected response from token endpoint",
        response.status,
        "The server returned a non-JSON response body (possible proxy or CDN issue).",
        "/oauth/token/"
      );
    }

    // Try to parse as success response first
    const tokenResult = safeParse(TokenResponseSchema, data);
    if (tokenResult.success) {
      return tokenResult.output;
    }

    // Try to parse as error response
    const errorResult = safeParse(TokenErrorResponseSchema, data);
    if (errorResult.success) {
      throw new DeviceFlowError(
        errorResult.output.error,
        errorResult.output.error_description
      );
    }

    // If neither schema matches, throw a generic error
    throw new ApiError(
      "Unexpected response from token endpoint",
      response.status,
      JSON.stringify(data),
      "/oauth/token/"
    );
  });
}

type PollResult =
  | { status: "success"; token: TokenResponse }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "error"; message: string };

/**
 * Handle a single poll attempt, returning a result object
 */
async function attemptPoll(deviceCode: string): Promise<PollResult> {
  try {
    const token = await pollForToken(deviceCode);
    return { status: "success", token };
  } catch (error) {
    if (!(error instanceof DeviceFlowError)) {
      throw error;
    }

    switch (error.code) {
      case "authorization_pending":
        return { status: "pending" };
      case "slow_down":
        return { status: "slow_down" };
      case "expired_token":
        return {
          status: "error",
          message: "Device code expired. Please run 'sentry auth login' again.",
        };
      case "access_denied":
        return {
          status: "error",
          message: "Authorization was denied. Please try again.",
        };
      default:
        return { status: "error", message: error.message };
    }
  }
}

/**
 * Perform the Device Flow for OAuth authentication (RFC 8628).
 *
 * Initiates the device authorization flow by requesting a device code,
 * then polls for the access token until the user completes authorization.
 *
 * @param callbacks - Callbacks for UI updates during the flow
 * @param timeout - Maximum time to wait for authorization in ms (default: 10 minutes)
 * @param scope - Space-joined scope string to request. Defaults to the full
 *   {@link SCOPES} set. Build it via {@link resolveOAuthScopeString}.
 * @returns The token response containing access_token and metadata
 * @throws {ApiError} When unable to connect to Sentry or API returns an error
 * @throws {DeviceFlowError} When authorization fails, is denied, or times out
 */
export async function performDeviceFlow(
  callbacks: DeviceFlowCallbacks,
  timeout = 600_000, // 10 minutes default (matches Sentry's expires_in)
  scope: string = SCOPES
): Promise<TokenResponse> {
  // Step 1: Request device code
  const {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete,
    interval,
    expires_in,
  } = await requestDeviceCode(scope);

  // Notify caller of the user code
  await callbacks.onUserCode(
    user_code,
    verification_uri,
    verification_uri_complete ?? `${verification_uri}?user_code=${user_code}`
  );

  // Calculate absolute timeout
  const timeoutAt = Date.now() + Math.min(timeout, expires_in * 1000);

  // Track polling interval (may increase on slow_down)
  let pollInterval = interval;

  // Step 2: Poll for token
  while (Date.now() < timeoutAt) {
    await sleep(pollInterval * 1000);

    const result = await attemptPoll(device_code);

    switch (result.status) {
      case "success":
        return result.token;
      case "pending":
        continue;
      case "slow_down":
        pollInterval += 5;
        continue;
      case "error":
        throw new DeviceFlowError("authorization_failed", result.message);
      default:
        throw new DeviceFlowError("unexpected_error", "Unexpected poll result");
    }
  }

  throw new DeviceFlowError(
    "expired_token",
    "Authentication timed out. Please try again."
  );
}

/**
 * Complete the OAuth flow by storing the token in the database. The token
 * is scoped to {@link getSentryUrl} so the fetch-layer trust check refuses
 * to attach it to other hosts.
 *
 * @param tokenResponse - The token response from performDeviceFlow
 */
export async function completeOAuthFlow(
  tokenResponse: TokenResponse
): Promise<void> {
  await setAuthToken(
    tokenResponse.access_token,
    tokenResponse.expires_in,
    tokenResponse.refresh_token,
    { host: getSentryUrl() }
  );
}

/**
 * Store an API token directly (alternative to OAuth device flow).
 *
 * Use this for users who have an existing API token from Sentry settings.
 *
 * @param token - The API token to store
 */
export async function setApiToken(token: string): Promise<void> {
  await setAuthToken(token, undefined, undefined, { host: getSentryUrl() });
}

/** Refresh an access token using a refresh token. */
export function refreshAccessToken(
  refreshToken: string
): Promise<TokenResponse> {
  const clientId = getClientId();
  assertRefreshHostTrusted();

  return withHttpSpan("POST", "/oauth/token/", async () => {
    const response = await fetchWithConnectionError(
      `${getSentryUrl()}/oauth/token/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      }
    );

    if (!response.ok) {
      let errorDetail = "Token refresh failed";
      // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
      try {
        const errorData = await response.json();
        const errorResult = safeParse(TokenErrorResponseSchema, errorData);
        if (errorResult.success) {
          errorDetail =
            errorResult.output.error_description ?? errorResult.output.error;
        }
      } catch {
        // Ignore JSON parse errors
      }

      throw new AuthError(
        "expired",
        `Session expired: ${errorDetail}. Run 'sentry auth login' to re-authenticate.`
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (parseError) {
      logger.debug("Non-JSON response from token refresh endpoint", parseError);
      throw new ApiError(
        "Unexpected response from token refresh endpoint",
        response.status,
        "The server returned a non-JSON response body (possible proxy or CDN issue).",
        "/oauth/token/"
      );
    }

    const result = safeParse(TokenResponseSchema, data);

    if (!result.success) {
      throw new ApiError(
        "Invalid response from token refresh endpoint",
        response.status,
        result.issues.map((i) => i.message).join(", "),
        "/oauth/token/"
      );
    }

    return result.output;
  });
}
