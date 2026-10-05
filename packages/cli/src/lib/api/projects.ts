/**
 * Project API functions
 *
 * CRUD operations, search, and DSN key retrieval for Sentry projects.
 */

import {
  createOrganizationProject,
  createTeamProject,
  listOrganizationProjectKeys,
  listOrganizationProjects,
  listProjectKeys,
  type ProjectKey as SdkProjectKey,
  deleteProject as sdkDeleteProject,
  getProject as sdkGetProject,
} from "@sentry/api";

import pLimit from "p-limit";

import type {
  ProjectKey,
  Region,
  SentryOrganization,
  SentryProject,
} from "../../types/index.js";

import {
  cacheProjectsForOrg,
  setCachedProjectByDsnKey,
} from "../db/project-cache.js";
import { getCachedOrganizations } from "../db/regions.js";
import { reportCliError } from "../error-reporting.js";
import { type AuthGuardSuccess, withAuthGuard } from "../errors.js";
import { logger } from "../logger.js";
import { getApiBaseUrl } from "../sentry-client.js";
import { buildProjectUrl } from "../sentry-urls.js";
import { isAllDigits } from "../utils.js";

import {
  API_MAX_PER_PAGE,
  apiRequestToRegion,
  autoPaginate,
  getOrgSdkConfig,
  MAX_PAGINATION_PAGES,
  ORG_FANOUT_CONCURRENCY,
  type PaginatedResponse,
  paginate,
  unwrapPaginatedResult,
  unwrapResult,
} from "./infrastructure.js";
import { getUserRegions, listOrganizations } from "./organizations.js";

const log = logger.withTag("api.projects");

/**
 * Surface a swallowed best-effort failure without failing the caller.
 *
 * `log.debug` is for `--verbose` local diagnosis. {@link reportCliError}
 * is what makes unexpected failures visible as Sentry issues for users
 * who never pass `--verbose`.
 */
function reportBestEffortFailure(message: string, error: unknown): void {
  log.debug(message, error);
  reportCliError(error);
}

/**
 * List all projects in an organization.
 * Automatically paginates through all API pages to return the complete list.
 * Uses region-aware routing for multi-region support.
 *
 * @param orgSlug - Organization slug
 * @returns All projects in the organization
 */
export async function listProjects(orgSlug: string): Promise<SentryProject[]> {
  const config = await getOrgSdkConfig(orgSlug);

  const { data: allResults } = await autoPaginate(async (cursor) => {
    const result = await listOrganizationProjects({
      ...config,
      path: { organization_id_or_slug: orgSlug },
      query: { cursor, per_page: API_MAX_PER_PAGE } as {
        cursor?: string;
        per_page?: number;
      },
    });
    return unwrapPaginatedResult<SentryProject[]>(
      result,
      "Failed to list projects"
    );
  }, MAX_PAGINATION_PAGES * API_MAX_PER_PAGE);

  // Populate project cache for shell completions (best-effort).
  // Mirrors how listOrganizations() calls setOrgRegions().
  try {
    const orgs = getCachedOrganizations();
    const orgName = orgs.find((o) => o.slug === orgSlug)?.name ?? orgSlug;
    cacheProjectsForOrg(orgSlug, orgName, allResults);
  } catch (error) {
    reportBestEffortFailure(
      `Failed to cache projects for org '${orgSlug}'`,
      error
    );
  }

  return allResults;
}

/**
 * List projects in an organization with pagination control.
 * Returns a single page of results with cursor metadata for manual pagination.
 * Uses region-aware routing for multi-region support.
 *
 * `perPage` is capped at {@link API_MAX_PER_PAGE}: the org projects endpoint
 * returns 400 for larger values instead of silently truncating.
 *
 * @param orgSlug - Organization slug
 * @param options - Pagination options
 * @returns Single page of projects with cursor metadata
 */
export async function listProjectsPaginated(
  orgSlug: string,
  options: { cursor?: string; perPage?: number } = {}
): Promise<PaginatedResponse<SentryProject[]>> {
  const config = await getOrgSdkConfig(orgSlug);
  const perPage = Math.min(
    options.perPage ?? API_MAX_PER_PAGE,
    API_MAX_PER_PAGE
  );

  const result = await listOrganizationProjects({
    ...config,
    path: { organization_id_or_slug: orgSlug },
    query: {
      cursor: options.cursor,
      per_page: perPage,
    } as { cursor?: string; per_page?: number },
  });

  return unwrapPaginatedResult<SentryProject[]>(
    result,
    "Failed to list projects"
  );
}

/**
 * List projects up to `limit`, auto-paginating when the limit exceeds
 * {@link API_MAX_PER_PAGE}.
 *
 * Delegates to {@link paginate} so the `per_page` cap and cursor threading
 * stay on the shared list helper (#1486).
 *
 * @param orgSlug - Organization slug
 * @param options - Total item limit and optional resume cursor
 * @returns Combined page of projects with optional next cursor
 */
export function listProjectsAllPages(
  orgSlug: string,
  options: { limit: number; cursor?: string }
): Promise<PaginatedResponse<SentryProject[]>> {
  return paginate(options, (perPage, cursor) =>
    listProjectsPaginated(orgSlug, { cursor, perPage })
  );
}

/** Project with its organization context */
export type ProjectWithOrg = SentryProject & {
  /** Organization slug the project belongs to */
  orgSlug: string;
};

/** Request body for creating a new project */
type CreateProjectBody = {
  name: string;
  platform?: string;
  default_rules?: boolean;
};

/**
 * Create a new project in an organization under a team.
 *
 * @param orgSlug - The organization slug
 * @param teamSlug - The team slug to create the project under
 * @param body - Project creation parameters (name is required)
 * @returns The created project
 * @throws {ApiError} 409 if a project with the same slug already exists
 */
export async function createProject(
  orgSlug: string,
  teamSlug: string,
  body: CreateProjectBody
): Promise<SentryProject> {
  const config = await getOrgSdkConfig(orgSlug);
  const result = await createTeamProject({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      team_id_or_slug: teamSlug,
    },
    body,
  });
  return unwrapResult<SentryProject>(result, "Failed to create project");
}

/** Result of creating a project and fetching its DSN + dashboard URL. */
export type CreatedProjectDetails = {
  project: SentryProject;
  dsn: string | null;
  url: string;
};

/**
 * Seed both project caches after a successful creation.
 *
 * Best-effort: cache failures are reported to Sentry but never break
 * project creation. Called by both `createProjectWithDsn` (team-scoped)
 * and `createProjectWithAutoTeam` (org-scoped) to keep cache behaviour
 * consistent across both creation paths.
 */
function seedProjectCaches(
  orgSlug: string,
  project: SentryProject,
  dsn: string | null
): void {
  try {
    const orgName = resolveOrgDisplayName(orgSlug, project.organization?.name);
    cacheProjectsForOrg(orgSlug, orgName, [
      { id: project.id, slug: project.slug, name: project.name },
    ]);
  } catch (error) {
    reportBestEffortFailure(
      `Failed to seed project cache for '${project.slug}'`,
      error
    );
  }
  if (dsn) {
    try {
      const publicKey = extractPublicKeyFromDsn(dsn);
      if (publicKey) {
        setCachedProjectByDsnKey(publicKey, {
          orgSlug,
          orgName: resolveOrgDisplayName(orgSlug, project.organization?.name),
          projectSlug: project.slug,
          projectName: project.name,
          projectId: project.id,
        });
      }
    } catch (error) {
      reportBestEffortFailure(
        `Failed to seed DSN key cache for '${project.slug}'`,
        error
      );
    }
  }
}

/**
 * Extract the public key from a Sentry DSN URL.
 * DSN format: https://<public_key>@<host>/<project_id>
 */
function extractPublicKeyFromDsn(dsn: string): string | null {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const url = new URL(dsn);
    return url.username || null;
  } catch {
    return null;
  }
}

/**
 * Create a project, fetch its DSN, and build its dashboard URL.
 *
 * Shared core used by both `sentry project create` and `sentry init`.
 * Callers handle their own error wrapping and team resolution.
 *
 * After creation, seeds the project cache and DSN-based project cache
 * so subsequent commands skip redundant API lookups.
 */
export async function createProjectWithDsn(
  orgSlug: string,
  teamSlug: string,
  body: CreateProjectBody
): Promise<CreatedProjectDetails> {
  const project = await createProject(orgSlug, teamSlug, body);
  const dsn = await tryGetPrimaryDsn(orgSlug, project.slug);
  const url = buildProjectUrl(orgSlug, project.slug);

  seedProjectCaches(orgSlug, project, dsn);
  return { project, dsn, url };
}

/**
 * Response from the org-scoped project creation endpoint.
 *
 * `createOrganizationProject` returns a standard project plus `team_slug` — the
 * personal team the server auto-creates for the caller. `team_slug` is returned
 * by the API but absent from the OpenAPI spec, so it is declared here as a typed
 * overlay on the SDK-derived `SentryProject` (same convention as
 * `SentryProject.organization`/`status`; a backend `@extend_schema` candidate).
 */
type ProjectWithAutoTeam = SentryProject & {
  /** Personal team auto-created by the server (returned, not in the OpenAPI spec). */
  team_slug: string;
};

/**
 * Result of creating a project via the org-scoped member-accessible endpoint.
 * Parallel to {@link CreatedProjectDetails} for the team-scoped endpoint.
 */
type CreatedAutoTeamProjectDetails = CreatedProjectDetails & {
  /** The personal team auto-created by the server for the requesting user. */
  team_slug: string;
};

/**
 * Substring present in the 403 detail when the org has disabled member project
 * creation. Callers match against this to distinguish a policy 403 from an auth
 * 403, so they can surface a clear "ask your admin" message instead of a generic
 * permission error or a re-auth prompt.
 */
export const MEMBER_PROJECT_CREATION_DISABLED_DETAIL = "disabled this feature";

/**
 * Create a new project via the org-scoped member-accessible endpoint.
 *
 * Unlike `createProject` (which posts to `/teams/{org}/{team}/projects/` and
 * requires `project:write`), this endpoint only requires `project:read` scope
 * and is accessible to org members. The server auto-creates a personal team
 * named `team-{username}` for the caller with Team Admin role, then creates
 * the project under it.
 *
 * The org must have `allowMemberProjectCreation = true` (i.e. the org flag
 * `disable_member_project_creation` must be false). A 403 is returned
 * otherwise — callers should surface that as an org policy error, not an
 * auth issue.
 *
 * This mirrors the endpoint called by the Sentry onboarding UI when a member
 * selects a platform for the first time.
 *
 * @param orgSlug - The organization slug
 * @param body - Project creation parameters (name required, platform optional)
 * @returns The created project with the auto-created team slug
 * @throws {ApiError} 403 if member project creation is disabled for the org
 * @throws {ApiError} 409 if a project with the same slug already exists
 */
export async function createProjectWithAutoTeam(
  orgSlug: string,
  body: CreateProjectBody
): Promise<CreatedAutoTeamProjectDetails> {
  const config = await getOrgSdkConfig(orgSlug);
  const result = await createOrganizationProject({
    ...config,
    path: { organization_id_or_slug: orgSlug },
    body,
  });
  // `team_slug` is returned but not in the spec — see the ProjectWithAutoTeam overlay.
  const data = unwrapResult<ProjectWithAutoTeam>(
    result,
    "Failed to create project"
  );
  const dsn = await tryGetPrimaryDsn(orgSlug, data.slug);
  const url = buildProjectUrl(orgSlug, data.slug);

  seedProjectCaches(orgSlug, data, dsn);
  return { project: data, dsn, url, team_slug: data.team_slug };
}

/**
 * Delete a project from an organization.
 *
 * Sends a DELETE request to the Sentry API. Returns 204 No Content on success.
 *
 * @param orgSlug - The organization slug
 * @param projectSlug - The project slug to delete
 * @throws {ApiError} 403 if the user lacks permission, 404 if the project doesn't exist
 */
export async function deleteProject(
  orgSlug: string,
  projectSlug: string
): Promise<void> {
  const config = await getOrgSdkConfig(orgSlug);
  const result = await sdkDeleteProject({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      project_id_or_slug: projectSlug,
    },
  });
  unwrapResult(result, "Failed to delete project");
}

/** Result of searching for projects by slug across all organizations. */
export type ProjectSearchResult = {
  /** Matching projects with their org context */
  projects: ProjectWithOrg[];
  /** All organizations fetched during the search — reuse for fallback checks */
  orgs: SentryOrganization[];
};

/**
 * Search for projects matching a slug across all accessible organizations.
 *
 * Used for `sentry issue list <project-name>` when no org is specified.
 * Searches all orgs the user has access to and returns matches.
 *
 * Returns both the matching projects and the full org list that was fetched,
 * so callers can check whether a slug matches an organization without an
 * additional API call (useful for "did you mean org/?" fallbacks).
 *
 * @param projectSlug - Project slug to search for (exact match)
 * @returns Matching projects and the org list used during search
 */
export async function findProjectsBySlug(
  projectSlug: string
): Promise<ProjectSearchResult> {
  const isNumericId = isAllDigits(projectSlug);

  // listOrganizations() returns from cache when populated, avoiding
  // an org listing API round-trip.
  const orgs = await listOrganizations();

  // Direct lookup with concurrency limit — one API call per org instead of
  // paginating all projects. p-limit prevents overwhelming the API for users
  // with many organizations.
  const limit = pLimit(ORG_FANOUT_CONCURRENCY);
  const searchResults = await Promise.all(
    orgs.map((org) =>
      limit(() =>
        withAuthGuard(async () => {
          const project = await getProject(org.slug, projectSlug);
          // The API accepts project_id_or_slug, so a numeric input could
          // resolve by ID instead of slug. When the input is all digits,
          // accept the match (the user passed a numeric project ID).
          // For non-numeric inputs, verify the slug actually matches to
          // avoid false positives from coincidental ID collisions.
          // Note: Sentry enforces that project slugs must start with a letter,
          // so an all-digits input can only ever be a numeric ID, never a slug.
          if (!isNumericId && project.slug !== projectSlug) {
            return null;
          }
          return { ...project, orgSlug: org.slug };
        })
      )
    )
  );

  return {
    projects: searchResults
      .filter((r): r is AuthGuardSuccess<ProjectWithOrg | null> => r.ok)
      .map((r) => r.value)
      .filter((v): v is ProjectWithOrg => v !== null),
    orgs,
  };
}

/**
 * Escape special regex characters in a string.
 * Uses native RegExp.escape if available (Node.js 23.6+, Bun), otherwise polyfills.
 */
const escapeRegex: (str: string) => string =
  typeof RegExp.escape === "function"
    ? RegExp.escape
    : (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Check if two strings match with word-boundary semantics (bidirectional).
 *
 * Returns true if either:
 * - `a` appears in `b` at a word boundary
 * - `b` appears in `a` at a word boundary
 *
 * @example
 * matchesWordBoundary("cli", "cli-website")  // true: "cli" in "cli-website"
 * matchesWordBoundary("sentry-docs", "docs") // true: "docs" in "sentry-docs"
 * matchesWordBoundary("cli", "eclipse")      // false: no word boundary
 *
 * @internal Exported for testing
 */
export function matchesWordBoundary(a: string, b: string): boolean {
  const aInB = new RegExp(`\\b${escapeRegex(a)}\\b`, "i");
  const bInA = new RegExp(`\\b${escapeRegex(b)}\\b`, "i");
  return aInB.test(b) || bInA.test(a);
}

/**
 * Find projects matching a pattern with bidirectional word-boundary matching.
 * Used for directory name inference when DSN detection fails.
 *
 * Uses `\b` regex word boundary, which matches:
 * - Start/end of string
 * - Between word char (`\w`) and non-word char (like "-")
 *
 * Matching is bidirectional:
 * - Directory name in project slug: dir "cli" matches project "cli-website"
 * - Project slug in directory name: project "docs" matches dir "sentry-docs"
 *
 * @param pattern - Directory name to match against project slugs
 * @returns Array of matching projects with their org context
 */
export async function findProjectsByPattern(
  pattern: string
): Promise<ProjectWithOrg[]> {
  const orgs = await listOrganizations();

  const limit = pLimit(ORG_FANOUT_CONCURRENCY);
  const searchResults = await Promise.all(
    orgs.map((org) =>
      limit(() =>
        withAuthGuard(async () => {
          const projects = await listProjects(org.slug);
          return projects
            .filter((p) => matchesWordBoundary(pattern, p.slug))
            .map((p) => ({ ...p, orgSlug: org.slug }));
        })
      )
    )
  );

  return searchResults
    .filter((r): r is AuthGuardSuccess<ProjectWithOrg[]> => r.ok)
    .flatMap((r) => r.value);
}

/**
 * Find a project by DSN public key.
 *
 * Uses the /api/0/projects/ endpoint with query=dsn:<key> to search
 * across all accessible projects in all regions. This works for both
 * SaaS and self-hosted DSNs, even when the org ID is not embedded in the DSN.
 *
 * @param publicKey - The DSN public key (username portion of DSN URL)
 * @returns The matching project, or null if not found
 */
export async function findProjectByDsnKey(
  publicKey: string
): Promise<SentryProject | null> {
  const regionsResult = await withAuthGuard(() => getUserRegions());
  const regions = regionsResult.ok ? regionsResult.value : ([] as Region[]);

  if (regions.length === 0) {
    // Escape hatch (intentionally raw, not an SDK call): the `?query=dsn:` filter
    // on `/projects/` is an internal search param absent from the OpenAPI spec,
    // so the SDK provides no typed operation for it. Kept as a documented raw
    // call until the param is promoted (backend `@extend_schema` candidate).
    // Fall back to the default region for self-hosted.
    const { data: projects } = await apiRequestToRegion<SentryProject[]>(
      getApiBaseUrl(),
      "/projects/",
      { params: { query: `dsn:${publicKey}` } }
    );
    return projects[0] ?? null;
  }

  const limit = pLimit(ORG_FANOUT_CONCURRENCY);
  const results = await Promise.all(
    regions.map((region) =>
      limit(async () => {
        try {
          // Same `?query=dsn:` escape hatch as above (see the region-fallback
          // branch) — internal search param, no typed SDK operation yet.
          const { data } = await apiRequestToRegion<SentryProject[]>(
            region.url,
            "/projects/",
            { params: { query: `dsn:${publicKey}` } }
          );
          return data;
        } catch (error) {
          reportBestEffortFailure(
            `DSN key lookup failed in region '${region.url}'`,
            error
          );
          return [];
        }
      })
    )
  );

  for (const projects of results) {
    if (projects.length > 0) {
      return projects[0] ?? null;
    }
  }

  return null;
}

/**
 * Get a specific project.
 * Uses region-aware routing for multi-region support.
 *
 * Passes `?collapse=organization` so the server skips full-org
 * serialization (~400-500ms faster). The response's `organization` field
 * is trimmed to `{id, slug}` — no `name`, feature flags, or options.
 * Callers needing a display name should use `resolveOrgDisplayName()`
 * which falls back to the cached organizations list.
 *
 * Self-hosted or older Sentry versions that don't recognize `collapse`
 * silently ignore the query param and return the full `organization`
 * payload, so this is safe for all deployments.
 */
export async function getProject(
  orgSlug: string,
  projectSlug: string
): Promise<SentryProject> {
  const config = await getOrgSdkConfig(orgSlug);

  // `collapse=organization` is server-supported but absent from the OpenAPI
  // spec, so the SDK types `query` as `never` on `GetProjectData`. Cast just
  // this param to send it at runtime; the trimmed `{id, slug}` payload it
  // yields is modeled by the `SentryProject.organization` overlay.
  const result = await sdkGetProject({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      project_id_or_slug: projectSlug,
    },
    query: { collapse: "organization" } as never,
  });

  return unwrapResult<SentryProject>(result, "Failed to get project");
}

/**
 * Resolve an organization's display name from the best available source.
 *
 * `getProject()` passes `?collapse=organization` so the server skips
 * full-org serialization (~400-500ms faster). Collapsed responses omit
 * `organization.name`, so callers that want a human-friendly label must
 * fall back to cached org metadata.
 *
 * Resolution order:
 * 1. Explicit `name` if present (self-hosted or Sentry versions that
 *    ignore the `collapse` query param still return the full payload).
 * 2. The locally cached organizations list (populated by login and every
 *    org-fanout operation).
 * 3. The slug itself — always a valid human identifier, worst case.
 *
 * @param orgSlug - Organization slug (required for cache lookup)
 * @param explicitName - The `organization.name` from an API response, if any
 * @returns A display-ready organization name (never empty)
 */
export function resolveOrgDisplayName(
  orgSlug: string,
  explicitName?: string
): string {
  if (explicitName) {
    return explicitName;
  }
  const cached = getCachedOrganizations().find((o) => o.slug === orgSlug);
  return cached?.name ?? orgSlug;
}

/**
 * User-facing fields from a project's client key.
 * Internal identifiers and legacy secret DSNs are not exposed.
 */
export type ProjectDsn = Pick<
  SdkProjectKey,
  "name" | "isActive" | "dateCreated"
> & { dsn: string };

/** Project a client key to the fields shown in Sentry's Client Keys UI. */
function toProjectDsn(key: SdkProjectKey): ProjectDsn {
  return {
    name: key.name,
    isActive: key.isActive,
    dateCreated: key.dateCreated,
    dsn: key.dsn.public,
  };
}

/**
 * List public DSNs for a project with bounded pagination.
 * Uses region-aware routing and returns only user-facing key information.
 *
 * @param orgSlug - Organization slug
 * @param projectSlug - Project slug
 * @param options - Total item limit and optional resume cursor
 * @returns Public DSNs with optional pagination cursors
 */
export async function listProjectDsns(
  orgSlug: string,
  projectSlug: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<PaginatedResponse<ProjectDsn[]>> {
  const config = await getOrgSdkConfig(orgSlug);

  return paginate(options, async (perPage, cursor) => {
    // The SDK omits the shared per_page parameter supported by this endpoint.
    const query = { cursor, per_page: perPage };
    const result = await listProjectKeys({
      ...config,
      path: {
        organization_id_or_slug: orgSlug,
        project_id_or_slug: projectSlug,
      },
      query,
    });
    const page = unwrapPaginatedResult<SdkProjectKey[]>(
      result,
      "Failed to list project DSNs"
    );

    return {
      ...page,
      data: page.data.map(toProjectDsn),
    };
  });
}

/**
 * List public DSNs across all accessible projects in an organization.
 * Resolves project slugs only for keys in the requested page and keeps
 * internal project IDs inside the API layer.
 */
export async function listOrganizationDsns(
  orgSlug: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<PaginatedResponse<(ProjectDsn & { project: string })[]>> {
  const config = await getOrgSdkConfig(orgSlug);
  const projectLookups = new Map<number, Promise<string>>();
  const limitProjectLookups = pLimit(ORG_FANOUT_CONCURRENCY);

  return paginate(options, async (perPage, cursor) => {
    // These shared query parameters are supported by the backend but absent
    // from the SDK type. -1 includes accessible projects outside the user's teams.
    const query = { cursor, per_page: perPage, project: -1 };
    const result = await listOrganizationProjectKeys({
      ...config,
      path: { organization_id_or_slug: orgSlug },
      query,
    });
    const page = unwrapPaginatedResult<SdkProjectKey[]>(
      result,
      "Failed to list organization DSNs"
    );

    const data = await Promise.all(
      page.data.map(async (key) => {
        let project = projectLookups.get(key.projectId);
        if (!project) {
          project = limitProjectLookups(async () => {
            const info = await getProject(orgSlug, String(key.projectId));
            return info.slug;
          });
          projectLookups.set(key.projectId, project);
        }
        return { ...toProjectDsn(key), project: await project };
      })
    );

    return { ...page, data };
  });
}

/**
 * Get project keys (DSNs) for a project.
 * Uses region-aware routing for multi-region support.
 *
 * @param orgSlug - Organization slug
 * @param projectSlug - Project slug
 * @param options - Optional key status filter
 */
export async function getProjectKeys(
  orgSlug: string,
  projectSlug: string,
  options: { status?: "active" | "inactive" } = {}
): Promise<ProjectKey[]> {
  const config = await getOrgSdkConfig(orgSlug);

  const result = await listProjectKeys({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      project_id_or_slug: projectSlug,
    },
    ...(options.status ? { query: { status: options.status } } : {}),
  });

  return unwrapResult<ProjectKey[]>(result, "Failed to get project keys");
}

/**
 * Fetch the primary DSN for a project.
 * Returns the public DSN of the first active key, or null on any error.
 *
 * Best-effort: failures are reported to Sentry but callers can treat DSN
 * display as optional (e.g., after project creation or in views).
 *
 * @param orgSlug - Organization slug
 * @param projectSlug - Project slug
 * @returns Public DSN string, or null if unavailable
 */
export async function tryGetPrimaryDsn(
  orgSlug: string,
  projectSlug: string
): Promise<string | null> {
  try {
    const keys = await getProjectKeys(orgSlug, projectSlug);
    const activeKey = keys.find((k) => k.isActive);
    return activeKey?.dsn.public ?? keys[0]?.dsn.public ?? null;
  } catch (error) {
    reportBestEffortFailure(
      `Failed to fetch DSN for '${orgSlug}/${projectSlug}'`,
      error
    );
    return null;
  }
}
