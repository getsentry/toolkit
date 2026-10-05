/**
 * API Client Infrastructure
 *
 * Shared helpers, types, constants, and raw request functions used by
 * all domain-specific API modules. This is the foundation layer that
 * other modules in `src/lib/api/` import from.
 */

import { promisify } from "node:util";
import { zstdCompress as zstdCompressCb } from "node:zlib";
import { parseSentryLinkHeader } from "@sentry/api";
// biome-ignore lint/performance/noNamespaceImport: Sentry SDK recommends namespace import
import * as Sentry from "@sentry/node-core/light";
import { type GenericSchema, safeParse } from "valibot";

import { extractRequiredScopes } from "../api-scope.js";
import { getActiveEnvVarName, isEnvTokenActive } from "../db/auth.js";
import { getEnv } from "../env.js";
import { ApiError, AuthError, stringifyUnknown } from "../errors.js";
import { logger } from "../logger.js";
import { resolveOrgRegion } from "../region.js";
import {
  getApiBaseUrl,
  getDefaultSdkConfig,
  getSdkConfig,
} from "../sentry-client.js";

/**
 * Enrich a 403 Forbidden error detail with actionable guidance.
 *
 * "Your organization has disabled this feature for members" is an org-level
 * policy (Organization.flags.disable_member_project_creation), not a token
 * scope or auth problem. We return targeted guidance and skip the generic
 * scope/re-auth enrichment entirely — suggesting re-authentication for this
 * error would be actively wrong and has caused user confusion (CLI-SERVER-E).
 *
 * All other 403s fall through to the existing logic:
 * - env-var tokens → suggest checking token scopes
 * - OAuth tokens → suggest re-authentication
 */
function enrich403Detail(rawDetail: string | undefined): string {
  // Org-level policy — re-auth and token scope advice do not apply here.
  if (rawDetail?.includes("disabled this feature")) {
    return [
      rawDetail,
      "",
      "This is an org-level policy setting, not an auth issue.",
      "You need org:admin/manager/owner role, or team:admin role on the team.",
    ].join("\n  ");
  }

  const lines: string[] = [];
  if (rawDetail) {
    lines.push(rawDetail, "");
  }

  const scopes = extractRequiredScopes(rawDetail);

  if (isEnvTokenActive()) {
    if (scopes.length > 0) {
      lines.push(
        `Your ${getActiveEnvVarName()} token is missing the required scope(s) '${scopes.join("', '")}'.`
      );
    } else {
      lines.push(
        `Your ${getActiveEnvVarName()} token may lack the required scope for this operation.`
      );
    }
    lines.push(
      "Check token scopes at: https://sentry.io/settings/account/api/auth-tokens/"
    );
  } else if (scopes.length > 0) {
    const scopeArgs = scopes.map((s) => `--scope ${s}`).join(" ");
    lines.push(
      `Your token is missing the required scope(s) '${scopes.join("', '")}'.`,
      `Re-authenticate with: sentry auth refresh ${scopeArgs}`
    );
  } else {
    lines.push(
      "You may not have access to this resource.",
      "Re-authenticate with: sentry auth login"
    );
  }
  return lines.join("\n  ");
}

/**
 * Enrich a 401 Unauthorized error detail with actionable guidance.
 *
 * 401 means the token is missing, invalid, or expired — the identity cannot
 * be determined at all. Distinct from 403 (identity known, lacks permission).
 * Scope hints do not apply; the fix is always to re-authenticate or regenerate
 * the token.
 *
 * The Sentry API returns distinct `detail` strings we can branch on:
 * `"Token expired"` when the token is past its expiry date, `"Invalid token"`
 * when it is not found or malformed. We use this to give a more precise message
 * for env-var token users.
 *
 * For OAuth users the token lifecycle is transparent — `sentry-client.ts`
 * intercepts 401s and refreshes automatically. A 401 that reaches this function
 * means refresh failed and the user needs to re-authenticate via the browser.
 *
 * @see https://github.com/getsentry/sentry/blob/934f1473f198a62f9268d7140b80cd9ca1e59bb9/src/sentry/api/authentication.py#L536-L539
 */
export function enrich401Detail(rawDetail: string | undefined): string {
  // Seat-limit lockout, not an auth failure. Sentry returns 401 with
  // `code: member-disabled-over-limit` when the org is over its member limit
  // and the caller's seat is disabled — re-authenticating cannot fix this.
  if (rawDetail?.includes("member-disabled-over-limit")) {
    return [
      "Your account is disabled in this organization because it is over its member limit.",
      "This is a billing/seat-limit issue, not an auth problem — re-authenticating won't help.",
      "Ask an org owner to upgrade the plan or free up a seat, then retry.",
      "Or target a different org, e.g.:  sentry init my-other-org/",
    ].join("\n  ");
  }

  const lines: string[] = [];
  if (rawDetail) {
    lines.push(rawDetail, "");
  }
  if (isEnvTokenActive()) {
    const expired = rawDetail?.toLowerCase().includes("expired");
    lines.push(
      `Your ${getActiveEnvVarName()} token ${expired ? "has expired" : "is not recognized or has been revoked"}.`,
      "Create a new token at: https://sentry.io/settings/account/api/auth-tokens/"
    );
  } else {
    lines.push(
      "Not authenticated or your session has expired.",
      "Re-authenticate with: sentry auth login"
    );
  }
  return lines.join("\n  ");
}

/**
 * Select and apply status-specific detail enrichment.
 *
 * Extracted from {@link throwApiError} and {@link throwRawApiError} to keep
 * their cognitive complexity within the linter limit. 403 and 401 get
 * actionable guidance; all other statuses pass the raw detail through.
 *
 * `hasUsableDetail` controls whether the raw detail string is forwarded to
 * the enrichment functions — passing `undefined` when false lets them render
 * without a noisy `{"detail":null}` prefix.
 */
function enrichDetail(
  status: number,
  detail: string | undefined,
  hasUsableDetail: boolean
): string | undefined {
  if (status === 403) {
    return enrich403Detail(hasUsableDetail ? detail : undefined);
  }
  if (status === 401) {
    return enrich401Detail(hasUsableDetail ? detail : undefined);
  }
  return detail;
}

/**
 * Parse Sentry's RFC 5988 Link response header to extract pagination cursors.
 *
 * Sentry Link header format:
 * `<url>; rel="next"; results="true"; cursor="1735689600000:0:0"`
 *
 * Thin alias over `@sentry/api`'s `parseSentryLinkHeader` — the SDK ships the
 * canonical parser. We keep the `parseLinkHeader` name because multiple call
 * sites import it under that name from the `api-client` barrel and because
 * `unwrapPaginatedResult` below needs a local binding.
 */
export const parseLinkHeader = parseSentryLinkHeader;

/** zstd body compressor, or null when the runtime lacks zstd support. */
const zstdCompressAsync =
  typeof zstdCompressCb === "function" ? promisify(zstdCompressCb) : null;

/** Options for raw API requests to Sentry endpoints. */
export type ApiRequestOptions<T = unknown> = {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  body?: unknown;
  /**
   * Compress the JSON body with zstd and send `Content-Encoding: zstd`. Useful
   * for large bodies (e.g. a snapshot manifest). Silently falls back to plain
   * JSON when the runtime lacks zstd support.
   */
  bodyEncoding?: "zstd";
  /** Query parameters. String arrays create repeated keys (e.g., tags=1&tags=2) */
  params?: Record<string, string | number | boolean | string[] | undefined>;
  /** Optional valibot schema for runtime validation of response data */
  schema?: GenericSchema<unknown, T>;
};

/**
 * Throw an ApiError from a failed @sentry/api SDK response.
 *
 * @param error - The error object from the SDK (contains status code and detail)
 * @param response - The raw Response object
 * @param context - Human-readable context for the error message
 */
export function throwApiError(
  error: unknown,
  response: Response | undefined,
  context: string
): never {
  // Network-level failure: no HTTP response received (DNS, timeout, ECONNREFUSED, etc.)
  if (!response) {
    const cause =
      error instanceof Error ? error.message : stringifyUnknown(error);
    throw new ApiError(
      `${context}: Network error`,
      0,
      `Unable to reach Sentry API. Cause: ${cause}\n\n  Check your internet connection and try again.`
    );
  }

  const status = response.status;
  const rawDetail =
    error && typeof error === "object" && "detail" in error
      ? (error as { detail: unknown }).detail
      : undefined;
  const hasUsableDetail = rawDetail !== null && rawDetail !== undefined;
  // Enrichment functions (enrich403Detail, enrich401Detail) render better
  // when rawDetail is undefined — they stand alone without a noisy `{}`
  // prefix. For all other statuses, stringify the full error as a debug aid.
  const detail = hasUsableDetail
    ? stringifyUnknown(rawDetail)
    : stringifyUnknown(error);

  const is403 = status === 403;
  throw new ApiError(
    `${context}: ${status} ${response.statusText ?? "Unknown"}`,
    status,
    enrichDetail(status, detail, hasUsableDetail),
    undefined,
    is403
  );
}

/**
 * Unwrap an @sentry/api SDK result, throwing ApiError on failure.
 *
 * When `throwOnError` is false (our default), the SDK catches errors from
 * the fetch function and returns them in `{ error }`. This includes our
 * AuthError from refreshToken(). We must re-throw known error types (AuthError,
 * ApiError) directly so callers can distinguish auth failures from API errors.
 *
 * @param result - The result from an SDK function call
 * @param context - Human-readable context for error messages
 * @returns The data from the successful response
 */
export function unwrapResult<T>(
  result:
    | { data: unknown; error: undefined }
    | { data: undefined; error: unknown },
  context: string
): T {
  const { data, error } = result as {
    data: unknown;
    error: unknown;
    response?: Response;
  };

  if (error !== undefined) {
    // Preserve known error types that were caught by the SDK from our fetch function
    if (error instanceof AuthError || error instanceof ApiError) {
      throw error;
    }
    // The @sentry/api SDK always includes `response` on the returned object in
    // the default "fields" responseStyle (see createClient request() in the SDK
    // source — it spreads `{ request, response }` into every return value).
    // The cast is typed as optional only because the SDK's TypeScript types omit
    // `response` from the return type, not because it can be absent at runtime.
    const response = (result as { response?: Response }).response;
    throwApiError(error, response, context);
  }

  return data as T;
}

/**
 * Unwrap an @sentry/api SDK result AND extract pagination from the Link header.
 *
 * Unlike {@link unwrapResult} which discards the Response, this preserves the
 * Link header for cursor-based pagination. Use for SDK-backed paginated endpoints.
 *
 * @param result - The result from an SDK function call (includes `response`)
 * @param context - Human-readable context for error messages
 * @returns Data and optional next-page cursor
 */
export function unwrapPaginatedResult<T>(
  result:
    | { data: unknown; error: undefined }
    | { data: undefined; error: unknown },
  context: string
): PaginatedResponse<T> {
  const response = (result as { response?: Response }).response;
  const data = unwrapResult<T>(result, context);
  const { nextCursor, prevCursor } = parseLinkHeader(
    response?.headers.get("link") ?? null
  );
  const out: PaginatedResponse<T> = { data };
  if (nextCursor !== undefined) {
    out.nextCursor = nextCursor;
  }
  if (prevCursor !== undefined) {
    out.prevCursor = prevCursor;
  }
  return out;
}

/**
 * Build URLSearchParams from an options object, filtering out undefined values.
 * Supports string arrays for repeated keys (e.g., { tags: ["a", "b"] } → tags=a&tags=b).
 *
 * @param params - Key-value pairs to convert to search params
 * @returns URLSearchParams instance, or undefined if no valid params
 * @internal Exported for testing
 */
export function buildSearchParams(
  params?: Record<string, string | number | boolean | string[] | undefined>
): URLSearchParams | undefined {
  if (!params) {
    return;
  }

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        searchParams.append(key, item);
      }
    } else {
      searchParams.set(key, String(value));
    }
  }

  return searchParams.toString() ? searchParams : undefined;
}

/**
 * Append query parameters without replacing an endpoint's existing query.
 *
 * @param endpoint - API endpoint, optionally with a query string
 * @param params - Additional query parameters
 * @returns Endpoint containing both existing and additional parameters
 */
export function appendSearchParams(
  endpoint: string,
  params?: ApiRequestOptions["params"]
): string {
  const searchParams = buildSearchParams(params);
  if (!searchParams) {
    return endpoint;
  }
  let separator = "?";
  if (endpoint.includes("?")) {
    separator = endpoint.endsWith("?") || endpoint.endsWith("&") ? "" : "&";
  }
  return `${endpoint}${separator}${searchParams.toString()}`;
}

/**
 * Get SDK config for an organization's region.
 * Resolves the org's region URL and returns the config.
 */
export async function getOrgSdkConfig(orgSlug: string) {
  const regionUrl = await resolveOrgRegion(orgSlug);
  return getSdkConfig(regionUrl);
}

/**
 * Maximum number of pages to follow when auto-paginating.
 *
 * Safety limit to prevent runaway pagination when the API returns an unexpectedly
 * large number of pages. At API_MAX_PER_PAGE items/page this allows up to 5,000 items, which
 * covers even the largest organizations. Override with SENTRY_MAX_PAGINATION_PAGES
 * env var for edge cases.
 */
export const MAX_PAGINATION_PAGES = Math.max(
  1,
  Number(getEnv().SENTRY_MAX_PAGINATION_PAGES) || 50
);

/**
 * Sentry API's maximum items per page.
 * Some endpoints silently cap larger `per_page` values; others (org project
 * list) return 400. Always send at most this many and auto-paginate for
 * larger `--limit`s via {@link paginate}.
 */
export const API_MAX_PER_PAGE = 100;

/**
 * Maximum concurrent API requests when fanning out across organizations or regions.
 *
 * Limits parallel calls (e.g., `getProject()` per org, `resolveEventInOrg()` per org,
 * DSN key search per region) to prevent overwhelming the API for enterprise users
 * with many organizations. For typical users with 1-5 orgs this has no effect.
 */
export const ORG_FANOUT_CONCURRENCY = 5;

/**
 * Paginated API response with cursor metadata.
 * More pages exist when `nextCursor` is defined.
 */
export type PaginatedResponse<T> = {
  /** The response data */
  data: T;
  /** Cursor for fetching the next page (undefined if no more pages) */
  nextCursor?: string;
  /** Cursor for the previous page (undefined on the first page) */
  prevCursor?: string;
};

/**
 * Auto-paginate across multiple API pages, accumulating results up to `limit`.
 *
 * Calls `fetchPage` repeatedly until enough rows are collected or pages are
 * exhausted. Caps at {@link MAX_PAGINATION_PAGES} to prevent runaway loops.
 *
 * The caller is responsible for baking `perPage` into the `fetchPage` closure
 * (typically `Math.min(limit, API_MAX_PER_PAGE)`). This helper only manages
 * cursor chaining and row accumulation.
 *
 * @param fetchPage - Async function that fetches a single page given a cursor
 * @param limit - Total number of items to collect
 * @param initialCursor - Optional starting cursor
 * @returns Accumulated items with optional nextCursor from the last page
 */
export async function autoPaginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<PaginatedResponse<T[]>>,
  limit: number,
  initialCursor?: string
): Promise<PaginatedResponse<T[]>> {
  // Fast path: single-page fetch when limit fits in one API page
  if (limit <= API_MAX_PER_PAGE) {
    return fetchPage(initialCursor);
  }

  // Multi-page: accumulate rows across pages up to the requested limit
  const allRows: T[] = [];
  let cursor: string | undefined = initialCursor;

  for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
    const result = await fetchPage(cursor);
    allRows.push(...result.data);

    if (allRows.length >= limit || !result.nextCursor) {
      // Overshot — trim and drop nextCursor (cursor would skip items)
      if (allRows.length > limit) {
        return { data: allRows.slice(0, limit) };
      }
      return { data: allRows, nextCursor: result.nextCursor };
    }

    cursor = result.nextCursor;
  }

  // Safety limit reached — warn and return what we have, no nextCursor
  logger.warn(
    `Pagination limit reached (${MAX_PAGINATION_PAGES} pages, ${allRows.length} items). ` +
      "Results may be incomplete."
  );
  return { data: allRows.slice(0, limit) };
}

/**
 * Wire a single-page fetcher into a limit-bounded, auto-paginating list call.
 *
 * Centralizes the two things every list endpoint kept re-deriving by hand and
 * occasionally got wrong (see #1458): capping `per_page` at
 * {@link API_MAX_PER_PAGE} and threading `limit` plus the initial cursor into
 * {@link autoPaginate}. Each request asks only for the remaining item budget,
 * so a partial final page can return a cursor without skipping trimmed rows.
 * Callers still own region resolution and
 * endpoint-specific query building inside `fetchPage`.
 *
 * @param options - Caller list options; `limit` bounds total rows, `cursor` is the start cursor
 * @param fetchPage - Fetches one page given the capped `perPage` and a page cursor
 * @param defaultLimit - Applied when `options.limit` is undefined
 * @returns Accumulated items with optional nextCursor
 */
export function paginate<T>(
  options: { limit?: number; cursor?: string },
  fetchPage: (
    perPage: number,
    cursor: string | undefined
  ) => Promise<PaginatedResponse<T[]>>,
  defaultLimit = 10
): Promise<PaginatedResponse<T[]>> {
  const limit = options.limit ?? defaultLimit;
  let remaining = limit;
  return autoPaginate(
    async (cursor) => {
      const result = await fetchPage(
        Math.min(remaining, API_MAX_PER_PAGE),
        cursor
      );
      remaining -= result.data.length;
      return result;
    },
    limit,
    options.cursor
  );
}

/**
 * Make an authenticated request to a specific Sentry region.
 * Returns both parsed response data and raw headers for pagination support.
 * Used for internal endpoints not covered by @sentry/api SDK functions.
 *
 * @param regionUrl - The region's base URL (e.g., https://us.sentry.io)
 * @param endpoint - API endpoint path (e.g., "/users/me/regions/")
 * @param options - Request options
 * @returns Parsed data and response headers
 */
export async function apiRequestToRegion<T>(
  regionUrl: string,
  endpoint: string,
  options: ApiRequestOptions<T> = {}
): Promise<{ data: T; headers: Headers }> {
  const { method = "GET", body, bodyEncoding, params, schema } = options;
  const config = getSdkConfig(regionUrl);

  const normalizedEndpoint = endpoint.startsWith("/")
    ? endpoint.slice(1)
    : endpoint;
  const endpointWithParams = appendSearchParams(normalizedEndpoint, params);
  // getSdkConfig.baseUrl is the plain region URL; add /api/0/ for raw requests
  const url = `${config.baseUrl}/api/0/${endpointWithParams}`;

  const fetchFn = config.fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  let requestBody: string | Uint8Array | undefined;
  if (body !== undefined) {
    const json = JSON.stringify(body);
    if (bodyEncoding === "zstd" && zstdCompressAsync) {
      requestBody = await zstdCompressAsync(Buffer.from(json));
      headers["Content-Encoding"] = "zstd";
    } else {
      requestBody = json;
    }
  }
  const response = await fetchFn(url, {
    method,
    headers,
    body: requestBody,
  });

  if (!response.ok) {
    await throwRawApiError(response, endpoint);
  }

  // 204 No Content / 205 Reset Content have no body by spec — calling
  // response.json() on them throws SyntaxError. Callers that expect a
  // body on success receive a clear ApiError here instead of crashing
  // downstream on `data.<field>`. Callers that expect 204 (e.g. the
  // bulk mutate endpoint returns 204 when no IDs match) should catch
  // this ApiError and handle it explicitly.
  if (response.status === 204 || response.status === 205) {
    throw new ApiError(
      `API returned ${response.status} ${response.statusText} (no body)`,
      response.status,
      "The server returned no content — the request may have matched no records.",
      endpoint
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (parseError) {
    logger.debug("Failed to parse JSON response body", parseError);
    throw new ApiError(
      `Invalid JSON in API response from ${endpoint}`,
      response.status,
      "The server returned a non-JSON response body (possible proxy or CDN issue).",
      endpoint
    );
  }

  if (schema) {
    const result = safeParse(schema, data);
    if (!result.success) {
      // Attach structured validation issues to the Sentry event so we can
      // diagnose exactly which field(s) failed validation — the ApiError.detail
      // string alone may not be visible in the Sentry issue overview.
      // Strip valibot issues to metadata only (path/type/message) before
      // attaching — full issues embed the raw failing `input` value.
      Sentry.setContext("schema_validation", {
        endpoint,
        status: response.status,
        issues: result.issues.slice(0, 10).map((i) => ({
          // Strip raw input from path items — only keep structural path keys.
          path: i.path?.map((p) => ({ key: p.key, type: p.type })),
          type: i.type,
          message: i.message,
        })),
      });
      throw new ApiError(
        `Unexpected response format from ${endpoint}`,
        response.status,
        result.issues.map((issue) => issue.message).join(", ")
      );
    }
    return { data: result.output, headers: response.headers };
  }

  return { data: data as T, headers: response.headers };
}

/**
 * Extract error detail from a failed HTTP response, attach diagnostic
 * headers to the Sentry scope, and throw an enriched {@link ApiError}.
 *
 * Extracted from `apiRequestToRegion` to keep the main function's
 * cognitive complexity under the lint threshold.
 */
async function throwRawApiError(
  response: Response,
  endpoint: string
): Promise<never> {
  let detail: string | undefined;
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { detail?: string };
      // Enriched statuses (403, 401) pass undefined when there is no
      // usable string detail so the enrichment renders without a noisy
      // `{"detail":null}` prefix. Other statuses get the full JSON as
      // a debug aid.
      if (typeof parsed.detail === "string") {
        detail = parsed.detail;
      } else if (response.status !== 403 && response.status !== 401) {
        detail = JSON.stringify(parsed);
      }
    } catch {
      detail = text || undefined;
    }
  } catch {
    detail = response.statusText;
  }
  // Attach a small allowlisted subset of response headers to the Sentry
  // event as context. This lets us distinguish Sentry-app 4xx/5xx (which
  // ship a `{"detail": "..."}` JSON body and `content-type: application/json`)
  // from CDN / WAF / edge 4xx (Cloudflare / proxy) that return empty or HTML
  // bodies — a gap that previously made empty-`detail` events like CLI-1AZ
  // impossible to triage without user-side repro.
  Sentry.setContext("api_response_headers", {
    "content-type": response.headers.get("content-type"),
    "content-length": response.headers.get("content-length"),
    server: response.headers.get("server"),
    "cf-ray": response.headers.get("cf-ray"),
    "x-sentry-error": response.headers.get("x-sentry-error"),
    "www-authenticate": response.headers.get("www-authenticate"),
  });
  const is403 = response.status === 403;
  throw new ApiError(
    `API request failed: ${response.status} ${response.statusText}`,
    response.status,
    enrichDetail(response.status, detail, detail !== undefined),
    endpoint,
    is403
  );
}

/**
 * Make an authenticated request to a Sentry region where success has no JSON body
 * (e.g. DELETE returning 204 No Content, or 202 Accepted with an empty body).
 */
export async function apiRequestToRegionNoContent(
  regionUrl: string,
  endpoint: string,
  options: Omit<ApiRequestOptions, "schema"> = {}
): Promise<void> {
  const { method = "GET", body, params } = options;
  const config = getSdkConfig(regionUrl);

  const searchParams = buildSearchParams(params);
  const normalizedEndpoint = endpoint.startsWith("/")
    ? endpoint.slice(1)
    : endpoint;
  const queryString = searchParams ? `?${searchParams.toString()}` : "";
  const url = `${config.baseUrl}/api/0/${normalizedEndpoint}${queryString}`;

  const fetchFn = config.fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const response = await fetchFn(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    await throwRawApiError(response, endpoint);
  }

  if (response.status === 204 || response.status === 205) {
    return;
  }
  await response.text();
}

/**
 * Make an authenticated request to the default Sentry API.
 *
 * @param endpoint - API endpoint path (e.g., "/organizations/")
 * @param options - Request options including method, body, query params, and validation schema
 * @returns Parsed JSON response (validated if schema provided)
 * @throws {AuthError} When not authenticated
 * @throws {ApiError} On API errors
 */
export async function apiRequest<T>(
  endpoint: string,
  options: ApiRequestOptions<T> = {}
): Promise<T> {
  const { data } = await apiRequestToRegion<T>(
    getApiBaseUrl(),
    endpoint,
    options
  );
  return data;
}

/**
 * Whether a response Content-Type should be decoded as text.
 *
 * Allowlist of textual types — anything unknown defaults to binary-safe
 * handling so downloads (PNG attachments, minidumps, etc.) are not
 * corrupted by UTF-8 decoding. Empty/missing Content-Type stays textual
 * because most Sentry JSON endpoints omit or under-specify it.
 *
 * @param contentType - Raw Content-Type header value (may include params)
 * @returns true when the body should be read via `response.text()`
 */
export function isTextualContentType(contentType: string | null): boolean {
  if (!contentType) {
    return true;
  }
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType.length === 0) {
    return true;
  }
  if (mediaType.startsWith("text/")) {
    return true;
  }
  if (
    mediaType === "application/json" ||
    mediaType === "application/yaml" ||
    mediaType === "application/x-yaml" ||
    mediaType === "application/javascript" ||
    mediaType === "application/xml" ||
    mediaType === "application/xhtml+xml"
  ) {
    return true;
  }
  // Structured suffixes: application/problem+json, application/atom+xml, …
  if (mediaType.endsWith("+json") || mediaType.endsWith("+xml")) {
    return true;
  }
  return false;
}

/**
 * Make a raw API request that returns full response details.
 * Unlike apiRequest, this does not throw on non-2xx responses.
 * Used by the 'sentry api' command for direct API access.
 *
 * Response bodies are decoded as text only for textual Content-Types
 * ({@link isTextualContentType}). Non-textual bodies are returned as
 * `Uint8Array` so binary downloads stay byte-for-byte intact.
 *
 * @param endpoint - API endpoint path (e.g., "/organizations/")
 * @param options - Request options including method, body, params, custom headers, and optional trusted base URL
 * @returns Response status, status text, headers, and parsed body
 * @throws {AuthError} On authentication failure
 * @throws {HostScopeError} Before credentials are attached to an untrusted origin
 */
export async function rawApiRequest(
  endpoint: string,
  options: ApiRequestOptions & {
    headers?: Record<string, string>;
    /**
     * Sentry instance or regional base URL. The authenticated fetch rejects
     * origins outside the active token's trust scope before adding credentials.
     */
    baseUrl?: string;
  } = {}
): Promise<{
  status: number;
  statusText: string;
  headers: Headers;
  body: unknown;
}> {
  const {
    method = "GET",
    body,
    params,
    headers: customHeaders = {},
    baseUrl,
  } = options;

  // Both configs share createAuthenticatedFetch(), whose prepareHeaders()
  // enforces isRequestOriginTrusted() before attaching Authorization.
  const config = baseUrl ? getSdkConfig(baseUrl) : getDefaultSdkConfig();

  const normalizedEndpoint = endpoint.startsWith("/")
    ? endpoint.slice(1)
    : endpoint;
  const endpointWithParams = appendSearchParams(normalizedEndpoint, params);
  // getSdkConfig.baseUrl is the plain region URL; add /api/0/ for raw requests
  const url = `${config.baseUrl}/api/0/${endpointWithParams}`;

  // Build request headers and body.
  // String bodies: no Content-Type unless the caller explicitly provides one.
  // Object bodies: application/json (auto-stringified).
  const isStringBody = typeof body === "string";
  const hasContentType = Object.keys(customHeaders).some(
    (k) => k.toLowerCase() === "content-type"
  );

  const headers: Record<string, string> = { ...customHeaders };
  if (!(isStringBody || hasContentType) && body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let requestBody: string | undefined;
  if (body !== undefined) {
    requestBody = isStringBody ? body : JSON.stringify(body);
  }

  const fetchFn = config.fetch;
  const response = await fetchFn(url, {
    method,
    headers,
    body: requestBody,
  });

  const contentType = response.headers.get("content-type");
  let responseBody: unknown;
  if (isTextualContentType(contentType)) {
    // Textual path: UTF-8 decode, then try JSON.parse (unchanged behavior).
    const text = await response.text();
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = text;
    }
  } else {
    // Binary path: preserve raw bytes. Do not call response.text() — that
    // UTF-8-decodes with replacement (U+FFFD → EF BF BD) and permanently
    // corrupts non-UTF-8 payloads such as PNG attachments.
    responseBody = new Uint8Array(await response.arrayBuffer());
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: responseBody,
  };
}
