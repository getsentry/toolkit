/**
 * Release API functions
 *
 * Functions for listing, creating, updating, deleting, and deploying
 * Sentry releases in an organization.
 */

import {
  createOrganizationRelease,
  createOrganizationReleaseDeploy,
  deleteOrganizationRelease,
  getOrganizationRelease,
  listOrganizationReleaseDeploys,
  listOrganizationReleases,
  listProjectEnvironments as sdkListProjectEnvironments,
  updateOrganizationRelease,
} from "@sentry/api";
import { encodeApiPathSegment } from "@sentry/toolkit-core/api-path-segment";
import type {
  SentryDeploy,
  SentryRelease,
  SentryRepository,
} from "../../types/index.js";
import { getCiCheckout } from "../ci.js";
import { getEnv } from "../env.js";
import { ApiError, ValidationError, validationError } from "../errors.js";
import { getHeadCommit, getRepositoryName, parseRemoteUrl } from "../git.js";
import { logger } from "../logger.js";
import { resolveOrgRegion } from "../region.js";
import {
  API_MAX_PER_PAGE,
  apiRequestToRegion,
  getOrgSdkConfig,
  MAX_PAGINATION_PAGES,
  type PaginatedResponse,
  unwrapPaginatedResult,
  unwrapResult,
} from "./infrastructure.js";
import { getProject } from "./projects.js";
import { listRepositoriesPaginated } from "./repositories.js";

const log = logger.withTag("api.releases");

/**
 * List releases in an organization with pagination control.
 * Returns a single page of results with cursor metadata.
 *
 * When `health` is true, each release's `projects[].healthData` is populated
 * with adoption percentages, crash-free rates, and session/user counts.
 *
 * @param orgSlug - Organization slug
 * @param options - Pagination, query, sort, and health options
 * @returns Single page of releases with cursor metadata
 */
/** Options for listing releases with pagination. */
export type ListReleasesOptions = {
  cursor?: string;
  perPage?: number;
  query?: string;
  sort?: string;
  /** Include per-project health/adoption data in the response. */
  health?: boolean;
  /** Filter by numeric project IDs (repeated query param). */
  project?: number[];
  /** Filter by environment names (repeated query param). */
  environment?: string[];
  /** Stats period for health data, e.g. "24h", "7d", "90d". */
  statsPeriod?: string;
  /** Filter by release status: "open" (active) or "archived". */
  status?: string;
};

/**
 * Sorts the releases endpoint only accepts with `flatten=1`; otherwise it
 * responds 400 "sorting by crash statistics requires flattening".
 */
const SESSION_SORTS = new Set([
  "sessions",
  "users",
  "crash_free_sessions",
  "crash_free_users",
]);

export async function listReleasesPaginated(
  orgSlug: string,
  options: ListReleasesOptions = {},
): Promise<PaginatedResponse<SentryRelease[]>> {
  const config = await getOrgSdkConfig(orgSlug);

  const result = await listOrganizationReleases({
    ...config,
    path: { organization_id_or_slug: orgSlug },
    // Most query params are supported at runtime but absent from the OpenAPI spec
    query: {
      cursor: options.cursor,
      per_page: options.perPage ?? 25,
      query: options.query,
      sort: options.sort,
      flatten: options.sort && SESSION_SORTS.has(options.sort) ? 1 : undefined,
      health: options.health ? 1 : undefined,
      project: options.project,
      environment: options.environment,
      statsPeriod: options.statsPeriod,
      status: options.status,
    } as {
      cursor?: string;
      per_page?: number;
      query?: string;
      sort?: string;
      flatten?: number;
      health?: number;
      project?: number[];
      environment?: string[];
      statsPeriod?: string;
      status?: string;
    },
  });

  return unwrapPaginatedResult<SentryRelease[]>(
    result,
    "Failed to list releases",
  );
}

/**
 * List releases scoped to a specific project.
 *
 * Resolves the project slug to a numeric ID (required by the API's
 * `project` query param), then fetches with health data.
 */
export async function listReleasesForProject(
  orgSlug: string,
  projectSlug: string,
  options: Omit<ListReleasesOptions, "project"> = {},
): Promise<SentryRelease[]> {
  // Resolve slug → numeric ID (the API requires numeric project IDs)
  const info = await getProject(orgSlug, projectSlug);
  const n = Number(info.id);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError(
      `Project "${projectSlug}" has an invalid numeric ID: ${info.id}`,
    );
  }
  const { data } = await listReleasesPaginated(orgSlug, {
    ...options,
    project: [n],
    perPage: options.perPage ?? 100,
  });
  return data;
}

/** Sort options for the release list endpoint. */
export type ReleaseSortValue =
  | "date"
  | "sessions"
  | "users"
  | "crash_free_sessions"
  | "crash_free_users";

/**
 * Get a single release by version.
 * Version is URL-encoded by the SDK.
 *
 * When `health` is true, each project in the response includes a
 * `healthData` object with adoption percentages, crash-free rates,
 * and session/user counts for the requested period.
 *
 * @param orgSlug - Organization slug
 * @param version - Release version string (e.g., "1.0.0", "sentry-cli@0.24.0")
 * @param options - Optional health and adoption query parameters
 * @returns Full release detail
 */
export async function getRelease(
  orgSlug: string,
  version: string,
  options?: {
    /** Include per-project health/adoption data. */
    health?: boolean;
    /** Include adoption stage info (e.g., "adopted", "low_adoption"). */
    adoptionStages?: boolean;
    /** Period for health stats: "24h", "7d", "14d", etc. Defaults to "24h". */
    healthStatsPeriod?: string;
  },
): Promise<SentryRelease> {
  const config = await getOrgSdkConfig(orgSlug);

  const result = await getOrganizationRelease({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      version,
    },
    query: {
      health: options?.health,
      adoptionStages: options?.adoptionStages,
      healthStatsPeriod: options?.healthStatsPeriod as
        | "24h"
        | "7d"
        | "14d"
        | "30d"
        | "1h"
        | "1d"
        | "2d"
        | "48h"
        | "90d"
        | undefined,
    },
  });

  return unwrapResult<SentryRelease>(
    result,
    `Failed to get release '${version}'`,
  );
}

/**
 * Create a new release.
 *
 * @param orgSlug - Organization slug
 * @param body - Release creation payload
 * @returns Created release detail
 */
export async function createRelease(
  orgSlug: string,
  body: {
    version: string;
    projects?: string[];
    ref?: string;
    url?: string;
    dateReleased?: string;
    commits?: Array<{
      id: string;
      repository?: string;
      message?: string;
      author_name?: string;
      author_email?: string;
      timestamp?: string;
    }>;
  },
): Promise<SentryRelease> {
  const config = await getOrgSdkConfig(orgSlug);

  // Cast body through unknown — the SDK's body type requires `projects: string[]`
  // as non-optional, but the API accepts it as optional at runtime.
  const result = await createOrganizationRelease({
    ...config,
    path: { organization_id_or_slug: orgSlug },
    body: body as unknown as Parameters<
      typeof createOrganizationRelease
    >[0]["body"],
  });

  // 208 = release already exists (idempotent) — treat as success
  if (result.data) {
    return result.data as SentryRelease;
  }
  return unwrapResult<SentryRelease>(result, "Failed to create release");
}

/**
 * Update a release. Used for finalization, setting refs, etc.
 *
 * @param orgSlug - Organization slug
 * @param version - Release version (URL-encoded by SDK)
 * @param body - Fields to update
 * @returns Updated release detail
 */
export async function updateRelease(
  orgSlug: string,
  version: string,
  body: {
    ref?: string;
    url?: string;
    dateReleased?: string;
    /** Release lifecycle status: "open" (active) or "archived". */
    status?: "open" | "archived";
    commits?: Array<{
      id: string;
      repository?: string;
      message?: string;
      author_name?: string;
      author_email?: string;
      timestamp?: string;
    }>;
  },
): Promise<SentryRelease> {
  const config = await getOrgSdkConfig(orgSlug);

  const result = await updateOrganizationRelease({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      version,
    },
    body: body as unknown as Parameters<
      typeof updateOrganizationRelease
    >[0]["body"],
  });

  return unwrapResult<SentryRelease>(
    result,
    `Failed to update release '${version}'`,
  );
}

/**
 * Delete a release.
 *
 * @param orgSlug - Organization slug
 * @param version - Release version
 */
export async function deleteRelease(
  orgSlug: string,
  version: string,
): Promise<void> {
  const config = await getOrgSdkConfig(orgSlug);

  const result = await deleteOrganizationRelease({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      version,
    },
  });

  unwrapResult(result, `Failed to delete release '${version}'`);
}

/**
 * List deploys for a release.
 *
 * @param orgSlug - Organization slug
 * @param version - Release version
 * @returns Array of deploy details
 */
export async function listReleaseDeploys(
  orgSlug: string,
  version: string,
): Promise<SentryDeploy[]> {
  const config = await getOrgSdkConfig(orgSlug);

  const result = await listOrganizationReleaseDeploys({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      version,
    },
  });

  return unwrapResult<SentryDeploy[]>(
    result,
    `Failed to list deploys for release '${version}'`,
  );
}

/**
 * Create a deploy for a release.
 *
 * @param orgSlug - Organization slug
 * @param version - Release version
 * @param body - Deploy creation payload
 * @returns Created deploy detail
 */
export async function createReleaseDeploy(
  orgSlug: string,
  version: string,
  body: {
    environment: string;
    name?: string;
    url?: string;
    dateStarted?: string;
    dateFinished?: string;
  },
): Promise<SentryDeploy> {
  const config = await getOrgSdkConfig(orgSlug);

  const result = await createOrganizationReleaseDeploy({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      version,
    },
    body: body as unknown as Parameters<
      typeof createOrganizationReleaseDeploy
    >[0]["body"],
  });

  return unwrapResult<SentryDeploy>(result, "Failed to create deploy");
}

/**
 * Get the last commit SHA from the previous release that has commits.
 *
 * Uses the undocumented `/previous-with-commits/` endpoint (same as the
 * reference sentry-cli) to determine the commit baseline for range-based
 * commit association. Without this, Sentry can't compute which commits
 * are new in the current release and reports 0 commits.
 *
 * @param orgSlug - Organization slug
 * @param version - Current release version
 * @returns Previous release's last commit SHA, or undefined if no previous release
 */
async function getPreviousReleaseCommit(
  orgSlug: string,
  version: string,
): Promise<string | undefined> {
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const regionUrl = await resolveOrgRegion(orgSlug);
    const encodedVersion = encodeURIComponent(version);
    const { data } = await apiRequestToRegion<{
      lastCommit?: { id: string } | null;
    }>(
      regionUrl,
      `organizations/${orgSlug}/releases/${encodedVersion}/previous-with-commits/`,
      { method: "GET" },
    );
    return data?.lastCommit?.id;
  } catch {
    // Not critical — if we can't get the previous commit, we still send
    // refs without previousCommit. Sentry will try to determine the range
    // from its own data (may result in 0 commits for first releases).
    return;
  }
}

/**
 * Message of the client-side {@link ApiError} thrown by {@link setCommitsAuto}
 * when the org has no repository integrations. Exported so callers can
 * distinguish this specific no-repo-integration case from unrelated API errors
 * returned by the server (e.g. invalid commit refs), which must not be masked
 * as "no integration". Matched on `message` (not `detail`) because this error is
 * constructed client-side with `detail: undefined`.
 */
export const NO_REPO_INTEGRATIONS_MESSAGE =
  "No repository integrations configured for this organization.";

/** Where `--auto` found the repository and commit to associate. */
type AutoCheckout = {
  /** Repository path, e.g. `owner/repo`. */
  repository: string;
  /** Commit from the CI environment; read from git HEAD when absent. */
  commit?: string;
};

/**
 * Find the repository to match for `--auto`: the `origin` remote, or the
 * repository and commit that the CI provider exposes when the build has no
 * git checkout (Vercel, Docker builds that exclude `.git`).
 *
 * @throws {ValidationError} When neither source names a repository
 */
function resolveAutoCheckout(cwd?: string): AutoCheckout {
  const remoteRepo = getRepositoryName(cwd);
  if (remoteRepo) {
    return { repository: remoteRepo };
  }

  const env = getEnv();
  const ci = getCiCheckout(env);
  if (ci) {
    log.info(
      `No 'origin' git remote found. Using ${ci.repository}@${ci.commit.slice(0, 12)} from ${ci.source}.`,
    );
    return { repository: ci.repository, commit: ci.commit };
  }

  throw validationError(
    "Could not determine the repository from the local git remote or CI variables. --auto matches the 'origin' remote (or the repository named by CI variables such as GITHUB_REPOSITORY) against your Sentry repositories.",
    [
      "git remote add origin <url>",
      "sentry release set-commits <version> --local",
      "sentry release set-commits <version> --commit owner/repo@abc123",
    ],
    "repository",
    env.VERCEL
      ? "Vercel builds have no .git directory, and --auto only reads VERCEL_GIT_* in production builds. Use --commit to associate commits from preview builds."
      : undefined,
  );
}

/** Spaces around `/` in GitLab display names (`Group / Project`). */
const REPO_SEPARATOR_RE = /\s*\/\s*/g;

/**
 * Normalize a repository path for comparison. Sentry names GitLab
 * repositories by their display path (`Group / Project`), so spaces around
 * the separators are dropped.
 */
function normalizeRepoPath(path: string): string {
  return path.replace(REPO_SEPARATOR_RE, "/").toLowerCase();
}

/**
 * Whether a Sentry repository is the local repository. Matches the name
 * (GitHub, Bitbucket) or the path of the repository URL (GitLab and other
 * providers whose name is a display name), like the reference sentry-cli.
 */
function isSameRepository(repo: SentryRepository, localPath: string): boolean {
  if (normalizeRepoPath(repo.name) === localPath) {
    return true;
  }
  const urlPath = repo.url ? parseRemoteUrl(repo.url) : undefined;
  return urlPath !== undefined && urlPath.toLowerCase() === localPath;
}

/** Characters that GitLab slugs use where the display name has spaces. */
const SLUG_SEPARATOR_RE = /[-_.]+/g;

/**
 * Search the org's repositories for the local repository.
 *
 * Asks the server to filter by name (orgs can have tens of thousands of
 * repositories). The full path is tried first; GitLab names do not contain
 * it (`Group / Project`), so the last path segment is tried next, then that
 * segment with `-`, `_`, and `.` read as spaces, since GitLab derives the
 * slug `my-project` from the display name `My Project`. Hits are matched by
 * URL, so a loose query cannot pick the wrong repository.
 *
 * @returns The match, and whether any search returned repositories
 */
async function findSentryRepository(
  orgSlug: string,
  localRepo: string,
): Promise<{ match?: SentryRepository; foundAnyRepos: boolean }> {
  const localPath = normalizeRepoPath(localRepo);
  const lastSegment = localRepo.split("/").at(-1) ?? localRepo;
  const spacedSegment = lastSegment.replace(SLUG_SEPARATOR_RE, " ");
  const queries = [...new Set([localRepo, lastSegment, spacedSegment])];
  let foundAnyRepos = false;

  for (const query of queries) {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
      const result = await listRepositoriesPaginated(orgSlug, {
        cursor,
        perPage: API_MAX_PER_PAGE,
        query,
      });
      if (result.data.length > 0) {
        foundAnyRepos = true;
      }
      const match = result.data.find((r) => isSameRepository(r, localPath));
      if (match) {
        return { match, foundAnyRepos };
      }
      if (!result.nextCursor) {
        break;
      }
      cursor = result.nextCursor;
    }
  }

  return { foundAnyRepos };
}

/**
 * Set commits on a release using auto-discovery mode.
 *
 * Looks up the org's repositories by the name from the local git remote URL
 * (or the repository the CI provider exposes when there is no git checkout)
 * to find the corresponding Sentry repo, then sends a refs payload with the
 * HEAD commit SHA. This is the equivalent of the reference sentry-cli's
 * `--auto` mode.
 *
 * The lookup asks the server to filter by name instead of walking every page,
 * since orgs can have tens of thousands of repositories. Servers that ignore
 * the filter return every repository, which the exact name match still handles.
 *
 * Requires a GitHub/GitLab/Bitbucket integration configured in Sentry
 * AND a git origin remote or CI variables naming a matching Sentry repo.
 *
 * @param orgSlug - Organization slug
 * @param version - Release version
 * @param cwd - Working directory to discover git remote and HEAD from
 * @returns Updated release detail with commit count
 * @throws {ApiError} When the org has no repository integrations (404)
 * @throws {ValidationError} When no repository can be determined or none matches a Sentry repo
 */
export async function setCommitsAuto(
  orgSlug: string,
  version: string,
  cwd?: string,
): Promise<SentryRelease> {
  const checkout = resolveAutoCheckout(cwd);

  // The previous release's commit only depends on the org and version, not
  // on which repository matches, so fetch it concurrently with the repository
  // lookup instead of after it. getPreviousReleaseCommit never rejects.
  const previousCommitPromise = getPreviousReleaseCommit(orgSlug, version);

  const { match, foundAnyRepos } = await findSentryRepository(
    orgSlug,
    checkout.repository,
  );

  if (match) {
    const headCommit = checkout.commit ?? getHeadCommit(cwd);
    const previousCommit = await previousCommitPromise;
    const ref: {
      repository: string;
      commit: string;
      previousCommit?: string;
    } = { repository: match.name, commit: headCommit };
    if (previousCommit) {
      ref.previousCommit = previousCommit;
    }
    return await setCommitsWithRefs(orgSlug, version, [ref]);
  }

  // The name filter returns nothing for an org whose repositories all have
  // other names, so only report a missing integration when the org has none.
  if (!foundAnyRepos) {
    const anyRepo = await listRepositoriesPaginated(orgSlug, { perPage: 1 });
    if (anyRepo.data.length === 0) {
      const endpoint = `organizations/${orgSlug}/releases/${encodeURIComponent(version)}/`;
      throw new ApiError(
        NO_REPO_INTEGRATIONS_MESSAGE,
        404,
        undefined,
        endpoint,
      );
    }
  }

  throw new ValidationError(
    `No Sentry repository matching '${checkout.repository}'.`,
    "repository",
  );
}

/**
 * Set commits on a release using explicit refs (repository + commit range).
 *
 * Sends the refs format which supports previous commit for range-based
 * commit association (matching the reference sentry-cli's `--commit REPO@PREV..SHA`).
 *
 * @param orgSlug - Organization slug
 * @param version - Release version
 * @param refs - Array of ref objects
 * @returns Updated release detail
 */
export async function setCommitsWithRefs(
  orgSlug: string,
  version: string,
  refs: Array<{
    repository: string;
    commit: string;
    previousCommit?: string;
  }>,
): Promise<SentryRelease> {
  const encodedOrg = encodeApiPathSegment(orgSlug);
  if (encodedOrg === null) {
    throw new ValidationError("Invalid organization slug", "organization");
  }
  const encodedVersion = encodeApiPathSegment(version);
  if (encodedVersion === null) {
    throw new ValidationError("Invalid release version", "version");
  }
  const regionUrl = await resolveOrgRegion(orgSlug);
  const { data } = await apiRequestToRegion<SentryRelease>(
    regionUrl,
    `organizations/${encodedOrg}/releases/${encodedVersion}/`,
    {
      method: "PUT",
      body: { refs },
    },
  );
  return data;
}

/**
 * Set commits on a release using explicit commit data.
 *
 * @param orgSlug - Organization slug
 * @param version - Release version
 * @param commits - Array of commit data
 * @returns Updated release detail
 */
export function setCommitsLocal(
  orgSlug: string,
  version: string,
  commits: Array<{
    id: string;
    repository?: string;
    message?: string;
    author_name?: string;
    author_email?: string;
    timestamp?: string;
  }>,
): Promise<SentryRelease> {
  return updateRelease(orgSlug, version, { commits });
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

/** A visible project environment. */
export type ProjectEnvironment = {
  id: string;
  name: string;
  isHidden: boolean;
};

/**
 * List visible environments for a project.
 *
 * Lightweight call — returns a small array of `{ id, name, isHidden }`.
 * Used to auto-detect a production environment for smart defaults.
 */
export async function listProjectEnvironments(
  orgSlug: string,
  projectSlug: string,
): Promise<ProjectEnvironment[]> {
  const config = await getOrgSdkConfig(orgSlug);
  const result = await sdkListProjectEnvironments({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      project_id_or_slug: projectSlug,
    },
    query: { visibility: "visible" },
  });
  return unwrapResult<ProjectEnvironment[]>(
    result,
    "Failed to list environments",
  );
}
