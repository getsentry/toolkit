/**
 * Sentry API Client Configuration
 *
 * Provides request configuration for @sentry/api SDK functions,
 * including authentication, retry logic, timeout, and multi-region support.
 *
 * Instead of managing client instances, we pass configuration per-request
 * through the SDK function options (baseUrl, fetch, headers).
 */

import { setTimeout as sleepMs } from "node:timers/promises";
import { getTraceData } from "@sentry/node-core/light";
import {
  formatAuthHeader,
  normalizeAuthToken,
  trimAuthToken,
} from "./auth-header.js";
import { maybeWarnEnvTokenIgnored } from "./auth-hint.js";
import { computeInvalidationPrefixes } from "./cache-keys.js";
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
import { getAuthToken, refreshToken } from "./db/auth.js";
import {
  ApiError,
  HostScopeError,
  MalformedAuthTokenError,
  TimeoutError,
} from "./errors.js";
import { logger } from "./logger.js";
import {
  clearLastCacheHitAge,
  getCachedResponse,
  invalidateCachedResponsesMatching,
  storeCachedResponse,
} from "./response-cache.js";
import { normalizeOrigin } from "./sentry-urls.js";
import { withTracingSpan } from "./telemetry.js";
import { parseSntrysClaim } from "./token-claims.js";
import {
  getActiveTokenHost,
  isHostTrustedForClaim,
  isRequestOriginTrusted,
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

/** Maximum retry attempts for failed requests */
const MAX_RETRIES = 2;

/** Maximum backoff delay between retries in milliseconds */
const MAX_BACKOFF_MS = 10_000;

/** HTTP status codes that trigger automatic retry */
const RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504];

/** Header to mark requests as retries, preventing infinite token refresh loops */
const RETRY_MARKER_HEADER = "x-sentry-cli-retry";

/** Stamped on thrown errors caused by our own per-request timeout. */
const INTERNAL_TIMEOUT_MARKER = Symbol("sentry-cli:internal-timeout");

/** Calculate exponential backoff delay, capped at MAX_BACKOFF_MS */
function backoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
}

/** Check if an error is a user-initiated abort */
function isUserAbort(error: unknown, signal?: AbortSignal | null): boolean {
  return (
    error instanceof DOMException &&
    error.name === "AbortError" &&
    Boolean(signal?.aborted)
  );
}

/**
 * Prepare request headers with auth token and default headers.
 *
 * Only sets Authorization and User-Agent. Content-Type is intentionally NOT
 * set here — callers are responsible for setting it based on their needs:
 * - SDK functions set their own Content-Type
 * - apiRequestToRegion always sends JSON and sets it explicitly
 * - rawApiRequest may or may not want Content-Type (e.g., string bodies)
 *
 * When `init` is undefined (the SDK passes only a Request object), headers are
 * read from the Request object to preserve Content-Type and other headers set
 * by the SDK. Without this, fetch(Request, {headers}) would override the
 * Request's headers with our empty headers, stripping Content-Type and causing
 * HTTP 415 errors on Node.js (which strictly follows the spec).
 *
 * The returned Headers instance is intentionally shared and mutated across
 * retry attempts (e.g., handleUnauthorized updates the Authorization header
 * and sets the retry marker). Do not clone before passing to retry logic.
 */
function prepareHeaders(
  input: Request | string | URL,
  init: RequestInit | undefined,
  token: string
): Headers {
  // Host-scoping guard (defense in depth). Primary rejection happens at the
  // URL-arg / rc-shim entry points; this catches any code path that mutated
  // SENTRY_HOST/SENTRY_URL without going through those guards.
  if (!isRequestOriginTrusted(input)) {
    throw new HostScopeError(
      "Credentials",
      normalizeOrigin(input) ?? "<unknown host>",
      getActiveTokenHost()
    );
  }

  // sntrys_ claim check — defense-in-depth for users with access to
  // multiple Sentry instances. The claim is unsigned (see token-claims.ts);
  // fail-open on parse errors. Uses isHostTrustedForClaim so multi-region
  // fan-out via the control silo's region URLs still works.
  const normalizedToken = normalizeAuthToken(token);
  const claimUrl = parseSntrysClaim(normalizedToken)?.url;
  if (claimUrl && !isHostTrustedForClaim(input, claimUrl)) {
    throw new HostScopeError(
      "Credentials",
      normalizeOrigin(input) ?? "<unknown host>",
      claimUrl
    );
  }

  // When the SDK calls fetch(request) with no init, read headers from the Request
  // object to preserve Content-Type. On Node.js, fetch(request, {headers}) replaces
  // the Request's headers entirely per spec, so we must carry them forward explicitly.
  const sourceHeaders =
    init?.headers ?? (input instanceof Request ? input.headers : undefined);
  const headers = new Headers(sourceHeaders);
  headers.set("Authorization", formatAuthHeader(normalizedToken));
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", getUserAgent());
  }

  // Inject distributed tracing headers to connect CLI spans to backend traces.
  // Manual injection is required because Bun's fetch doesn't fire undici
  // diagnostics channels, so the SDK's nativeNodeFetchIntegration cannot work.
  // When telemetry is disabled, getTraceData() returns {} — no headers injected.
  const traceData = getTraceData();
  if (traceData["sentry-trace"]) {
    headers.set("sentry-trace", traceData["sentry-trace"]);
  }
  if (traceData.baggage) {
    headers.set("baggage", traceData.baggage);
  }

  // Inject user-configured custom headers for self-hosted proxies (IAP,
  // mTLS, etc.) — scoped to the request URL.
  applyCustomHeaders(headers, input);

  return headers;
}

/**
 * Handle 401 response by refreshing the token.
 * @returns true if the token was refreshed and request should be retried
 */
async function handleUnauthorized(headers: Headers): Promise<boolean> {
  if (headers.get(RETRY_MARKER_HEADER)) {
    return false;
  }
  // refreshToken handles the token selection: it refreshes OAuth when OAuth is
  // the effective auth source, or returns the env token without refresh when
  // SENTRY_FORCE_ENV_TOKEN is set. If the token can't be refreshed (env token,
  // no refresh token), `refreshed` is false and the 401 propagates.
  let newToken: string;
  try {
    const result = await refreshToken({ force: true });
    if (!result.refreshed) {
      return false;
    }
    newToken = result.token;
  } catch (error) {
    if (error instanceof MalformedAuthTokenError) {
      throw error;
    }
    log.debug("Token refresh failed after 401", error);
    return false;
  }

  // Invalid refreshed credentials must propagate as an auth error, rather
  // than being swallowed by the best-effort refresh catch above.
  headers.set("Authorization", formatAuthHeader(newToken));
  headers.set(RETRY_MARKER_HEADER, "1");
  return true;
}

/** Link an external abort signal to an AbortController */
function linkAbortSignal(
  signal: AbortSignal | undefined | null,
  controller: AbortController
): void {
  if (!signal) {
    return;
  }
  if (signal.aborted) {
    controller.abort();
    return;
  }
  signal.addEventListener("abort", () => controller.abort(), { once: true });
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

function isInternalTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<PropertyKey, unknown>)[INTERNAL_TIMEOUT_MARKER] === true
  );
}

type FetchWithTimeoutArgs = {
  input: Request | string | URL;
  init: RequestInit | undefined;
  headers: Headers;
  externalSignal: AbortSignal | undefined | null;
  timeoutMs: number;
};

/**
 * Execute a single fetch attempt with timeout. If the timeout fires, the
 * thrown error is tagged with {@link INTERNAL_TIMEOUT_MARKER} so the retry
 * loop can distinguish it from a user abort or network error.
 */
async function fetchWithTimeout({
  input,
  init,
  headers,
  externalSignal,
  timeoutMs,
}: FetchWithTimeoutArgs): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  linkAbortSignal(externalSignal, controller);

  try {
    // Spread custom TLS options (CA certs for corporate proxies).
    // On Bun, this passes `tls: { ca }` to fetch(); on Node, the
    // extra property is harmless (Node honors NODE_EXTRA_CA_CERTS natively).
    const customTls = getCustomTlsOptions();
    if (customTls) {
      warnIfSaasWithEnvCa(extractFullUrl(input));
    }

    return await fetch(input, {
      ...init,
      headers,
      signal: controller.signal,
      ...customTls,
    });
  } catch (error) {
    if (timedOut) {
      const tagged = (
        error instanceof Error ? error : new Error(String(error))
      ) as Error & { [INTERNAL_TIMEOUT_MARKER]?: true; timeoutMs?: number };
      tagged[INTERNAL_TIMEOUT_MARKER] = true;
      tagged.timeoutMs = timeoutMs;
      throw tagged;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Result of a single fetch attempt - drives the retry loop */
type AttemptResult =
  | { action: "done"; response: Response }
  | { action: "retry" }
  | { action: "throw"; error: unknown };

/**
 * Decide what to do with a successful HTTP response.
 * Returns 'done' for final responses, 'retry' for retryable errors and 401s.
 * Only refresh credentials when another attempt can use them.
 */
async function handleResponse(
  response: Response,
  headers: Headers,
  isLastAttempt: boolean
): Promise<AttemptResult> {
  if (response.status === 401 && !isLastAttempt) {
    const refreshed = await handleUnauthorized(headers);
    return refreshed ? { action: "retry" } : { action: "done", response };
  }

  if (RETRYABLE_STATUS_CODES.includes(response.status) && !isLastAttempt) {
    return { action: "retry" };
  }

  return { action: "done", response };
}

/**
 * Decide what to do with a fetch error. User aborts and an internal
 * timeout on the last attempt throw immediately; TLS cert errors throw
 * immediately with actionable guidance (retrying is pointless); other
 * errors retry until the last attempt, then propagate.
 */
function handleFetchError(
  error: unknown,
  signal: AbortSignal | undefined | null,
  isLastAttempt: boolean
): AttemptResult {
  if (isUserAbort(error, signal)) {
    return { action: "throw", error };
  }

  // TLS certificate errors are deterministic — don't retry
  if (isTlsCertError(error)) {
    return {
      action: "throw",
      error: new ApiError(
        "TLS certificate error",
        0,
        buildTlsErrorDetail(error as Error)
      ),
    };
  }

  if (isInternalTimeout(error) && isLastAttempt) {
    const timeoutMs =
      (error as { timeoutMs?: number }).timeoutMs ?? REQUEST_TIMEOUT_MS;
    const seconds = Math.round(timeoutMs / 1000);
    return {
      action: "throw",
      error: new TimeoutError(
        `Request timed out after ${seconds}s.`,
        "The Sentry API did not respond in time. Try again; if the problem persists, check https://status.sentry.io."
      ),
    };
  }
  if (isLastAttempt) {
    return { action: "throw", error };
  }
  return { action: "retry" };
}

/** Extract the full URL string from a fetch input */
function extractFullUrl(input: Request | string | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

/** Extract the URL pathname for span naming */
function extractUrlPath(input: Request | string | URL): string {
  const raw = extractFullUrl(input);
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return new URL(raw).pathname;
  } catch {
    return raw;
  }
}

/**
 * Attempt to serve a GET request from the response cache.
 * Returns the cached Response if valid, or undefined on miss.
 *
 * @param requestHeaders - Headers that were (or will be) sent with the request,
 *   needed for correct `Vary` handling in CachePolicy freshness checks.
 */
async function tryCacheHit(
  method: string,
  fullUrl: string,
  requestHeaders: Record<string, string>
): Promise<Response | undefined> {
  if (method !== "GET") {
    return;
  }
  return await getCachedResponse(method, fullUrl, requestHeaders);
}

/**
 * Store a successful GET response in the cache (fire-and-forget).
 * Clones the response so the original body stream is preserved for the caller.
 *
 * @param requestHeaders - Headers sent with the request, stored in CachePolicy
 *   for future `Vary`-aware freshness checks.
 */
function cacheResponse(
  method: string,
  fullUrl: string,
  requestHeaders: Record<string, string>,
  response: Response
): void {
  if (method !== "GET" || !response.ok) {
    return;
  }
  // Cast needed: Bun extends Response with extra properties (toJSON, count, getAll)
  // that .clone() doesn't carry over, but our cache only reads standard Response API
  storeCachedResponse(
    method,
    fullUrl,
    requestHeaders,
    response.clone() as Response
  ).catch((error) => {
    log.debug("Response cache write failed", error);
  });
}

/**
 * Auto-invalidate cache entries that a successful non-GET mutation
 * made stale. Awaited so a subsequent read in the same command sees
 * fresh data. Prefix computation: {@link computeInvalidationPrefixes}.
 *
 * Never throws: a post-mutation housekeeping failure must not convert
 * a successful mutation into a caller-visible error. Defense-in-depth
 * for future regressions — the helpers we call are already no-throw
 * today.
 */
async function invalidateAfterMutation(
  method: string,
  fullUrl: string,
  response: Response
): Promise<void> {
  if (method === "GET" || !response.ok) {
    return;
  }
  try {
    const prefixes = computeInvalidationPrefixes(fullUrl, getApiBaseUrl());
    await Promise.all(
      prefixes.map((prefix) => invalidateCachedResponsesMatching(prefix))
    );
  } catch (error) {
    log.debug("Post-mutation cache invalidation failed", error);
  }
}

/** Cache metadata must not validate a candidate before OAuth refresh selects a token. */
function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { authorization: `Bearer ${trimAuthToken(token)}` } : {};
}

type AttemptInputFactory = () => {
  input: Request | string | URL;
  init: RequestInit | undefined;
};

/**
 * Build an attempt factory that yields a fresh, body-readable
 * `(input, init)` pair per retry. `fetch` consumes a request body on
 * attempt 1; without this cloning every retry after a timeout / 5xx /
 * 401-refresh would throw `TypeError: Request body already used` (CLI-1D6).
 *
 * `Request` inputs clone per attempt. Bodies that `fetch` re-reads on
 * each call (string / ArrayBuffer / TypedArray / Blob / FormData /
 * URLSearchParams / none) pass through unchanged — this is the hot path
 * for every non-SDK call site, and importantly preserves the auto-
 * negotiated `Content-Type: multipart/form-data; boundary=...` header
 * that `fetch` derives from `FormData` bodies (sourcemap chunk upload).
 * A bare `ReadableStream` is the only single-use body shape, so it's
 * drained once to an `ArrayBuffer`.
 */
async function buildAttemptFactory(
  input: Request | string | URL,
  init: RequestInit | undefined
): Promise<AttemptInputFactory> {
  if (input instanceof Request) {
    // Cast: Bun's `Request` has extras (toJSON/count/getAll) that `.clone()`
    // drops from the DOM type — runtime shape is unaffected.
    return () => ({ input: input.clone() as unknown as Request, init });
  }

  const body = init?.body;
  if (body instanceof ReadableStream) {
    const snapshot = await new Response(body).arrayBuffer();
    return () => ({ input, init: { ...init, body: snapshot } });
  }

  return () => ({ input, init });
}

/**
 * Authenticate and execute a request with retry logic.
 *
 * Refreshes the auth token, then retries the request up to `MAX_RETRIES` times
 * with exponential backoff on transient errors.
 */
async function fetchWithRetry(
  input: Request | string | URL,
  init: RequestInit | undefined,
  method: string,
  fullUrl: string
): Promise<Response> {
  const { token } = await refreshToken();
  const headers = prepareHeaders(input, init, token);
  const attemptFactory = await buildAttemptFactory(input, init);
  const timeoutMs = resolveTimeoutMs(fullUrl);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const isLastAttempt = attempt === MAX_RETRIES;
    const { input: attemptInput, init: attemptInit } = attemptFactory();
    const result = await executeAttempt({
      input: attemptInput,
      init: attemptInit,
      headers,
      isLastAttempt,
      timeoutMs,
    });

    if (result.action === "done") {
      // Use getAuthToken() instead of captured `token` — after a 401 refresh,
      // handleUnauthorized stores a new token in the DB
      cacheResponse(
        method,
        fullUrl,
        authHeaders(getAuthToken()),
        result.response
      );
      await invalidateAfterMutation(method, fullUrl, result.response);
      return result.response;
    }
    if (result.action === "throw") {
      throw result.error;
    }

    const delay = backoffDelay(attempt);
    log.debug(
      `${method} ${new URL(fullUrl).pathname} → retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms`
    );
    await sleepMs(delay);
  }

  // Unreachable: the last attempt always returns 'done' or 'throw'
  throw new Error("Exhausted all retry attempts");
}

/**
 * Create a fetch function with authentication, timeout, retry, caching, and 401 refresh.
 *
 * This wraps the native fetch with:
 * - **Response caching** for GET requests (checked before hitting the network)
 * - Auth token injection (Bearer token)
 * - Request timeout via AbortController
 * - Automatic retry on transient HTTP errors (408, 429, 5xx)
 * - 401 handling: force-refreshes the token and retries once
 * - Exponential backoff between retries
 * - User-Agent header for API analytics
 * - Automatic HTTP span tracing for every request
 *
 * Cache is checked first — on a hit, auth refresh, timeout, and retry logic are
 * all skipped. On a miss or for non-GET methods, the full authenticated flow runs
 * and successful GET responses are stored in the cache afterward.
 *
 * @returns A fetch-compatible function for use with @sentry/api SDK functions
 */
function createAuthenticatedFetch(): (
  input: Request | string | URL,
  init?: RequestInit
) => Promise<Response> {
  return function authenticatedFetch(
    input: Request | string | URL,
    init?: RequestInit
  ): Promise<Response> {
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
    const urlPath = extractUrlPath(input);

    return withTracingSpan(
      `${method} ${urlPath}`,
      "http.client",
      async (span) => {
        const fullUrl = extractFullUrl(input);
        const startTime = performance.now();

        // Check cache before auth/retry for GET requests.
        // Uses current token (no refresh) so lookups are fast but Vary-correct.
        const cached = await tryCacheHit(
          method,
          fullUrl,
          authHeaders(getAuthToken())
        );
        if (cached) {
          span.setAttribute("http.response.status_code", cached.status);
          log.debug(
            `${method} ${urlPath} → ${cached.status} (cache hit, ${(performance.now() - startTime).toFixed(0)}ms)`
          );
          return cached;
        }

        const response = await fetchWithRetry(input, init, method, fullUrl);
        span.setAttribute("http.response.status_code", response.status);
        if (!response.ok) {
          span.setStatus({ code: 2, message: `${response.status}` });
        }
        log.debug(
          `${method} ${urlPath} → ${response.status} (${(performance.now() - startTime).toFixed(0)}ms)`
        );
        return response;
      },
      { "http.request.method": method, "url.path": urlPath }
    );
  };
}

/**
 * Execute a single fetch attempt and classify the outcome.
 */
type ExecuteAttemptArgs = {
  input: Request | string | URL;
  init: RequestInit | undefined;
  headers: Headers;
  isLastAttempt: boolean;
  timeoutMs: number;
};

async function executeAttempt({
  input,
  init,
  headers,
  isLastAttempt,
  timeoutMs,
}: ExecuteAttemptArgs): Promise<AttemptResult> {
  try {
    const response = await fetchWithTimeout({
      input,
      init,
      headers,
      externalSignal: init?.signal,
      timeoutMs,
    });
    return handleResponse(response, headers, isLastAttempt);
  } catch (error) {
    return handleFetchError(error, init?.signal, isLastAttempt);
  }
}

/** Singleton authenticated fetch instance - reused across all requests */
let cachedFetch: typeof fetch | null = null;

/**
 * Get the shared authenticated fetch instance.
 * Cast to `typeof fetch` for compatibility with @sentry/api SDK options.
 */
function getAuthenticatedFetch(): typeof fetch {
  if (!cachedFetch) {
    cachedFetch = createAuthenticatedFetch() as unknown as typeof fetch;
  }
  return cachedFetch;
}

/**
 * Get the Sentry API base URL.
 * Supports self-hosted instances via SENTRY_URL env var.
 */
export function getApiBaseUrl(): string {
  return getConfiguredSentryUrl() ?? DEFAULT_SENTRY_URL;
}

/**
 * Get the control silo URL.
 * This is always sentry.io for SaaS, or the custom URL for self-hosted.
 *
 * Read lazily (not at module load) so that SENTRY_URL set after import
 * (e.g., from URL argument parsing for self-hosted instances) is respected.
 */
export function getControlSiloUrl(): string {
  return getConfiguredSentryUrl() ?? DEFAULT_SENTRY_URL;
}

/**
 * Get request configuration for an @sentry/api SDK function call.
 *
 * Returns the common options needed by every SDK function call:
 * - `baseUrl`: The API base URL for the target region
 * - `fetch`: Authenticated fetch with retry, timeout, and 401 refresh
 * - `throwOnError`: Always false (we handle errors ourselves)
 *
 * @param regionUrl - The base URL for the target region (e.g., https://us.sentry.io)
 * @returns Configuration object to spread into SDK function options
 *
 * @example
 * ```ts
 * const config = getSdkConfig("https://us.sentry.io");
 * const result = await listOrganizations({ ...config });
 * ```
 */
export function getSdkConfig(regionUrl: string) {
  const normalizedBase = regionUrl.endsWith("/")
    ? regionUrl.slice(0, -1)
    : regionUrl;

  return {
    // SDK functions already include /api/0/ in their URL paths,
    // so baseUrl should be the plain region URL without /api/0.
    baseUrl: normalizedBase,
    fetch: getAuthenticatedFetch(),
    throwOnError: false as const,
  };
}

/**
 * Get SDK config for the default API (control silo or self-hosted).
 */
export function getDefaultSdkConfig() {
  return getSdkConfig(getApiBaseUrl());
}

/**
 * Get SDK config for the control silo.
 * Used for endpoints that are always on the control silo (OAuth, user accounts, regions).
 */
export function getControlSdkConfig() {
  return getSdkConfig(getControlSiloUrl());
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
  override: TimeoutOverride
): () => void {
  ENDPOINT_TIMEOUT_OVERRIDES.unshift(override);
  return () => {
    const idx = ENDPOINT_TIMEOUT_OVERRIDES.indexOf(override);
    if (idx >= 0) {
      ENDPOINT_TIMEOUT_OVERRIDES.splice(idx, 1);
    }
  };
}
