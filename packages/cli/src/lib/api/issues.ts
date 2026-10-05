/**
 * Issue API functions
 *
 * Functions for listing, retrieving, and updating Sentry issues.
 */

import type { ListOrganizationIssuesData } from "@sentry/api";
import { listOrganizationIssues } from "@sentry/api";

import type { SentryIssue } from "../../types/index.js";
import type { IssueSubstatus } from "../../types/sentry.js";
import {
  buildTlsErrorDetail,
  customFetch,
  isTlsCertError,
  warnIfSaasWithEnvCa,
} from "../custom-ca.js";
import { applyCustomHeaders } from "../custom-headers.js";
import { ApiError, ValidationError } from "../errors.js";
import { resolveOrgRegion } from "../region.js";
import { invalidateCachedResponsesMatching } from "../response-cache.js";
import { getApiBaseUrl } from "../sentry-client.js";

import {
  API_MAX_PER_PAGE,
  apiRequest,
  apiRequestToRegion,
  getOrgSdkConfig,
  MAX_PAGINATION_PAGES,
  type PaginatedResponse,
  unwrapPaginatedResult,
} from "./infrastructure.js";

const TRAILING_SLASH_RE = /\/$/;

/**
 * Sort options for issue listing, derived from the @sentry/api SDK types.
 * Uses the SDK type directly for compile-time safety against parameter drift.
 */
export type IssueSort = NonNullable<
  NonNullable<ListOrganizationIssuesData["query"]>["sort"]
>;

/**
 * Collapse options for issue listing, derived from the @sentry/api SDK types.
 * Each value tells the server to skip computing that data field, avoiding
 * expensive Snuba/ClickHouse queries on the backend.
 *
 * - `'stats'` — time-series event counts (sparkline data)
 * - `'lifetime'` — lifetime aggregate sub-object AND top-level count/userCount/firstSeen/lastSeen on list endpoints
 * - `'filtered'` — filtered aggregate counts
 * - `'unhandled'` — unhandled event flag computation
 * - `'base'` — base group fields (rarely useful to collapse)
 */
export type IssueCollapseField = NonNullable<
  NonNullable<ListOrganizationIssuesData["query"]>["collapse"]
>[number];

/**
 * Build the `collapse` parameter for issue list API calls.
 *
 * Always collapses `filtered` and `unhandled` — the CLI never consumes
 * these in issue list views. Conditionally collapses `stats` when the caller
 * confirms seen-stats fields aren't needed, and `lifetime` when the caller
 * confirms lifetime-dependent fields aren't needed.
 *
 * **Important:** `collapse=stats` skips Snuba seen-stats queries entirely,
 * stripping top-level `count`, `userCount`, `firstSeen`, `lastSeen` and the
 * sparkline `stats` object — not just the time-series. See #1219.
 *
 * **Important:** Despite being documented as removing only the `lifetime`
 * sub-object, `collapse=lifetime` also strips the top-level `count`,
 * `userCount`, `firstSeen`, and `lastSeen` fields from list responses.
 * Only collapse it when those fields are confirmed unnecessary. See #969.
 *
 * @param options - Context for determining what to collapse
 * @param options.shouldCollapseStats - Whether stats data can be skipped
 *   (true only when `--json --fields` omits all seen-stats-dependent fields)
 * @param options.shouldCollapseLifetime - Whether lifetime data can be skipped.
 *   Defaults to `false` because most output paths need `count`/`userCount`/
 *   `firstSeen`/`lastSeen`. Only set to `true` when `--json --fields` omits
 *   all lifetime-dependent fields.
 * @returns Array of fields to collapse
 */
export function buildIssueListCollapse(options: {
  shouldCollapseStats: boolean;
  shouldCollapseLifetime?: boolean;
}): IssueCollapseField[] {
  const collapse: IssueCollapseField[] = ["filtered", "unhandled"];
  if (options.shouldCollapseLifetime) {
    collapse.push("lifetime");
  }
  if (options.shouldCollapseStats) {
    collapse.push("stats");
  }
  return collapse;
}

/**
 * Collapse fields for single-issue detail endpoints.
 *
 * The CLI never displays stats (sparkline time-series), lifetime (aggregate
 * sub-object), filtered (filtered counts), or unhandled (unhandled sub-object)
 * in detail views (`issue view`, `issue explain`, `issue plan`).
 * Collapsing these skips expensive Snuba queries, saving 100-300ms per request.
 *
 * Note: On the **list** endpoint, `collapse=lifetime` strips top-level
 * `count`, `userCount`, `firstSeen`, `lastSeen` (see #969). The detail
 * endpoint preserves these fields regardless of collapse — safe to include
 * `lifetime` here.
 */
export const ISSUE_DETAIL_COLLAPSE: IssueCollapseField[] = [
  "stats",
  "lifetime",
  "filtered",
  "unhandled",
];

/**
 * List issues for a project with pagination control.
 *
 * Uses the @sentry/api SDK's `listOrganizationIssues` for type-safe
 * query parameters, and extracts pagination from the response Link header.
 *
 * @param orgSlug - Organization slug
 * @param projectSlug - Project slug (empty string for org-wide listing)
 * @param options - Query and pagination options
 * @returns Single page of issues with cursor metadata
 */
export async function listIssuesPaginated(
  orgSlug: string,
  projectSlug: string,
  options: {
    query?: string;
    cursor?: string;
    perPage?: number;
    sort?: IssueSort;
    statsPeriod?: string;
    /** Numeric project ID. When provided, uses the `project` query param
     *  instead of `project:<slug>` search syntax, avoiding "not actively
     *  selected" errors. */
    projectId?: number;
    /** Controls the time resolution of inline stats data. "auto" adapts to statsPeriod. */
    groupStatsPeriod?: "" | "14d" | "24h" | "auto";
    /** Fields to collapse (omit) from the response for performance.
     *  @see {@link buildIssueListCollapse} */
    collapse?: IssueCollapseField[];
    /** Absolute start datetime (ISO-8601). Mutually exclusive with statsPeriod. */
    start?: string;
    /** Absolute end datetime (ISO-8601). Mutually exclusive with statsPeriod. */
    end?: string;
  } = {}
): Promise<PaginatedResponse<SentryIssue[]>> {
  // When we have a numeric project ID, use the `project` query param (Array<number>)
  // instead of `project:<slug>` in the search query. The API's `project` param
  // selects the project directly, bypassing the "actively selected" requirement.
  let projectFilter = "";
  if (!options.projectId && projectSlug) {
    projectFilter = `project:${projectSlug}`;
  }
  const fullQuery = [projectFilter, options.query].filter(Boolean).join(" ");

  const config = await getOrgSdkConfig(orgSlug);

  const result = await listOrganizationIssues({
    ...config,
    path: { organization_id_or_slug: orgSlug },
    query: {
      project: options.projectId ? [options.projectId] : undefined,
      // Convert empty string to undefined so the SDK omits the param entirely;
      // sending `query=` causes the Sentry API to behave differently than
      // omitting the parameter.
      query: fullQuery || undefined,
      cursor: options.cursor,
      limit: options.perPage ?? 25,
      sort: options.sort,
      statsPeriod: options.statsPeriod,
      start: options.start,
      end: options.end,
      groupStatsPeriod: options.groupStatsPeriod,
      collapse: options.collapse,
    },
  });

  return unwrapPaginatedResult<SentryIssue[]>(result, "Failed to list issues");
}

/** Result from {@link listIssuesAllPages}. */
export type IssuesPage = {
  issues: SentryIssue[];
  /**
   * Cursor for the next page of results, if more exist beyond the returned
   * issues. `undefined` when exhausted or a safe page boundary is unavailable.
   */
  nextCursor?: string;
};

/**
 * Auto-paginate through issues up to the requested limit.
 *
 * The Sentry API caps `per_page` at {@link API_MAX_PER_PAGE} server-side. When the caller
 * requests more than that, this function transparently fetches multiple
 * pages using cursor-based pagination and returns the combined result.
 *
 * Safety-bounded by {@link MAX_PAGINATION_PAGES} to prevent runaway requests.
 *
 * @param orgSlug - Organization slug
 * @param projectSlug - Project slug (empty string for org-wide)
 * @param options - Query, sort, and limit options
 * @returns Issues (up to `limit` items) and a cursor for the next page if available
 */
export async function listIssuesAllPages(
  orgSlug: string,
  projectSlug: string,
  options: {
    query?: string;
    limit: number;
    sort?: IssueSort;
    statsPeriod?: string;
    /** Numeric project ID for direct project selection via query param. */
    projectId?: number;
    /** Controls the time resolution of inline stats data. "auto" adapts to statsPeriod. */
    groupStatsPeriod?: "" | "14d" | "24h" | "auto";
    /** Resume pagination from this cursor instead of starting from the beginning. */
    startCursor?: string;
    /** Called after each page is fetched. Useful for progress indicators. */
    onPage?: (fetched: number, limit: number) => void;
    /** Fields to collapse (omit) from the response for performance.
     *  @see {@link buildIssueListCollapse} */
    collapse?: IssueCollapseField[];
    /** Absolute start datetime (ISO-8601). Mutually exclusive with statsPeriod. */
    start?: string;
    /** Absolute end datetime (ISO-8601). Mutually exclusive with statsPeriod. */
    end?: string;
  }
): Promise<IssuesPage> {
  if (options.limit < 1) {
    throw new Error(
      `listIssuesAllPages: limit must be at least 1, got ${options.limit}`
    );
  }

  const allResults: SentryIssue[] = [];
  let cursor: string | undefined = options.startCursor;

  for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
    const remaining = options.limit - allResults.length;
    const perPage = Math.min(remaining, API_MAX_PER_PAGE);
    const response = await listIssuesPaginated(orgSlug, projectSlug, {
      query: options.query,
      cursor,
      perPage,
      sort: options.sort,
      statsPeriod: options.statsPeriod,
      start: options.start,
      end: options.end,
      projectId: options.projectId,
      groupStatsPeriod: options.groupStatsPeriod,
      collapse: options.collapse,
    });

    allResults.push(...response.data);
    options.onPage?.(Math.min(allResults.length, options.limit), options.limit);

    // Request only the remaining number of items on each page. A conforming
    // API therefore reaches the limit exactly and its cursor remains usable.
    // Keep the defensive overshoot branch for servers that ignore `limit`.
    if (allResults.length >= options.limit || !response.nextCursor) {
      if (allResults.length > options.limit) {
        // The cursor resumes after the oversized page; exposing it would skip
        // the trimmed items that the caller has not received.
        return { issues: allResults.slice(0, options.limit) };
      }
      return { issues: allResults, nextCursor: response.nextCursor };
    }

    cursor = response.nextCursor;
  }

  // Safety limit reached — return what we have, no nextCursor
  return { issues: allResults.slice(0, options.limit) };
}

/**
 * Get a specific issue by numeric ID.
 *
 * Uses the legacy unscoped endpoint — no org context or region routing.
 * Prefer {@link getIssueInOrg} when the org slug is known.
 *
 * @param issueId - Numeric issue ID
 * @param options - Optional collapse fields to skip expensive backend queries
 */
export function getIssue(
  issueId: string,
  options?: { collapse?: IssueCollapseField[] }
): Promise<SentryIssue> {
  return apiRequest<SentryIssue>(`/issues/${issueId}/`, {
    params: options?.collapse ? { collapse: options.collapse } : undefined,
  });
}

/**
 * Get a specific issue by numeric ID, scoped to an organization.
 *
 * Uses the org-scoped endpoint with region-aware routing.
 * Preferred over {@link getIssue} when the org slug is available.
 *
 * Uses raw `apiRequestToRegion` instead of the SDK's `retrieveAnIssue`
 * because the SDK types declare `query?: never`, blocking `collapse`
 * and other query parameters. See: https://github.com/getsentry/sentry-api-schema/issues/63
 *
 * @param orgSlug - Organization slug (used for region routing)
 * @param issueId - Numeric issue ID
 * @param options - Optional collapse fields to skip expensive backend queries
 */
export async function getIssueInOrg(
  orgSlug: string,
  issueId: string,
  options?: { collapse?: IssueCollapseField[] }
): Promise<SentryIssue> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  const { data } = await apiRequestToRegion<SentryIssue>(
    regionUrl,
    `/organizations/${orgSlug}/issues/${issueId}/`,
    {
      params: options?.collapse ? { collapse: options.collapse } : undefined,
    }
  );
  return data;
}

/**
 * Get an issue by short ID (e.g., SPOTLIGHT-ELECTRON-4D).
 * Requires organization context to resolve the short ID.
 * Uses region-aware routing for multi-region support.
 *
 * Uses raw `apiRequestToRegion` instead of the SDK's `resolveAShortId`
 * because the SDK types declare `query?: never`, blocking `collapse`
 * and other query parameters. See: https://github.com/getsentry/sentry-api-schema/
 *
 * @param orgSlug - Organization slug
 * @param shortId - Short ID (e.g., "CLI-G5", "SPOTLIGHT-ELECTRON-4D")
 * @param options - Optional collapse fields to skip expensive backend queries
 */
export async function getIssueByShortId(
  orgSlug: string,
  shortId: string,
  options?: { collapse?: IssueCollapseField[] }
): Promise<SentryIssue> {
  const normalizedShortId = shortId.toUpperCase();
  const regionUrl = await resolveOrgRegion(orgSlug);

  let data: { group?: SentryIssue };
  try {
    const result = await apiRequestToRegion<{ group?: SentryIssue }>(
      regionUrl,
      `/organizations/${orgSlug}/shortids/${normalizedShortId}/`,
      {
        params: options?.collapse ? { collapse: options.collapse } : undefined,
      }
    );
    data = result.data;
  } catch (error) {
    // Enrich 404 errors with actionable context. The generic
    // "Failed to resolve short ID: 404 Not Found" is the most common
    // issue view error (CLI-A1, 27 users). Callers like
    // tryGetIssueByShortId still catch ApiError by status code.
    if (error instanceof ApiError && error.status === 404) {
      throw new ApiError(
        `Short ID '${normalizedShortId}' not found in organization '${orgSlug}'`,
        404,
        [
          "The issue may have been deleted or merged",
          `Verify the short ID and org: sentry issue view ${orgSlug}/${normalizedShortId}`,
          `List issues in this org: sentry issue list ${orgSlug}/`,
        ].join("\n  ")
      );
    }
    throw error;
  }

  if (!data.group) {
    throw new ApiError(
      `Short ID ${normalizedShortId} resolved but no issue group returned`,
      404,
      "Issue not found"
    );
  }
  return data.group;
}

/**
 * Try to get an issue by short ID, returning null on 404.
 *
 * Same as {@link getIssueByShortId} but returns null instead of throwing
 * when the short ID is not found. Useful for parallel fan-out across orgs
 * where most will 404.
 *
 * @param orgSlug - Organization slug
 * @param shortId - Full short ID (e.g., "CONSUMER-MOBILE-1QNEK")
 * @returns The resolved issue, or null if not found in this org
 */
export async function tryGetIssueByShortId(
  orgSlug: string,
  shortId: string,
  options?: { collapse?: IssueCollapseField[] }
): Promise<SentryIssue | null> {
  try {
    return await getIssueByShortId(orgSlug, shortId, options);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Resolution-release tracking for {@link updateIssueStatus}. Maps to the
 * `statusDetails` shape expected by Sentry's bulk mutate endpoint:
 *
 * - `inRelease` — resolve in a specific named release (e.g. `"0.26.1"`).
 *   Future events seen on releases **after** this one will regression-flag.
 * - `inNextRelease: true` — resolve in the next release after the current
 *   commit. Commonly used when the fix is merged but not yet tagged.
 * - `inCommit` — resolve tied to a commit in a Sentry-registered repo.
 *   Sentry resolves when a release containing the commit is created. Both
 *   `commit` (SHA) and `repository` (Sentry-registered repo name) are
 *   required by the API's InCommitValidator.
 */
export type ResolveStatusDetails =
  | { inRelease: string }
  | { inNextRelease: true }
  | { inCommit: { commit: string; repository: string } };

/**
 * Sentinel string meaning "resolve in the next release (tied to HEAD)".
 * Chosen to never clash with a real version string — `@` is not a valid
 * character in semver or Sentry release slugs.
 */
export const RESOLVE_NEXT_RELEASE_SENTINEL = "@next";

/**
 * Bare sentinel meaning "resolve at the current git HEAD, auto-detecting
 * the Sentry-registered repo from the git origin URL". The command layer
 * resolves this into a concrete `{inCommit: {...}}` before calling the API.
 */
export const RESOLVE_COMMIT_SENTINEL = "@commit";

/**
 * Prefix for the explicit commit form: `@commit:<repo>@<sha>`.
 * Kept unambiguous against monorepo release strings like `pkg@1.2.3` by
 * requiring the full `@commit:` anchor at the start.
 */
export const RESOLVE_COMMIT_EXPLICIT_PREFIX = "@commit:";

/**
 * Parsed representation of the `@commit` spec family — either an
 * "auto-detect from HEAD" request or an explicit repo + SHA pair.
 *
 * Auto-detection needs git + an API call, so the CLI layer converts this
 * into `ResolveStatusDetails` asynchronously via a separate resolver.
 */
export type ResolveCommitSpec =
  | { kind: "auto" }
  | { kind: "explicit"; repository: string; commit: string };

/**
 * Parsed representation of the fully-static portion of the `--in` grammar.
 * Static specs ({@link ResolveStatusDetails}) are ready to ship to the API;
 * commit specs ({@link ResolveCommitSpec}) need further resolution through
 * git and the Sentry repo list before they become `{inCommit: ...}`.
 */
export type ParsedResolveSpec =
  | { kind: "static"; details: ResolveStatusDetails }
  | { kind: "commit"; spec: ResolveCommitSpec };

/**
 * Parse an `--in` resolution-spec string into its structured form.
 *
 * Grammar (see command docs):
 *
 * - `@next`                    → `{kind: "static", details: {inNextRelease: true}}`
 * - `@commit`                  → `{kind: "commit", spec: {kind: "auto"}}`
 * - `@commit:<repo>@<sha>`     → `{kind: "commit", spec: {kind: "explicit", ...}}`
 * - anything else              → `{kind: "static", details: {inRelease: <value>}}`
 *
 * The explicit commit form requires a `<repo>@<sha>` payload after the
 * `@commit:` anchor. Monorepo release strings like `pkg@1.2.3` are
 * unambiguously treated as releases because they lack the `@commit:` prefix.
 *
 * Empty/whitespace-only input returns `null` (treated as "no spec" by the
 * caller, which resolves immediately without release tracking).
 *
 * @throws {ValidationError} When `@commit:` prefix is given without a
 *   well-formed `<repo>@<sha>` payload.
 */
export function parseResolveSpec(
  spec: string | undefined
): ParsedResolveSpec | null {
  if (!spec) {
    return null;
  }
  const trimmed = spec.trim();
  if (!trimmed) {
    return null;
  }
  // Sentinel matches are case-insensitive (`@NEXT`, `@Commit`, etc.) so
  // typos and mixed-case variants don't silently fall through to
  // inRelease. But the payload after `@commit:` keeps its original case,
  // since repository names and SHAs are case-sensitive.
  const lower = trimmed.toLowerCase();
  if (lower === RESOLVE_NEXT_RELEASE_SENTINEL) {
    return { kind: "static", details: { inNextRelease: true } };
  }
  if (lower === RESOLVE_COMMIT_SENTINEL) {
    return { kind: "commit", spec: { kind: "auto" } };
  }
  if (lower.startsWith(RESOLVE_COMMIT_EXPLICIT_PREFIX)) {
    const payload = trimmed.slice(RESOLVE_COMMIT_EXPLICIT_PREFIX.length);
    // Split on the LAST `@` so repo names containing `@` (rare but legal
    // for scoped npm-style names like `@acme/web`) resolve correctly.
    const splitIdx = payload.lastIndexOf("@");
    if (splitIdx <= 0 || splitIdx === payload.length - 1) {
      throw new ValidationError(
        `Invalid --in spec: '${spec}' — expected '${RESOLVE_COMMIT_EXPLICIT_PREFIX}<repo>@<sha>'.`,
        "in"
      );
    }
    const repository = payload.slice(0, splitIdx).trim();
    const commit = payload.slice(splitIdx + 1).trim();
    if (!(repository && commit)) {
      throw new ValidationError(
        `Invalid --in spec: '${spec}' — repo and SHA must both be non-empty.`,
        "in"
      );
    }
    return { kind: "commit", spec: { kind: "explicit", repository, commit } };
  }
  // Anything else starting with `@` is almost certainly a mistyped
  // sentinel — reject with a clear message instead of silently creating
  // a release named (e.g.) "@netx" that the user didn't intend.
  if (trimmed.startsWith("@")) {
    throw new ValidationError(
      `Invalid --in spec: '${spec}' is not a recognized sentinel.\n\n` +
        `Expected '${RESOLVE_NEXT_RELEASE_SENTINEL}', '${RESOLVE_COMMIT_SENTINEL}', or '${RESOLVE_COMMIT_EXPLICIT_PREFIX}<repo>@<sha>'.\n` +
        "If you meant a literal release name, it cannot start with '@'.",
      "in"
    );
  }
  return { kind: "static", details: { inRelease: trimmed } };
}

/**
 * Ignore/archive conditions for {@link updateIssueStatus}.
 *
 * - `ignoreDuration` — ignore for N minutes
 * - `ignoreCount` / `ignoreWindow` — ignore until N events in M minutes
 * - `ignoreUserCount` / `ignoreUserWindow` — ignore until N users in M minutes
 */
export type IgnoreStatusDetails = {
  ignoreDuration?: number;
  ignoreCount?: number;
  ignoreWindow?: number;
  ignoreUserCount?: number;
  ignoreUserWindow?: number;
};

/**
 * Update an issue's status.
 *
 * - `"resolved"` — optional `statusDetails` can pin the fix to a release
 *   or commit (see {@link ResolveStatusDetails}).
 * - `"ignored"` — optional `substatus` controls archive granularity;
 *   optional `statusDetails` sets conditions (see {@link IgnoreStatusDetails}).
 * - `"unresolved"` — reopens the issue; no additional options needed.
 *
 * When `options.orgSlug` is provided, the request is routed to that org's
 * region via the org-scoped endpoint. Without it, falls back to the legacy
 * global `/issues/{id}/` endpoint (works but not region-aware).
 */
export async function updateIssueStatus(
  issueId: string,
  status: "resolved" | "unresolved" | "ignored",
  options?: {
    statusDetails?: ResolveStatusDetails | IgnoreStatusDetails;
    /** Substatus for archive granularity. */
    substatus?: IssueSubstatus;
    orgSlug?: string;
  }
): Promise<SentryIssue> {
  const body: Record<string, unknown> = { status };
  if (options?.statusDetails) {
    body.statusDetails = options.statusDetails;
  }
  if (options?.substatus) {
    body.substatus = options.substatus;
  }

  if (options?.orgSlug) {
    // Region-aware org-scoped endpoint — preferred when org is known.
    const regionUrl = await resolveOrgRegion(options.orgSlug);
    const { data } = await apiRequestToRegion<SentryIssue>(
      regionUrl,
      `/organizations/${encodeURIComponent(options.orgSlug)}/issues/${encodeURIComponent(issueId)}/`,
      { method: "PUT", body }
    );
    return data;
  }

  // Legacy global endpoint — works without org but not region-aware.
  return apiRequest<SentryIssue>(`/issues/${encodeURIComponent(issueId)}/`, {
    method: "PUT",
    body,
  });
}

/** Result of a successful issue-merge operation. */
export type MergeIssuesResult = {
  /** Numeric group ID that the merged issues were consolidated into. */
  parent: string;
  /** Numeric group IDs that were merged into the parent (excludes parent). */
  children: string[];
};

/**
 * Merge multiple issues into a single canonical group.
 *
 * Sentry auto-picks the canonical parent (typically the largest by event
 * count). Future events with fingerprints previously matching any of the
 * children will flow into the parent group.
 *
 * @param orgSlug - Organization slug (required for the bulk mutate endpoint)
 * @param groupIds - At least 2 numeric group IDs to merge
 * @throws {ApiError} When fewer than 2 IDs are provided, or the API rejects
 *   (e.g. `"Only error issues can be merged."` for non-error issue types)
 */
export async function mergeIssues(
  orgSlug: string,
  groupIds: readonly string[]
): Promise<MergeIssuesResult> {
  if (groupIds.length < 2) {
    throw new ValidationError(
      `Need at least 2 issues to merge (got ${groupIds.length}).`
    );
  }
  // The bulk mutate endpoint accepts repeated `?id=X` query params plus a
  // `{merge: 1}` body. The SDK wraps this but its typed `query` shape
  // doesn't expose the array semantics cleanly, so use raw request.
  const regionUrl = await resolveOrgRegion(orgSlug);
  const query = groupIds.map((id) => `id=${encodeURIComponent(id)}`).join("&");
  const path = `/organizations/${encodeURIComponent(orgSlug)}/issues/?${query}`;
  type MergeResponse = { merge: MergeIssuesResult };
  try {
    const { data } = await apiRequestToRegion<MergeResponse>(regionUrl, path, {
      method: "PUT",
      body: { merge: 1 },
    });
    // HTTP-layer invalidation covers the region-scoped caches via the
    // prefix sweep on `/organizations/{org}/issues/`, but it can't see
    // the affected IDs (they're in query params, stripped from the
    // URL the hook sees). Manually clear each affected issue's legacy
    // cross-origin cache so subsequent `getIssue(id)` doesn't serve
    // stale data.
    const apiBase = getApiBaseUrl().replace(TRAILING_SLASH_RE, "");
    const affectedIds = data.merge.children.toSpliced(0, 0, data.merge.parent);
    await Promise.all(
      affectedIds.map((id) =>
        invalidateCachedResponsesMatching(
          `${apiBase}/api/0/issues/${encodeURIComponent(id)}/`
        )
      )
    );
    return data.merge;
  } catch (error) {
    // The bulk-mutate endpoint returns 204 when no matching issues are
    // found — e.g. IDs out of scope, or issues deleted between resolution
    // and the merge call. Catch the generic "no body" ApiError and re-throw
    // with a friendlier user-facing message.
    if (error instanceof ApiError && error.status === 204) {
      throw new ApiError(
        `No matching issues found for merge in '${orgSlug}'.`,
        204,
        "All provided issue IDs are out of scope or no longer exist.",
        path
      );
    }
    throw error;
  }
}

/**
 * Resolve a share ID to basic issue data via the public share endpoint.
 *
 * This org-scoped endpoint does not require authentication.
 * The response includes the numeric issue `id` needed to fetch full issue
 * details via the authenticated API.
 *
 * @param baseUrl - The Sentry instance base URL (from the share URL)
 * @param orgSlug - The organization that owns the shared issue
 * @param shareId - The share ID extracted from the share URL
 * @returns Object containing the numeric issue ID
 * @throws {ApiError} When the share link is expired, disabled, or invalid
 */
export async function getSharedIssue(
  baseUrl: string,
  orgSlug: string,
  shareId: string
): Promise<{ id: string }> {
  const path = `organizations/${encodeURIComponent(orgSlug)}/shared/issues/${encodeURIComponent(shareId)}/`;
  const url = `${baseUrl.replace(TRAILING_SLASH_RE, "")}/api/0/${path}`;
  const headers = new Headers({ "Content-Type": "application/json" });
  // URL-scoped: headers only attach when `url`'s origin matches the trusted
  // host, so IAP tokens etc. can't leak to an attacker-controlled share URL.
  applyCustomHeaders(headers, url);
  warnIfSaasWithEnvCa(url);

  let response: Response;
  try {
    response = await customFetch(url, { headers });
  } catch (error) {
    if (error instanceof Error && isTlsCertError(error)) {
      throw new ApiError(
        "TLS certificate error",
        0,
        buildTlsErrorDetail(error),
        path
      );
    }
    throw error;
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new ApiError(
        "Share link not found or expired",
        404,
        "The share link may have been disabled by the issue owner.\n" +
          "  Ask them to re-enable sharing, or use the issue ID directly.",
        path
      );
    }
    throw new ApiError(
      "Failed to resolve share link",
      response.status,
      undefined,
      path
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    throw new ApiError(
      "Share link returned invalid JSON",
      response.status,
      undefined,
      path
    );
  }

  if (
    typeof data !== "object" ||
    data === null ||
    !("id" in data) ||
    typeof data.id !== "string" ||
    data.id.length === 0
  ) {
    throw new ApiError(
      "Share link response missing a valid issue ID",
      response.status,
      undefined,
      path
    );
  }

  return { id: data.id };
}
