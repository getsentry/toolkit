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
import type { SentryDeploy, SentryRelease } from "../../types/index.js";
import { ApiError, ValidationError, validationError } from "../errors.js";
import { getHeadCommit, getRepositoryName } from "../git.js";
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

export async function listReleasesPaginated(
  orgSlug: string,
  options: ListReleasesOptions = {}
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
      health?: number;
      project?: number[];
      environment?: string[];
      statsPeriod?: string;
      status?: string;
    },
  });

  return unwrapPaginatedResult<SentryRelease[]>(
    result,
    "Failed to list releases"
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
  options: Omit<ListReleasesOptions, "project"> = {}
): Promise<SentryRelease[]> {
  // Resolve slug → numeric ID (the API requires numeric project IDs)
  const info = await getProject(orgSlug, projectSlug);
  const n = Number(info.id);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError(
      `Project "${projectSlug}" has an invalid numeric ID: ${info.id}`
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
  }
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
    `Failed to get release '${version}'`
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
  }
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
  }
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
    `Failed to update release '${version}'`
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
  version: string
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
  version: string
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
    `Failed to list deploys for release '${version}'`
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
  }
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
  version: string
): Promise<string | undefined> {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const regionUrl = await resolveOrgRegion(orgSlug);
    const encodedVersion = encodeURIComponent(version);
    const { data } = await apiRequestToRegion<{
      lastCommit?: { id: string } | null;
    }>(
      regionUrl,
      `organizations/${orgSlug}/releases/${encodedVersion}/previous-with-commits/`,
      { method: "GET" }
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
 * Set commits on a release using auto-discovery mode.
 *
 * Lists the org's repositories from the Sentry API, matches against the
/**
 * Message of the client-side {@link ApiError} thrown by {@link setCommitsAuto}
 * when the org has no repository integrations. Exported so callers can
 * distinguish this specific no-repo-integration case from unrelated 400s
 * returned by the server (e.g. invalid commit refs), which must not be masked
 * as "no integration". Matched on `message` (not `detail`) because this error is
 * constructed client-side with `detail: undefined`.
 */
export const NO_REPO_INTEGRATIONS_MESSAGE =
  "No repository integrations configured for this organization.";

/**
 * local git remote URL to find the corresponding Sentry repo, then sends
 * a refs payload with the HEAD commit SHA. This is the equivalent of the
 * reference sentry-cli's `--auto` mode.
 *
 * Requires a GitHub/GitLab/Bitbucket integration configured in Sentry
 * AND a local git repository whose origin remote matches a Sentry repo.
 *
 * @param orgSlug - Organization slug
 * @param version - Release version
 * @param cwd - Working directory to discover git remote and HEAD from
 * @returns Updated release detail with commit count
 * @throws {ApiError} When the org has no repository integrations (400)
 * @throws {ValidationError} When local git remote is missing or doesn't match any Sentry repo
 */
export async function setCommitsAuto(
  orgSlug: string,
  version: string,
  cwd?: string
): Promise<SentryRelease> {
  const localRepo = getRepositoryName(cwd);
  if (!localRepo) {
    throw validationError(
      "Could not determine the repository from the local git remote. --auto matches the 'origin' remote against your Sentry repositories, so it needs a git checkout with an 'origin' remote configured.",
      [
        "git remote add origin <url>",
        "sentry release set-commits <version> --local",
        "sentry release set-commits <version> --commit owner/repo@abc123",
      ],
      "repository"
    );
  }

  // Paginate through org repos to find one matching the local git remote.
  // Stops as soon as a match is found to avoid unnecessary API calls.
  const localRepoLower = localRepo.toLowerCase();
  let cursor: string | undefined;
  let foundAnyRepos = false;

  for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
    const result = await listRepositoriesPaginated(orgSlug, {
      cursor,
      perPage: API_MAX_PER_PAGE,
    });

    if (result.data.length > 0) {
      foundAnyRepos = true;
    }

    const match = result.data.find(
      (r) => r.name.toLowerCase() === localRepoLower
    );
    if (match) {
      const headCommit = getHeadCommit(cwd);
      const previousCommit = await getPreviousReleaseCommit(orgSlug, version);
      const ref: {
        repository: string;
        commit: string;
        previousCommit?: string;
      } = { repository: match.name, commit: headCommit };
      if (previousCommit) {
        ref.previousCommit = previousCommit;
      }
      return setCommitsWithRefs(orgSlug, version, [ref]);
    }

    if (!result.nextCursor) {
      break;
    }
    cursor = result.nextCursor;
  }

  if (!foundAnyRepos) {
    const endpoint = `organizations/${orgSlug}/releases/${encodeURIComponent(version)}/`;
    throw new ApiError(NO_REPO_INTEGRATIONS_MESSAGE, 400, undefined, endpoint);
  }

  throw new ValidationError(
    `No Sentry repository matching '${localRepo}'.`,
    "repository"
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
  }>
): Promise<SentryRelease> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  const encodedVersion = encodeURIComponent(version);
  const { data } = await apiRequestToRegion<SentryRelease>(
    regionUrl,
    `organizations/${orgSlug}/releases/${encodedVersion}/`,
    {
      method: "PUT",
      body: { refs },
    }
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
  }>
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
  projectSlug: string
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
    "Failed to list environments"
  );
}
