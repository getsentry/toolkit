/**
 * Custom Headers for Self-Hosted Sentry
 *
 * Parses `SENTRY_CUSTOM_HEADERS` env var (or `defaults.headers` from SQLite)
 * and injects user-specified HTTP headers into all requests to self-hosted
 * Sentry instances. Designed for environments behind reverse proxies
 * (e.g., Google IAP, Cloudflare Access) that require extra headers.
 *
 * Format: semicolon-separated `Name: Value` pairs (newlines also accepted).
 *
 * The library API (`createSentrySDK({ headers })`) bypasses the string format
 * and sets the structured headers for the current invocation via
 * {@link setCustomHeadersOverride}, validated with the same rules.
 *
 * @example
 * ```bash
 * # Single header
 * SENTRY_CUSTOM_HEADERS="X-IAP-Token: abc123"
 *
 * # Multiple headers
 * SENTRY_CUSTOM_HEADERS="X-IAP-Token: abc123; X-Forwarded-For: 10.0.0.1"
 *
 * # Via defaults command
 * sentry cli defaults headers "X-IAP-Token: abc123"
 * ```
 */

import { getConfiguredSentryUrl } from "./constants.js";
import { getDefaultHeaders } from "./db/defaults.js";
import { getEnv } from "./env.js";
import { ConfigError } from "./errors.js";
import { logger } from "./logger.js";
import { isSentrySaasUrl } from "./sentry-urls.js";
import { isRequestOriginTrustedForCustomHeaders } from "./token-host.js";

const log = logger.withTag("custom-headers");

/**
 * Header names that must not be overridden via custom headers.
 * These are managed by the CLI's own request pipeline and overriding
 * them would break authentication, content negotiation, or tracing.
 */
const FORBIDDEN_HEADER_NAMES = new Set([
  "authorization",
  "host",
  "content-type",
  "content-length",
  "user-agent",
  "sentry-trace",
  "baggage",
]);

/**
 * RFC 7230 token characters for header field names.
 * Header names consist of visible ASCII characters except delimiters.
 */
const VALID_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~\w]+$/;

/** Splits on semicolons and newlines (both valid header separators). */
const HEADER_SEPARATOR_RE = /[;\n]/;

/** Strips trailing carriage return from a line (Windows line endings). */
const TRAILING_CR_RE = /\r$/;

/** Cached parsed headers (from env var or defaults). `undefined` = not yet parsed. */
let cachedHeaders: readonly [string, string][] | undefined;

/** Tracks the raw source string that produced `cachedHeaders`, for invalidation. */
let cachedRawSource: string | undefined;

/** Whether the SaaS warning has already been logged this session. */
let saasWarningLogged = false;

/** Whether the untrusted-destination warning has already been logged. */
let untrustedDestinationWarningLogged = false;

/**
 * Structured headers set by the library API for the current invocation.
 * `undefined` = not set, fall through to the env var / SQLite defaults.
 */
let overrideHeaders: readonly [string, string][] | undefined;

/**
 * Validate a header name against RFC 7230 token rules and the reserved list.
 *
 * @param name - Trimmed header name
 * @param source - Where the header came from, for the error message
 * @throws {ConfigError} On invalid or reserved header names
 */
function assertValidHeaderName(name: string, source: string): void {
  if (!VALID_HEADER_NAME_RE.test(name)) {
    throw new ConfigError(
      `Invalid header name '${name}' in ${source}. Header names must contain only alphanumeric characters, hyphens, and RFC 7230 token characters.`
    );
  }

  if (FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) {
    throw new ConfigError(
      `Cannot override reserved header '${name}' in ${source}. This header is managed by the CLI.`
    );
  }
}

/**
 * Parse a raw custom headers string into validated name/value pairs.
 *
 * Accepts semicolon-separated or newline-separated `Name: Value` entries.
 * Empty segments and whitespace-only segments are silently skipped.
 *
 * @param raw - Raw header string (from env var or defaults)
 * @returns Array of `[name, value]` tuples in declaration order
 * @throws {ConfigError} On malformed segments or forbidden header names
 */
export function parseCustomHeaders(raw: string): readonly [string, string][] {
  const results: [string, string][] = [];

  // Split on semicolons and newlines
  const segments = raw.split(HEADER_SEPARATOR_RE);

  for (const segment of segments) {
    const trimmed = segment.replace(TRAILING_CR_RE, "").trim();
    if (!trimmed) {
      continue;
    }

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      throw new ConfigError(
        `Invalid header in SENTRY_CUSTOM_HEADERS: '${trimmed}'. Expected 'Name: Value' format.`
      );
    }

    const name = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();

    if (!name) {
      throw new ConfigError(
        `Invalid header in SENTRY_CUSTOM_HEADERS: empty header name in '${trimmed}'.`
      );
    }

    assertValidHeaderName(name, "SENTRY_CUSTOM_HEADERS");

    results.push([name, value]);
  }

  return results;
}

/**
 * Set structured custom headers for the current library invocation.
 *
 * Bypasses `SENTRY_CUSTOM_HEADERS` and the SQLite defaults entirely: no
 * string round-trip, and an explicit map (even an empty one) takes precedence
 * over an inherited env var. The self-hosted guard and the request-origin
 * trust check in {@link applyCustomHeaders} still apply.
 *
 * Pass `undefined` to clear. The SDK invoke layer calls this next to `setEnv`.
 *
 * @param headers - Header name/value map from `SentryOptions.headers`
 * @throws {ConfigError} On invalid or reserved header names
 */
export function setCustomHeadersOverride(
  headers: Record<string, string> | undefined
): void {
  if (headers === undefined) {
    overrideHeaders = undefined;
    return;
  }

  const entries: [string, string][] = [];
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim();
    if (!name) {
      throw new ConfigError(
        "Invalid header in SentryOptions.headers: empty header name."
      );
    }
    assertValidHeaderName(name, "SentryOptions.headers");
    entries.push([name, rawValue.trim()]);
  }
  overrideHeaders = entries;
}

/**
 * Check whether the current target is a self-hosted Sentry instance.
 *
 * Self-hosted = `SENTRY_HOST` or `SENTRY_URL` is set to a non-SaaS URL.
 * Returns false if no custom URL is configured (implying SaaS) or if the
 * configured URL points to `*.sentry.io`.
 */
function isSelfHosted(): boolean {
  const configured = getConfiguredSentryUrl();
  if (!configured) {
    return false;
  }
  return !isSentrySaasUrl(configured);
}

/**
 * Resolve the raw custom headers string from env var or SQLite defaults.
 *
 * Priority: `SENTRY_CUSTOM_HEADERS` env var > `defaults.headers` in SQLite.
 * Returns undefined when no headers are configured.
 */
function resolveRawHeaders(): string | undefined {
  const envValue = getEnv().SENTRY_CUSTOM_HEADERS;
  if (envValue?.trim()) {
    return envValue.trim();
  }

  const dbValue = getDefaultHeaders();
  if (dbValue?.trim()) {
    return dbValue.trim();
  }

  return;
}

/** Self-hosted guard: warn once and report false on SaaS. */
function passesSelfHostedGuard(): boolean {
  if (isSelfHosted()) {
    return true;
  }
  if (!saasWarningLogged) {
    saasWarningLogged = true;
    log.warn(
      "Custom headers are set but no self-hosted Sentry instance is configured. Headers will be ignored."
    );
  }
  return false;
}

/**
 * Get the parsed custom headers for the current session.
 *
 * Returns an empty array when:
 * - No custom headers are configured (env var or defaults)
 * - The target is not a self-hosted instance (warns once if headers are set)
 *
 * Parsed results are cached; the self-hosted guard is re-evaluated per call
 * because `SENTRY_HOST` can be set dynamically by URL argument parsing.
 */
export function getCustomHeaders(): readonly [string, string][] {
  if (overrideHeaders !== undefined) {
    return overrideHeaders.length > 0 && passesSelfHostedGuard()
      ? overrideHeaders
      : [];
  }

  const raw = resolveRawHeaders();
  if (!raw) {
    return [];
  }

  if (!passesSelfHostedGuard()) {
    return [];
  }

  // Return cached result if the raw source hasn't changed
  if (cachedHeaders !== undefined && cachedRawSource === raw) {
    return cachedHeaders;
  }

  cachedHeaders = parseCustomHeaders(raw);
  cachedRawSource = raw;
  return cachedHeaders;
}

/**
 * Apply custom headers to a `Headers` instance, scoped to a request URL.
 *
 * Reads from the env var or SQLite defaults, validates, and sets each header,
 * but ONLY when `requestUrl`'s origin matches the active token's trust class
 * (or, in the no-token bootstrap window, the explicit `--url` login anchor).
 * This prevents `SENTRY_CUSTOM_HEADERS` (IAP tokens, mTLS headers) from
 * leaking to a host the user didn't authenticate against.
 *
 * Fails closed when no token and no login anchor are present — see
 * {@link isRequestOriginTrustedForCustomHeaders}.
 *
 * @param headers - The `Headers` instance to modify in-place
 * @param requestUrl - The destination URL whose origin is checked
 */
export function applyCustomHeaders(
  headers: Headers,
  requestUrl: string | URL | Request
): void {
  const customHeaders = getCustomHeaders();
  if (customHeaders.length === 0) {
    return;
  }

  if (!isRequestOriginTrustedForCustomHeaders(requestUrl)) {
    if (!untrustedDestinationWarningLogged) {
      untrustedDestinationWarningLogged = true;
      log.warn(
        "Skipping custom headers for request to untrusted host. " +
          "If this is legitimate, run 'sentry auth login --url <url>' against the intended instance."
      );
    }
    return;
  }

  for (const [name, value] of customHeaders) {
    headers.set(name, value);
  }
}

/**
 * Reset module-level caches. Exported for testing only.
 * @internal
 */
export function _resetCustomHeadersCache(): void {
  cachedHeaders = undefined;
  cachedRawSource = undefined;
  overrideHeaders = undefined;
  saasWarningLogged = false;
  untrustedDestinationWarningLogged = false;
}
