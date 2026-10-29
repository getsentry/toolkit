/**
 * Sentry API Client Configuration
 *
 * Provides request configuration for @sentry/api SDK functions,
 * including authentication, retry logic, timeout, and multi-region support.
 *
 * Authentication and routing configuration remain per request. The SDK client
 * and its parsing hooks are configured separately in sentry-sdk-client.ts.
 */

import type { SentryClient } from "@sentry/api";
import { getTraceData } from "@sentry/node";
import type { RetryPolicy } from "@sentry/toolkit-core/api-retry";
import {
  createApiTransport,
  extractUrlPath,
  getValidatedResponseSource,
  type ResponseBodyMode,
  type TransportCache,
} from "@sentry/toolkit-core/api-transport";
import { computeInvalidationPrefixes } from "@sentry/toolkit-core/response-cache";
import { formatAuthHeader, normalizeAuthToken } from "./auth-header.js";
import { seedCompletions } from "./api/completion-seed.js";
import { maybeWarnEnvTokenIgnored } from "./auth-hint.js";
import {
  DEFAULT_SENTRY_URL,
  getConfiguredSentryUrl,
  getUserAgent,
} from "./constants.js";
import {
  buildTlsErrorDetail,
  getCustomTlsOptions,
  isTlsCertError,
  warnIfSaasWithEnvCa,
} from "./custom-ca.js";
import { applyCustomHeaders } from "./custom-headers.js";
import {
  type CredentialContext,
  getCredentialContext,
  getRemainingLifetimeRatio,
  REFRESH_THRESHOLD,
  refreshToken,
} from "./db/auth.js";
import {
  ApiError,
  HostScopeError,
  MalformedAuthTokenError,
  RateLimitError,
  TimeoutError,
} from "./errors.js";
import { extractInputUrl } from "./fetch-input.js";
import { isIdempotentOperation } from "./idempotent-operations.js";
import { logger } from "./logger.js";
import {
  clearLastCacheHitAge,
  invalidateCachedResponsesMatching,
  lookupCachedResponse,
  storeCachedResponse,
} from "./response-cache.js";
import { normalizeOrigin } from "./sentry-urls.js";
import { isManualHttpTracing, withTracingSpan } from "./telemetry.js";
import { parseSntrysClaim } from "./token-claims.js";
import {
  isHostTrustedForClaim,
  isRequestOriginTrustedForContext,
} from "./token-host.js";

const log = logger.withTag("http");

/** Default request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Per-endpoint timeout overrides, matched against the request URL's
 * pathname (first match wins, otherwise {@link REQUEST_TIMEOUT_MS}).
 */
type TimeoutOverride = {
  pattern: RegExp;
  timeoutMs: number;
};

const ENDPOINT_TIMEOUT_OVERRIDES: TimeoutOverride[] = [
  // Seer autofix POSTs trigger server-side root-cause analysis /
  // solution planning and can take up to ~2 minutes (see CLI-1D6).
  { pattern: /\/autofix\/?(?:\?|$)/, timeoutMs: 120_000 },
];

/**
 * Caps for automatic retries. Which statuses and methods retry is the shared
 * rule in `@sentry/toolkit-core/api-retry`.
 *
 * `maxDelayMs` caps the jittered backoff and the server-requested wait
 * (`Retry-After`, rate-limit reset); a longer server-requested wait is not
 * retried, so it surfaces instead of hanging. Sentry's API rate-limit windows
 * are usually one second, so honored waits are typically short. The per-wait
 * cap binds first; the total only bounds the worst case.
 */
const RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 1000,
  maxDelayMs: 10_000,
  maxTotalDelayMs: 30_000,
};

/** Header to mark requests as retries, preventing infinite token refresh loops */
const RETRY_MARKER_HEADER = "x-sentry-cli-retry";

const sdkResponseBodyModes = new WeakMap<Request, ResponseBodyMode>();

/**
 * Preserve the SDK's parsing intent before it calls fetch(Request), which
 * otherwise loses parseAs. Register once on each SDK client using this transport.
 */
export function registerSdkResponseBodyMode(
  client: SentryClient["client"],
): void {
  client.interceptors.request.use((request, options) => {
    const parseAs = options.parseAs;
    sdkResponseBodyModes.set(
      request,
      parseAs === "auto" || parseAs === "stream" ? parseAs : "buffer",
    );
    return request;
  });
}

/** Provenance attached only after manually validated discovery requests. */
export function getResponseRequestOrigin(
  response: Response,
): string | undefined {
  return getValidatedResponseSource(response)?.origin;
}

export function getResponseCredentialIdentity(
  response: Response,
): string | undefined {
  return getValidatedResponseSource(response)?.identity;
}

/**
 * Reject requests whose host the credential is not scoped to, then add the
 * CLI's headers. The transport sets Authorization and User-Agent afterwards.
 *
 * Only sets tracing and custom headers. Content-Type is intentionally NOT set
 * here — callers are responsible for setting it based on their needs:
 * - SDK functions set their own Content-Type
 * - apiRequestToRegion always sends JSON and sets it explicitly
 * - rawApiRequest may or may not want Content-Type (e.g., string bodies)
 */
function prepareHeaders(
  headers: Headers,
  {
    input,
    credential,
  }: { input: Request | string | URL; credential: CredentialContext },
): void {
  // Host-scoping guard (defense in depth). Primary rejection happens at the
  // URL-arg / rc-shim entry points; this catches any code path that mutated
  // SENTRY_HOST/SENTRY_URL without going through those guards.
  if (!isRequestOriginTrustedForContext(input, credential)) {
    throw new HostScopeError(
      "Credentials",
      normalizeOrigin(input) ?? "<unknown host>",
      credential.host,
    );
  }

  // sntrys_ claim check — defense-in-depth for users with access to
  // multiple Sentry instances. The claim is unsigned (see token-claims.ts);
  // fail-open on parse errors. Uses isHostTrustedForClaim so multi-region
  // fan-out via the control silo's region URLs still works.
  const claimUrl = parseSntrysClaim(normalizeAuthToken(credential.token))?.url;
  if (
    claimUrl &&
    !isHostTrustedForClaim(input, claimUrl, credential.identity)
  ) {
    throw new HostScopeError(
      "Credentials",
      normalizeOrigin(input) ?? "<unknown host>",
      claimUrl,
    );
  }

  if (isManualHttpTracing()) {
    const traceData = getTraceData();
    if (traceData["sentry-trace"]) {
      headers.set("sentry-trace", traceData["sentry-trace"]);
    }
    if (traceData.baggage) {
      headers.set("baggage", traceData.baggage);
    }
  }

  // Inject user-configured custom headers for self-hosted proxies (IAP,
  // mTLS, etc.) — scoped to the request URL.
  applyCustomHeaders(
    headers,
    input,
    isRequestOriginTrustedForContext(input, credential),
  );
}

/** Refresh ahead of expiry, once the token has used most of its lifetime. */
async function prepareCredential(
  credential: CredentialContext,
): Promise<CredentialContext> {
  const shouldRefresh = Boolean(
    credential.refreshable &&
    credential.expiresAt &&
    getRemainingLifetimeRatio(
      credential.expiresAt,
      credential.issuedAt,
      Date.now(),
    ) <= REFRESH_THRESHOLD,
  );
  if (!shouldRefresh) {
    return credential;
  }
  const refreshed = await refreshToken({ expectedCredential: credential });
  return Object.freeze({ ...credential, token: refreshed.token });
}

/**
 * Refresh the token after a 401.
 * @returns the refreshed credential, or undefined to return the 401
 */
async function refreshAfterUnauthorized(
  credential: CredentialContext,
): Promise<CredentialContext | undefined> {
  // refreshToken handles the token selection: it refreshes OAuth when OAuth is
  // the effective auth source, or returns the env token without refresh when
  // SENTRY_FORCE_ENV_TOKEN is set. If the token can't be refreshed (env token,
  // no refresh token), `refreshed` is false and the 401 propagates.
  try {
    const result = await refreshToken({
      force: true,
      expectedCredential: credential,
    });
    return result.refreshed
      ? Object.freeze({ ...credential, token: result.token })
      : undefined;
  } catch (error) {
    // Invalid refreshed credentials must propagate as an auth error, rather
    // than being swallowed by the best-effort refresh catch.
    if (error instanceof MalformedAuthTokenError) {
      throw error;
    }
    log.debug("Token refresh failed after 401", error);
    return;
  }
}

/** Resolve the per-request timeout for a URL via {@link ENDPOINT_TIMEOUT_OVERRIDES}. */
function resolveTimeoutMs(fullUrl: string): number {
  const pathname = extractUrlPath(fullUrl);
  for (const entry of ENDPOINT_TIMEOUT_OVERRIDES) {
    if (entry.pattern.test(pathname)) {
      return entry.timeoutMs;
    }
  }
  return REQUEST_TIMEOUT_MS;
}

/** Pass custom TLS options (CA certs for corporate proxies) to each fetch. */
async function fetchWithCustomTls(
  input: Request | string | URL,
  init?: RequestInit,
): Promise<Response> {
  // On Bun, this passes `tls: { ca }` to fetch(); on Node, the extra
  // property is harmless (Node honors NODE_EXTRA_CA_CERTS natively).
  const customTls = getCustomTlsOptions();
  if (customTls) {
    warnIfSaasWithEnvCa(extractInputUrl(input));
  }
  return await fetch(input, { ...init, ...customTls });
}

/** Best-effort `detail` from a Sentry error body. */
async function readErrorDetail(
  response: Response,
): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await response.text()) as { detail?: unknown };
    return typeof parsed.detail === "string" ? parsed.detail : undefined;
  } catch (error) {
    log.debug("Failed to read rate-limit response detail", error);
    return;
  }
}

/** The response cache, keyed by the CLI's identity fingerprint. */
const responseCache: TransportCache = {
  lookup: async ({ url, requestHeaders, identity }) =>
    await lookupCachedResponse("GET", url, requestHeaders, identity),
  store: async ({ url, requestHeaders, identity }, response) =>
    await storeCachedResponse("GET", url, requestHeaders, response, identity),
  /** Prefix computation: {@link computeInvalidationPrefixes}. */
  invalidate: async (url, identity) => {
    const prefixes = computeInvalidationPrefixes(url, getApiBaseUrl());
    await Promise.all(
      prefixes.map((prefix) =>
        invalidateCachedResponsesMatching(prefix, identity),
      ),
    );
  },
};

/** Wrap a request in an `http.client` span when the CLI traces HTTP by hand. */
async function withHttpSpan(
  { method, path }: { method: string; path: string },
  run: () => Promise<Response>,
): Promise<Response> {
  if (!isManualHttpTracing()) {
    return await run();
  }
  return await withTracingSpan(
    `${method} ${path}`,
    "http.client",
    async (span) => {
      const response = await run();
      span.setAttribute("http.response.status_code", response.status);
      if (!response.ok) {
        span.setStatus({ code: 2, message: `${response.status}` });
      }
      return response;
    },
    { "http.request.method": method, "url.path": path },
  );
}

/**
 * The CLI's transport options: stored credentials, host-scope checks, the
 * response cache, and the CLI's error classes. Retries, timeouts, the 401
 * refresh, and redirect validation are in `@sentry/toolkit-core/api-transport`.
 */
function createCliTransport(credential: CredentialContext | undefined) {
  return createApiTransport<CredentialContext>({
    credentials: {
      current: async () => {
        const current = credential ?? getCredentialContext();
        if (!current) {
          await refreshToken();
          throw new Error(
            "Authentication state was not available after refresh",
          );
        }
        return current;
      },
      prepare: prepareCredential,
      refresh: refreshAfterUnauthorized,
      authorization: (current) => formatAuthHeader(current.token),
    },
    retry: RETRY_POLICY,
    timeoutMs: resolveTimeoutMs,
    fetch: fetchWithCustomTls,
    userAgent: getUserAgent(),
    prepareHeaders,
    isIdempotent: isIdempotentOperation,
    refreshedRequestHeader: RETRY_MARKER_HEADER,
    origins: {
      trusts: (url, current) => isRequestOriginTrustedForContext(url, current),
      reject: (destination, current) =>
        new HostScopeError("Redirect destination", destination, current.host),
    },
    errors: {
      timeout: ({ timeoutMs, idempotent }) =>
        new TimeoutError(
          `Request timed out after ${Math.round(timeoutMs / 1000)}s.`,
          idempotent
            ? "The Sentry API did not respond in time. Try again; if the problem persists, check https://status.sentry.io."
            : "The Sentry API did not respond in time. The change may still have been applied; check before trying again. If the problem persists, check https://status.sentry.io.",
        ),
      // TLS certificate errors are deterministic — don't retry
      fatal: (error) =>
        isTlsCertError(error)
          ? new ApiError(
              "TLS certificate error",
              0,
              buildTlsErrorDetail(error as Error),
            )
          : undefined,
      rateLimited: async (response, { path, retryAfterMs }) =>
        new RateLimitError(path, retryAfterMs, await readErrorDetail(response)),
    },
    cache: responseCache,
    logger: log,
    span: withHttpSpan,
  });
}

/**
 * Create a fetch function with authentication, timeout, retry, caching, and 401 refresh.
 *
 * This wraps the native fetch with `@sentry/toolkit-core/api-transport`:
 * - **Response caching** for GET requests (checked before hitting the network)
 * - Auth token injection (Bearer token)
 * - Request timeout via AbortController
 * - Automatic retry on transient HTTP errors (429, 500, 502-504), network errors,
 *   and timeouts — for GET/HEAD/OPTIONS, operations Sentry marks idempotent
 *   (see idempotent-operations.ts), or any method with `idempotent`
 * - 429 handling (any method; rejected before processing): waits for the
 *   server's rate-limit reset when it fits the cap, otherwise throws
 *   {@link RateLimitError}
 * - 401 handling: force-refreshes the token and retries once (any method)
 * - Jittered exponential backoff between retries
 * - User-Agent header for API analytics
 *
 * Cache is checked first — on a hit, auth refresh, timeout, and retry logic are
 * all skipped. On a miss or for non-GET methods, the full authenticated flow runs
 * and successful GET responses are stored in the cache afterward.
 *
 * @returns A fetch-compatible function for use with @sentry/api SDK functions
 */
type AuthenticatedFetchOptions = {
  credential?: CredentialContext;
  validatedRedirects?: boolean;
  /** Complete successful GET bodies inside the retry/timeout budget. */
  bufferResponseBody?: boolean;
  /**
   * Caller asserts that replaying the request is harmless, so transient
   * failures retry for any method. Operations Sentry marks idempotent retry
   * without this; set it for writes the server dedupes that the catalog
   * cannot match, such as chunk uploads to the server-provided URL.
   */
  idempotent?: boolean;
};

function createAuthenticatedFetch(
  options: AuthenticatedFetchOptions = {},
): (input: Request | string | URL, init?: RequestInit) => Promise<Response> {
  const transport = createCliTransport(options.credential);
  const authenticatedFetch = async (
    input: Request | string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    // Reset cache-hit age so it reflects only this request's outcome.
    // Commands read it after their primary API call to show cache-age hints.
    clearLastCacheHitAge();

    // Once-per-process hint when env-var auth token is shadowed by a
    // stored OAuth login. Runs here (rather than at command entry) so
    // the hint only fires for commands that actually exercise auth —
    // `sentry help` and similar local-only commands stay quiet.
    // Internally rate-limited and cheap on repeat calls.
    maybeWarnEnvTokenIgnored();

    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    return await transport.request(input, init, {
      validateRedirects: options.validatedRedirects === true,
      idempotent: options.idempotent === true,
      responseBody:
        method.toUpperCase() !== "GET"
          ? "stream"
          : ((input instanceof Request
              ? sdkResponseBodyModes.get(input)
              : undefined) ??
            (options.bufferResponseBody ? "buffer" : "stream")),
    });
  };
  // Every API response, fresh or cached, seeds shell completion, so no API
  // function has to remember to. Awaited so a command that exits right
  // after its request still stores the entities.
  return async (input, init) =>
    await seedCompletions(
      extractInputUrl(input),
      await authenticatedFetch(input, init),
    );
}

/** Singleton authenticated fetch instance - reused across all requests */
let cachedFetch: typeof fetch | null = null;

/**
 * Get the shared authenticated fetch instance.
 * Cast to `typeof fetch` for compatibility with @sentry/api SDK options.
 */
function getAuthenticatedFetch(
  options: AuthenticatedFetchOptions = {},
): typeof fetch {
  if (
    options.credential ||
    options.validatedRedirects ||
    options.bufferResponseBody ||
    options.idempotent
  ) {
    return createAuthenticatedFetch(options) as unknown as typeof fetch;
  }
  if (!cachedFetch) {
    cachedFetch = createAuthenticatedFetch(options) as unknown as typeof fetch;
  }
  return cachedFetch;
}

/**
 * Get the Sentry API base URL.
 * Supports self-hosted instances via SENTRY_URL env var.
 */
export function getApiBaseUrl(credential = getCredentialContext()): string {
  return getConfiguredSentryUrl() ?? credential?.host ?? DEFAULT_SENTRY_URL;
}

/**
 * Get the control silo URL.
 * This is always sentry.io for SaaS, or the custom URL for self-hosted.
 *
 * Read lazily (not at module load) so that SENTRY_URL set after import
 * (e.g., from URL argument parsing for self-hosted instances) is respected.
 */
export function getControlSiloUrl(credential = getCredentialContext()): string {
  return getApiBaseUrl(credential);
}

/**
 * Get authenticated transport configuration for direct fetch callers.
 *
 * Generated SDK operations use getSdkClientConfig from sentry-sdk-client.ts
 * so their parsing intent reaches the transport. Bound SDK clients register
 * registerSdkResponseBodyMode on their own underlying client.
 *
 * Returns the common transport options:
 * - `baseUrl`: The API base URL for the target region
 * - `fetch`: Authenticated fetch with retry, timeout, and 401 refresh
 * - `throwOnError`: Always false (we handle errors ourselves)
 *
 * @param regionUrl - The base URL for the target region (e.g., https://us.sentry.io)
 * @returns Configuration for direct fetch calls or bound SDK client setup
 */
export function getSdkConfig(
  regionUrl: string,
  options: AuthenticatedFetchOptions = {},
) {
  const normalizedBase = regionUrl.endsWith("/")
    ? regionUrl.slice(0, -1)
    : regionUrl;

  return {
    // SDK functions already include /api/0/ in their URL paths,
    // so baseUrl should be the plain region URL without /api/0.
    baseUrl: normalizedBase,
    fetch: getAuthenticatedFetch(options),
    throwOnError: false as const,
  };
}

/**
 * Get SDK config for the default API (control silo or self-hosted).
 */
export function getDefaultSdkConfig(
  options: Pick<AuthenticatedFetchOptions, "bufferResponseBody"> = {},
) {
  const credential = getCredentialContext();
  return getSdkConfig(getApiBaseUrl(credential), { ...options, credential });
}

/**
 * Get SDK config for the control silo.
 * Used for endpoints that are always on the control silo (OAuth, user accounts, regions).
 */
export function getControlSdkConfig() {
  const credential = getCredentialContext();
  return getSdkConfig(getControlSiloUrl(credential), { credential });
}

/**
 * Reset the cached fetch instance.
 * Useful for testing or when auth state changes.
 */
export function resetAuthenticatedFetch(): void {
  cachedFetch = null;
}

/** @internal Test-only — see {@link ENDPOINT_TIMEOUT_OVERRIDES}. */
export function __resolveRequestTimeoutMsForTests(fullUrl: string): number {
  return resolveTimeoutMs(fullUrl);
}

/**
 * @internal Test-only — temporarily prepend a timeout override. The returned
 * disposer restores the original list.
 */
export function __injectTimeoutOverrideForTests(
  override: TimeoutOverride,
): () => void {
  ENDPOINT_TIMEOUT_OVERRIDES.unshift(override);
  return () => {
    const idx = ENDPOINT_TIMEOUT_OVERRIDES.indexOf(override);
    if (idx >= 0) {
      ENDPOINT_TIMEOUT_OVERRIDES.splice(idx, 1);
    }
  };
}
