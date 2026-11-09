/**
 * API Client Infrastructure
 *
 * Shared helpers, types, constants, and raw request functions used by
 * all domain-specific API modules. This is the foundation layer that
 * other modules in `src/lib/api/` import from.
 */

import {
  type BaseUrlRequest,
  createSentryClient,
  parseSentryLinkHeader,
  type SdkResult,
  SentryApiError,
} from "@sentry/api";
import {
  API_MAX_PER_PAGE,
  buildSentryApiUrl,
  decodePageCursor as decodeCursorPosition,
  fetchAllPages as fetchEveryPage,
  type FetchAllPagesFailure,
  type CursorPosition,
  paginate as paginateFrom,
  readErrorResponse,
} from "@sentry/api/client";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- Sentry SDK recommends namespace import
import * as Sentry from "@sentry/node";
import { type GenericSchema, safeParse } from "valibot";

import { extractRequiredScopes } from "../api-scope.js";
import { getUrlLoginCommand, sentry } from "../app-identity.js";
import {
  type CredentialContext,
  getActiveEnvVarName,
  isEnvTokenActive,
} from "../db/auth.js";
import { getConfiguredSentryUrl } from "../constants.js";
import { getEnv } from "../env.js";
import {
  ApiError,
  CliError,
  type FunctionArgument,
  stringifyUnknown,
  TimeoutError,
} from "../errors.js";
import { logger } from "../logger.js";
import { resolveOrgRegion } from "../region.js";
import {
  getApiBaseUrl,
  getDefaultSdkConfig,
  getSdkConfig,
} from "../sentry-client.js";
import { getSdkClientConfig } from "../sentry-sdk-client.js";
import { isSentrySaasUrl } from "../sentry-urls.js";

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
        `Your ${getActiveEnvVarName()} token is missing the required scope(s) '${scopes.join("', '")}'.`,
      );
    } else {
      lines.push(
        `Your ${getActiveEnvVarName()} token may lack the required scope for this operation.`,
      );
    }
    lines.push(
      "Check token scopes at: https://sentry.io/settings/account/api/auth-tokens/",
    );
  } else if (scopes.length > 0) {
    const scopeArgs = scopes.map((s) => `--scope ${s}`).join(" ");
    lines.push(
      `Your token is missing the required scope(s) '${scopes.join("', '")}'.`,
      `Re-authenticate with: ${sentry`auth refresh ${scopeArgs}`}`,
    );
  } else {
    lines.push(
      "You may not have access to this resource.",
      `Re-authenticate with: ${sentry`auth login`}`,
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
function enrich401Detail(rawDetail: string | undefined): string {
  // Seat-limit lockout, not an auth failure. Sentry returns 401 with
  // `code: member-disabled-over-limit` when the org is over its member limit
  // and the caller's seat is disabled — re-authenticating cannot fix this.
  if (rawDetail?.includes("member-disabled-over-limit")) {
    return [
      "Your account is disabled in this organization because it is over its member limit.",
      "This is a billing/seat-limit issue, not an auth problem — re-authenticating won't help.",
      "Ask an org owner to upgrade the plan or free up a seat, then retry.",
      `Or target a different org, e.g.:  ${sentry`issue list my-other-org/`}`,
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
      "Create a new token at: https://sentry.io/settings/account/api/auth-tokens/",
    );
  } else {
    lines.push(
      "Not authenticated or your session has expired.",
      `Re-authenticate with: ${sentry`auth login`}`,
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
  hasUsableDetail: boolean,
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

/** Options for raw API requests to Sentry endpoints. */
export type ApiRequestOptions<T = unknown> = {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  body?: unknown;
  /** Query parameters. String arrays create repeated keys (e.g., tags=1&tags=2) */
  params?: Record<string, string | number | boolean | string[] | undefined>;
  /** Optional valibot schema for runtime validation of response data */
  schema?: GenericSchema<unknown, T>;
  /** Internal immutable credential for a multi-request operation. */
  credential?: CredentialContext;
  /** Manually validate each redirect before forwarding credentials. */
  validatedRedirects?: boolean;
  /**
   * Retry transient failures even for writes. Only for requests the server
   * dedupes (see `idempotent` in sentry-client.ts).
   */
  idempotent?: boolean;
};

/**
 * Structured fields of a JSON error body: its string `code` (e.g.
 * `invalid_search_query`) and the rejected `function` and `argument`, with an
 * optional `hint` (sent with `invalid_function_argument`).
 */
function readErrorFields(body: unknown): {
  code?: string;
  functionArgument?: FunctionArgument;
} {
  if (body === null || typeof body !== "object") {
    return {};
  }
  const fields = body as Record<string, unknown>;
  const code = typeof fields.code === "string" ? fields.code : undefined;
  if (
    typeof fields.function !== "string" ||
    typeof fields.argument !== "string"
  ) {
    return { code };
  }
  const functionArgument: FunctionArgument = {
    function: fields.function,
    argument: fields.argument,
  };
  if (typeof fields.hint === "string") {
    functionArgument.hint = fields.hint;
  }
  return { code, functionArgument };
}

const CONNECT_TIMEOUT_HINT =
  "The connection timed out. Check network access and firewall rules on this machine.";

/** Next steps for Node (undici) connection error codes, keyed by `code`. */
const NETWORK_CAUSE_HINTS: Record<string, string> = {
  ENOTFOUND:
    "The hostname could not be resolved. Check that the URL is right and that DNS works on this machine.",
  EAI_AGAIN:
    "DNS lookup failed temporarily. Check DNS on this machine and try again.",
  ECONNREFUSED:
    "The server refused the connection. Check that the URL and port are right and that Sentry is running.",
  ECONNRESET:
    "The connection was reset. A proxy or firewall may be interrupting the request; try again.",
  ETIMEDOUT: CONNECT_TIMEOUT_HINT,
  UND_ERR_CONNECT_TIMEOUT: CONNECT_TIMEOUT_HINT,
};

/** Max `cause` links to follow; undici nests at most a couple. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Find the innermost error behind a fetch failure.
 *
 * undici rejects with `TypeError: fetch failed` for every connection failure
 * and puts the real cause on `cause`: a system error with an errno `code`
 * (`ENOTFOUND`, `ECONNREFUSED`, ...) or a plain Error (`bad port`).
 */
function findNetworkCause(
  error: unknown,
): { message: string; code?: string } | undefined {
  let found: { message: string; code?: string } | undefined;
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!(current instanceof Error)) {
      break;
    }
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return { message: current.message, code };
    }
    found = { message: current.message };
    current = current.cause;
  }
  return found;
}

/**
 * Say where a self-hosted URL comes from, and how to point at another server.
 * SENTRY_HOST wins over SENTRY_URL (getConfiguredSentryUrl), then the login.
 */
function describeUrlSource(): string {
  if (getConfiguredSentryUrl()) {
    const urlVar = getEnv().SENTRY_HOST?.trim() ? "SENTRY_HOST" : "SENTRY_URL";
    return `This URL comes from ${urlVar}. If it is not your Sentry server, set ${urlVar} to the right URL.`;
  }
  return `This URL comes from your login. To use another server, run: ${getUrlLoginCommand()} <url>`;
}

/**
 * Build the user-facing detail for a request that got no HTTP response.
 *
 * Names the Sentry URL that was contacted, the underlying cause (not just
 * "fetch failed"), and next steps that match it.
 */
function buildNetworkErrorDetail(error: unknown): string {
  // Same resolution as request routing: env, then the stored login's host.
  const baseUrl = getApiBaseUrl();
  const networkCause = findNetworkCause(error);
  const cause =
    networkCause?.message ??
    (error instanceof Error ? error.message : stringifyUnknown(error));
  const causeHint = networkCause?.code
    ? NETWORK_CAUSE_HINTS[networkCause.code]
    : undefined;
  const steps = [causeHint ?? "Check your network connection and try again."];
  steps.push(
    isSentrySaasUrl(baseUrl)
      ? `Check Sentry's status with: ${sentry`status`}`
      : describeUrlSource(),
  );
  return [`Unable to reach Sentry at ${baseUrl}: ${cause}`, "", ...steps].join(
    "\n  ",
  );
}

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
  context: string,
): never {
  // Network-level failure: no HTTP response received (DNS, timeout, ECONNREFUSED, etc.)
  if (!response) {
    const apiError = new ApiError(
      `${context}: Network error`,
      0,
      buildNetworkErrorDetail(error),
    );
    // Keep the original error so error reporting can recognize a raw
    // `fetch failed` (user environment) behind this wrapper.
    apiError.cause = error;
    throw apiError;
  }

  if (error instanceof SentryApiError) {
    error = error.body;
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
    { enriched403: is403, ...readErrorFields(error) },
  );
}

/**
 * Unwrap an @sentry/api SDK result, throwing ApiError on failure.
 *
 * When `throwOnError` is false (our default), the SDK catches errors from
 * the fetch function and returns them in `{ error }`. This includes our
 * AuthError from refreshToken(). We must re-throw CLI errors (AuthError,
 * ApiError, TimeoutError, ...) directly so callers can distinguish auth
 * failures from API errors and users see the error's own guidance.
 *
 * @param result - The result from an SDK function call
 * @param context - Human-readable context for error messages
 * @returns The data from the successful response
 */
export function unwrapResult<T>(
  result: Pick<SdkResult, "data" | "error" | "response">,
  context: string,
): T {
  if ("error" in result) {
    const { error } = result;
    // Name the failed operation, like ApiError does, and keep the hint.
    if (error instanceof TimeoutError) {
      throw new TimeoutError(`${context}: ${error.message}`, error.hint);
    }
    // Preserve other CLI errors thrown by our fetch function (AuthError,
    // ApiError, HostScopeError, ...). They already carry the right message
    // and next step; wrapping them as "Network error" would hide both.
    if (error instanceof CliError) {
      throw error;
    }
    throwApiError(error, result.response, context);
  }

  return result.data as T;
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
  result: Pick<SdkResult, "data" | "error" | "response">,
  context: string,
): PaginatedResponse<T> {
  const { response } = result;
  const data = unwrapResult<T>(result, context);
  const { nextCursor, prevCursor } = parseLinkHeader(
    response?.headers.get("link") ?? null,
  );
  const out: PaginatedResponse<T> = { data };
  if (response) {
    out.response = response;
  }
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
  params?: Record<string, string | number | boolean | string[] | undefined>,
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
  params?: ApiRequestOptions["params"],
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
 * `resolveBaseUrl` for `@sentry/api` clients: a request whose path names an
 * organization goes to that organization's region, on the server of the
 * stored account that knows it ({@link resolveOrgRegion}). An explicit
 * server still limits the accounts. Unscoped paths keep the base URL.
 */
async function resolveOrgBaseUrl({
  baseUrl,
  scope,
}: BaseUrlRequest): Promise<string> {
  return scope ? await resolveOrgRegion(scope.organization) : baseUrl;
}

/**
 * SDK config that sends each request to the region of the organization its
 * path names ({@link resolveOrgBaseUrl}).
 */
export function getOrgSdkConfig(
  options: Parameters<typeof getSdkClientConfig>[1] = {},
) {
  return {
    ...getSdkClientConfig(getApiBaseUrl(), options),
    resolveBaseUrl: resolveOrgBaseUrl,
  };
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
  Number(getEnv().SENTRY_MAX_PAGINATION_PAGES) || 50,
);

/**
 * Sentry API's maximum items per page. Always send at most this many and
 * auto-paginate for larger `--limit`s via {@link paginate}.
 */
export { API_MAX_PER_PAGE };

export { consumeCursorPage, type CursorPosition } from "@sentry/api/client";

/** Decode a shared cursor, reporting unreadable legacy bookmarks through the CLI logger. */
export function decodePageCursor(raw: string | undefined): CursorPosition {
  return decodeCursorPosition(raw, (message) => logger.warn(message));
}

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
  /** Exact validated response, for provenance-sensitive callers. */
  response?: Response;
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
  initialCursor?: string,
): Promise<PaginatedResponse<T[]>> {
  // Fast path: single-page fetch when limit fits in one API page
  if (limit <= API_MAX_PER_PAGE) {
    return await fetchPage(initialCursor);
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
      "Results may be incomplete.",
  );
  return { data: allRows.slice(0, limit) };
}

/**
 * Fetch up to `limit` rows and a cursor that resumes after the last one.
 *
 * This is the only supported way to build a limit-bounded list; the
 * `sentry-cli/no-manual-pagination` lint rule rejects hand-written loops
 * (#1458, #1608). Page sizing and resume-safe cursors live in
 * `@sentry/api/client`, shared with the MCP; this wrapper sets
 * the CLI's page cap and default limit and logs the CLI's warnings.
 *
 * Callers own region resolution and query building inside `fetchPage`, and
 * must send `perPage` as the request's `per_page` unchanged.
 *
 * @param options - Caller list options; `limit` bounds total rows, `cursor` is the start cursor
 * @param fetchPage - Fetches one page given the page size and a server cursor
 * @param defaultLimit - Applied when `options.limit` is undefined
 * @returns Up to `limit` items with optional nextCursor
 */
export async function paginate<T>(
  options: { limit?: number; cursor?: string },
  fetchPage: (
    perPage: number,
    cursor: string | undefined,
  ) => Promise<PaginatedResponse<T[]>>,
  defaultLimit = 10,
): Promise<PaginatedResponse<T[]>> {
  const { data, nextCursor, stoppedAtPageCap } = await paginateFrom(
    {
      limit: options.limit ?? defaultLimit,
      cursor: options.cursor,
      maxPages: MAX_PAGINATION_PAGES,
      warn: (message) => logger.warn(message),
    },
    fetchPage,
  );
  if (stoppedAtPageCap) {
    logger.warn(
      `Pagination limit reached (${MAX_PAGINATION_PAGES} pages, ${data.length} items). ` +
        "Use the returned cursor to continue.",
    );
  }
  return nextCursor === undefined ? { data } : { data, nextCursor };
}

/** Error message for each way {@link fetchAllPages} can fail. */
const FETCH_ALL_PAGES_ERRORS: Record<
  FetchAllPagesFailure,
  (context: string) => string
> = {
  "invalid-page": (context) => `Unexpected response format when ${context}`,
  "repeated-cursor": (context) =>
    `Pagination repeated a cursor when ${context}`,
  "page-cap": (context) =>
    `Pagination exceeded ${MAX_PAGINATION_PAGES} pages when ${context}`,
};

/**
 * Fetch and validate every page of a list endpoint, or fail.
 *
 * Unlike {@link autoPaginate}, a partial result is an error: use this when a
 * missing page could hide the record a mutation depends on. Throws on an
 * invalid page, a repeated cursor, or more than {@link MAX_PAGINATION_PAGES}.
 *
 * @param fetchPage - Fetches one page given a cursor
 * @param schema - Validates each page's items
 * @param context - Operation for error messages, e.g. "listing issue integrations"
 * @returns All validated items, in page order
 */
export async function fetchAllPages<T>(
  fetchPage: (
    cursor: string | undefined,
  ) => Promise<PaginatedResponse<unknown>>,
  schema: GenericSchema<unknown, T[]>,
  context: string,
): Promise<T[]> {
  const result = await fetchEveryPage(
    fetchPage,
    (data) => {
      const parsed = safeParse(schema, data);
      return parsed.success ? parsed.output : undefined;
    },
    MAX_PAGINATION_PAGES,
  );
  if (!result.ok) {
    throw new ApiError(FETCH_ALL_PAGES_ERRORS[result.reason](context), 0);
  }
  return result.items;
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
  options: ApiRequestOptions<T> = {},
): Promise<{ data: T; headers: Headers }> {
  const {
    method = "GET",
    body,
    params,
    schema,
    credential,
    validatedRedirects,
    idempotent,
  } = options;
  const config = getSdkConfig(regionUrl, {
    credential,
    validatedRedirects,
    bufferResponseBody: true,
    idempotent,
  });

  const endpointWithParams = appendSearchParams(endpoint, params);
  const url = buildSentryApiUrl(config.baseUrl, endpointWithParams);

  const fetchFn = config.fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const response = await fetchFn(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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
      endpoint,
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
      endpoint,
    );
  }

  if (schema) {
    return {
      data: validateResponse(schema, data, endpoint, response.status),
      headers: response.headers,
    };
  }

  return { data: data as T, headers: response.headers };
}

/**
 * Validate a response body against the CLI's schema for it.
 *
 * Used for raw requests and for `@sentry/api` results whose generated type is
 * looser than what the CLI reads (e.g. untyped span records).
 *
 * @param schema - Valibot schema for the response body
 * @param data - Parsed response body
 * @param endpoint - API path, named in the error message
 * @param status - HTTP status of the response
 * @throws {ApiError} When the body does not match the schema
 */
export function validateResponse<T>(
  schema: GenericSchema<unknown, T>,
  data: unknown,
  endpoint: string,
  status: number,
): T {
  const result = safeParse(schema, data);
  if (!result.success) {
    // Attach structured validation issues to the Sentry event so we can
    // diagnose exactly which field(s) failed validation — the ApiError.detail
    // string alone may not be visible in the Sentry issue overview.
    // Strip valibot issues to metadata only (path/type/message) before
    // attaching — full issues embed the raw failing `input` value.
    Sentry.setContext("schema_validation", {
      endpoint,
      status,
      issues: result.issues.slice(0, 10).map((i) => ({
        // Strip raw input from path items — only keep structural path keys.
        path: i.path?.map((p) => ({ key: p.key, type: p.type })),
        type: i.type,
        message: i.message,
      })),
    });
    throw new ApiError(
      `Unexpected response format from ${endpoint}`,
      status,
      result.issues.map((issue) => issue.message).join(", "),
    );
  }
  return result.output;
}

/**
 * Unwrap an @sentry/api SDK result and validate its body with the CLI's schema.
 *
 * @param result - The result from an SDK function call
 * @param context - Human-readable context for HTTP error messages
 * @param schema - Valibot schema for the response body
 * @param endpoint - API path, named in schema-mismatch errors
 */
export function unwrapValidatedResult<T>(
  result: Pick<SdkResult, "data" | "error" | "response">,
  context: string,
  schema: GenericSchema<unknown, T>,
  endpoint: string,
): T {
  const data = unwrapResult<unknown>(result, context);
  return validateResponse(schema, data, endpoint, result.response?.status ?? 0);
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
  endpoint: string,
): Promise<never> {
  const body = await readErrorResponse(response);
  let detail: string | undefined;
  if (body.text === undefined) {
    detail = response.statusText;
  } else if (body.parseError !== undefined) {
    detail = body.text || undefined;
  } else if (body.detail !== undefined) {
    detail = body.detail;
  } else if (response.status !== 403 && response.status !== 401) {
    // Enriched statuses (403, 401) pass undefined when there is no
    // usable string detail so the enrichment renders without a noisy
    // `{"detail":null}` prefix. Other statuses get the full JSON as
    // a debug aid.
    detail = JSON.stringify(body.json);
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
    { enriched403: is403, ...readErrorFields(body.json) },
  );
}

/**
 * Make an authenticated request to a Sentry region where success has no JSON body
 * (e.g. DELETE returning 204 No Content, or 202 Accepted with an empty body).
 */
export async function apiRequestToRegionNoContent(
  regionUrl: string,
  endpoint: string,
  options: Omit<ApiRequestOptions, "schema"> = {},
): Promise<void> {
  const { method = "GET", body, params } = options;
  const config = getSdkConfig(regionUrl, { bufferResponseBody: true });

  const searchParams = buildSearchParams(params);
  const queryString = searchParams ? `?${searchParams.toString()}` : "";
  const url = buildSentryApiUrl(config.baseUrl, `${endpoint}${queryString}`);

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
  options: ApiRequestOptions<T> = {},
): Promise<T> {
  const { data } = await apiRequestToRegion<T>(
    getApiBaseUrl(),
    endpoint,
    options,
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

/** Options for a raw request, retaining the CLI's transport and body policies. */
type RawApiRequestOptions = ApiRequestOptions & {
  /** Explicit caller headers, before authentication and proxy headers. */
  headers?: Record<string, string>;
  /** Caller-selected Sentry origin or instance prefix, checked at dispatch. */
  baseUrl?: string;
};

/** A request snapshot and the CLI transport that will authenticate it. */
export type PreparedRawApiRequest = {
  /** SDK-prepared URL, headers, method and body; single-use when sent. */
  request: Request;
  /** Authenticated transport, including raw response buffering and host checks. */
  fetch: ReturnType<typeof getSdkConfig>["fetch"];
};

/**
 * Prepare a raw request without sending it or refreshing credentials; an
 * org-scoped path may look up the organization's region first.
 * Existing params retain append semantics; query overrides use the SDK's
 * replacement semantics for decoded page cursors and page sizes.
 */
export async function prepareRawApiRequest(
  endpoint: string,
  options: RawApiRequestOptions = {},
  query?: Record<string, unknown>,
): Promise<PreparedRawApiRequest> {
  const { method = "GET", body, params, headers, baseUrl } = options;
  // A full URL keeps the request on its server; otherwise the path's
  // organization picks the account, server, and region.
  const config = baseUrl
    ? getSdkConfig(baseUrl, { bufferResponseBody: true })
    : {
        ...getDefaultSdkConfig({ bufferResponseBody: true }),
        resolveBaseUrl: resolveOrgBaseUrl,
      };
  const isStringBody = typeof body === "string";
  const request = await createSentryClient(config).client.prepareRequest({
    method,
    url: buildSentryApiUrl("", appendSearchParams(endpoint, params)),
    query,
    body,
    headers: isStringBody ? { "Content-Type": null, ...headers } : headers,
    ...(isStringBody ? { bodySerializer: null } : {}),
  });
  // Raw requests honor an explicit Content-Type even without a body; the SDK
  // otherwise removes it for bodyless operations and empty serialized bodies.
  const contentType = new Headers(headers).get("content-type");
  if (contentType !== null) {
    request.headers.set("content-type", contentType);
  }
  return { request, fetch: config.fetch };
}

/**
 * Send a prepared or endpoint-based raw request and return full response details.
 * Unlike apiRequest, this does not throw on non-2xx responses.
 * Used by the 'sentry api' command for direct API access.
 *
 * Response bodies are decoded as text only for textual Content-Types
 * ({@link isTextualContentType}). Non-textual bodies are returned as
 * `Uint8Array` so binary downloads stay byte-for-byte intact.
 *
 * @param endpoint - API endpoint path or the prepared request used for its preview
 * @param options - Options used when preparing an endpoint-based request
 * @returns Response status, status text, headers, and parsed body
 * @throws {AuthError} On authentication failure
 * @throws {HostScopeError} Before credentials are attached to an untrusted origin
 */
export async function rawApiRequest(
  endpoint: string | PreparedRawApiRequest,
  options: RawApiRequestOptions = {},
): Promise<{
  status: number;
  statusText: string;
  headers: Headers;
  body: unknown;
}> {
  const prepared =
    typeof endpoint === "string"
      ? await prepareRawApiRequest(endpoint, options)
      : endpoint;
  const response = await prepared.fetch(prepared.request);

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
