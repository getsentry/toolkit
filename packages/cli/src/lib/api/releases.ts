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
  getOrganizationPreviousReleaseWithCommits,
  getOrganizationRelease,
  listOrganizationReleaseDeploys,
  listOrganizationReleases,
  listProjectEnvironments as sdkListProjectEnvironments,
  updateOrganizationRelease,
} from "@sentry/api";
import { encodeApiPathSegment } from "@sentry/api/client";
import type {
  SentryDeploy,
  SentryRelease,
  SentryRepository,
} from "../../types/index.js";
import { sentry } from "../app-identity.js";
import { getCiCheckout } from "../ci.js";
import { getEnv } from "../env.js";
import {
  ApiError,
  buildValidationMessage,
  ValidationError,
  validationError,
} from "../errors.js";
import {
  getHeadCommit,
  getRepositoryName,
  isInsideGitWorkTree,
  isSameRepository,
} from "../git.js";
import { logger } from "../logger.js";
import {
  buildRepositorySettingsUrl,
  buildSourceCodeIntegrationsUrl,
} from "../sentry-web-urls.js";
import {
  API_MAX_PER_PAGE,
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
  const config = getOrgSdkConfig();

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
  const config = getOrgSdkConfig();

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
  const config = getOrgSdkConfig();

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
  const config = getOrgSdkConfig();

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
  const config = getOrgSdkConfig();

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
  const config = getOrgSdkConfig();

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
  const config = getOrgSdkConfig();

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
    const result = await getOrganizationPreviousReleaseWithCommits({
      ...getOrgSdkConfig(),
      path: { organization_id_or_slug: orgSlug, version },
    });
    // Sentry answers `{}` when no earlier release has commits.
    const data = unwrapResult<{ lastCommit?: { id?: unknown } | null }>(
      result,
      "Failed to get previous release commit",
    );
    const id = data.lastCommit?.id;
    return typeof id === "string" ? id : undefined;
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
  /** Human-readable origin of `repository`, used in error messages. */
  source: string;
};

/**
 * Find the repository to match for `--auto`: the `origin` remote, or the
 * repository and commit that the CI provider exposes when the build has no
 * git checkout (Vercel, Docker builds that exclude `.git`).
 *
 * @throws {ValidationError} When neither source names a repository
 */
function resolveAutoCheckout(
  orgSlug: string,
  version: string,
  cwd?: string,
): AutoCheckout {
  const remoteRepo = getRepositoryName(cwd);
  if (remoteRepo) {
    return { repository: remoteRepo, source: "the 'origin' git remote" };
  }

  const env = getEnv();
  const ci = getCiCheckout(env);
  if (ci) {
    log.info(
      `No 'origin' git remote found. Using ${ci.repository}@${ci.commit.slice(0, 12)} from ${ci.source}.`,
    );
    return { repository: ci.repository, commit: ci.commit, source: ci.source };
  }

  // Adding a remote or reading local history only helps in a git checkout;
  // builds without .git (Vercel, Docker) can only pass the commit in.
  const inGitCheckout = isInsideGitWorkTree(cwd);
  const target = `${orgSlug}/${version}`;
  let note: string | undefined;
  if (env.VERCEL) {
    note =
      "Vercel builds have no .git directory, and --auto only reads VERCEL_GIT_* in production builds. Use --commit to associate commits from preview builds.";
  } else if (!inGitCheckout) {
    note =
      "Docker builds often exclude .git (.dockerignore). Pass the commit in, for example with --commit owner/repo@$GIT_SHA.";
  }
  throw validationError(
    "Could not determine the repository: there is no 'origin' git remote and no CI repository variables (GITHUB_REPOSITORY, CI_PROJECT_PATH, VERCEL_GIT_REPO_SLUG, ...). --auto needs one of them to match a Sentry repository.",
    [
      sentry`release set-commits ${target} --commit owner/repo@<commit-sha>`,
      ...(inGitCheckout
        ? [
            "git remote add origin <url>",
            sentry`release set-commits ${target} --local`,
          ]
        : []),
    ],
    "repository",
    note,
  );
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
 * slug `my-project` from the display name `My Project`. Hits must match the
 * exact name or the URL path, so a loose query cannot pick the wrong
 * repository.
 *
 * @returns The match, whether any search returned repositories, and the
 *   repositories that were returned (for "did you mean" hints)
 */
async function findSentryRepository(
  orgSlug: string,
  localRepo: string,
): Promise<{
  match?: SentryRepository;
  foundAnyRepos: boolean;
  candidates: SentryRepository[];
}> {
  const lastSegment = localRepo.split("/").at(-1) ?? localRepo;
  const spacedSegment = lastSegment.replace(SLUG_SEPARATOR_RE, " ");
  const queries = [...new Set([localRepo, lastSegment, spacedSegment])];
  const candidates: SentryRepository[] = [];
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
      const match = result.data.find((r) => isSameRepository(r, localRepo));
      if (match) {
        return { match, foundAnyRepos, candidates };
      }
      candidates.push(...result.data);
      if (!result.nextCursor) {
        break;
      }
      cursor = result.nextCursor;
    }
  }

  return { foundAnyRepos, candidates };
}

/** HEAD of the local checkout, or `undefined` when there is none. */
function readHeadCommit(cwd?: string): string | undefined {
  try {
    return getHeadCommit(cwd);
  } catch (error) {
    log.debug("Could not read HEAD for the --commit suggestion", error);
    return;
  }
}

/** How many similar repository names to suggest when nothing matches. */
const MAX_REPO_SUGGESTIONS = 3;

/**
 * Build the error for an org that has repositories but none matching the
 * local one: names similar repositories and links to the repository settings.
 */
function noMatchingRepositoryError(
  orgSlug: string,
  version: string,
  checkout: AutoCheckout,
  candidates: SentryRepository[],
  cwd?: string,
): ValidationError {
  const suggestions = [...new Set(candidates.map((r) => r.name))].slice(
    0,
    MAX_REPO_SUGGESTIONS,
  );
  const commit = checkout.commit ?? readHeadCommit(cwd) ?? "<commit-sha>";
  const target = `${orgSlug}/${version}`;
  const examples = [
    ...suggestions.map(
      (name) =>
        sentry`release set-commits ${target} --commit '${name}@${commit}'`,
    ),
    ...(isInsideGitWorkTree(cwd)
      ? [sentry`release set-commits ${target} --local`]
      : []),
  ];
  const didYouMean =
    suggestions.length > 0
      ? ` Sentry has similarly named repositories: ${suggestions.join(", ")}.`
      : "";
  return validationError(
    `No Sentry repository matching '${checkout.repository}' (from ${checkout.source}).${didYouMean}`,
    examples,
    "repository",
    `Add the repository to Sentry through your source code integration: ${buildRepositorySettingsUrl(orgSlug)}`,
  );
}

/** How an org with no repositories gets one: connect a source code integration. */
function connectIntegrationHint(orgSlug: string): string {
  return `Connect GitHub, GitLab, Bitbucket, or Azure DevOps to Sentry and add the repository: ${buildSourceCodeIntegrationsUrl(orgSlug)}`;
}

/** Whether the org has at least one repository from a source code integration. */
async function orgHasRepositories(orgSlug: string): Promise<boolean> {
  const page = await listRepositoriesPaginated(orgSlug, { perPage: 1 });
  return page.data.length > 0;
}

/**
 * Build the error for an org with no repositories at all. Nothing on the
 * command line can fix that, so the error links to the integration directory,
 * where the org connects GitHub, GitLab, Bitbucket, or Azure DevOps.
 *
 * Stays an {@link ApiError} with {@link NO_REPO_INTEGRATIONS_MESSAGE} so the
 * default mode can recognize it and fall back to local git history.
 */
function noRepoIntegrationError(
  orgSlug: string,
  version: string,
  cwd?: string,
): ApiError {
  const detail = buildValidationMessage(connectIntegrationHint(orgSlug), [
    sentry`integration list ${orgSlug}/`,
    ...(isInsideGitWorkTree(cwd)
      ? [sentry`release set-commits ${orgSlug}/${version} --local`]
      : []),
  ]);
  return new ApiError(
    NO_REPO_INTEGRATIONS_MESSAGE,
    404,
    detail,
    `organizations/${orgSlug}/repos/`,
  );
}

/**
 * Set commits on a release using auto-discovery mode.
 *
 * Finds the Sentry repository matching the local `origin` remote (or the
 * repository the CI provider exposes when there is no git checkout), then
 * sends a refs payload with the HEAD commit SHA. This is the equivalent of
 * the reference sentry-cli's `--auto` mode.
 *
 * Requires a GitHub/GitLab/Bitbucket integration configured in Sentry.
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
  const checkout = resolveAutoCheckout(orgSlug, version, cwd);

  // The previous release's commit only depends on the org and version, not
  // on which repository matches, so fetch it concurrently with the repository
  // lookup instead of after it. getPreviousReleaseCommit never rejects.
  const previousCommitPromise = getPreviousReleaseCommit(orgSlug, version);

  const { match, foundAnyRepos, candidates } = await findSentryRepository(
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
    if (!(await orgHasRepositories(orgSlug))) {
      throw noRepoIntegrationError(orgSlug, version, cwd);
    }
  }

  throw noMatchingRepositoryError(orgSlug, version, checkout, candidates, cwd);
}

/** A `--commit` ref: repository plus commit or commit range. */
type CommitRef = {
  repository: string;
  commit: string;
  previousCommit?: string;
};

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
  refs: CommitRef[],
): Promise<SentryRelease> {
  // The SDK percent-encodes path values but lets `.` and `..` through, which
  // would collapse the path; reject them here.
  if (encodeApiPathSegment(orgSlug) === null) {
    throw new ValidationError("Invalid organization slug", "organization");
  }
  if (encodeApiPathSegment(version) === null) {
    throw new ValidationError("Invalid release version", "version");
  }
  const config = getOrgSdkConfig();
  const result = await updateOrganizationRelease({
    ...config,
    path: { organization_id_or_slug: orgSlug, version },
    body: { refs },
  });
  return unwrapResult<SentryRelease>(
    result,
    `Failed to set commits on release '${version}'`,
  );
}

/**
 * Field of the {@link ValidationError} for a `--commit` repository the org
 * doesn't have, so this user configuration error can be told apart (CLI-2SK).
 */
const COMMIT_REPOSITORY_FIELD = "commit.repository";

/**
 * The server rejects refs whose repository the org doesn't have with a 400
 * whose detail is `{"refs":["Invalid repository names: a,b"]}` (Sentry
 * `Release.set_refs`, which matches names exactly).
 */
const INVALID_REPOSITORY_NAMES_RE = /Invalid repository names: ([^"\]]+)/;

/**
 * Repository names from the server's "Invalid repository names" 400, or
 * `undefined` for any other error.
 */
function invalidRepositoryNames(error: unknown): string[] | undefined {
  if (!(error instanceof ApiError && error.status === 400)) {
    return;
  }
  const invalid = error.detail?.match(INVALID_REPOSITORY_NAMES_RE)?.[1];
  return invalid?.split(",").map((n) => n.trim());
}

/**
 * Replace `--commit` repository names that Sentry rejected with the name of
 * the same repository in Sentry, when the names only differ (case, GitLab
 * display names, or a name that matches the repository URL).
 *
 * Sentry matches `--commit` names exactly, while build tools pass what the
 * host reports, such as `VERCEL_GIT_REPO_OWNER/VERCEL_GIT_REPO_SLUG`. Each
 * replacement is logged as a warning so the caller can fix the name.
 *
 * @param orgSlug - Organization slug
 * @param refs - The refs that were sent
 * @param error - The error thrown by {@link setCommitsWithRefs}
 * @returns The refs with Sentry's names, or `undefined` when the error is not
 *   an "Invalid repository names" 400 or a rejected repository has no match
 */
export async function correctRefRepositories(
  orgSlug: string,
  refs: CommitRef[],
  error: unknown,
): Promise<CommitRef[] | undefined> {
  const names = invalidRepositoryNames(error);
  if (!names) {
    return;
  }
  let matches: (SentryRepository | undefined)[];
  try {
    matches = await Promise.all(
      refs.map(async (ref) =>
        names.includes(ref.repository)
          ? (await findSentryRepository(orgSlug, ref.repository)).match
          : undefined,
      ),
    );
  } catch (lookupError) {
    log.debug("Could not look up repositories for --commit", lookupError);
    return;
  }
  const corrected: CommitRef[] = [];
  const replaced: { from: string; to: string }[] = [];
  for (const [index, ref] of refs.entries()) {
    if (!names.includes(ref.repository)) {
      corrected.push(ref);
      continue;
    }
    const match = matches[index];
    if (!match || match.name === ref.repository) {
      return;
    }
    replaced.push({ from: ref.repository, to: match.name });
    corrected.push({ ...ref, repository: match.name });
  }
  // Warn only once every rejected name has a match, so no warning claims a
  // replacement that the caller never retries with.
  for (const { from, to } of replaced) {
    log.warn(
      `Sentry organization '${orgSlug}' has no repository named '${from}'. Using '${to}', the same repository in Sentry.`,
    );
  }
  return corrected;
}

/**
 * Turn the server's "Invalid repository names" 400 from {@link setCommitsWithRefs}
 * into an error that says how to fix it: connect a source code integration
 * when the org has no repositories, use the exact Sentry name when the
 * repository exists under a different name (case, GitLab display names), or
 * add the repository in Sentry otherwise.
 *
 * Any other error is returned unchanged. Repository lookups are best-effort:
 * when they fail, the error still links to the repository settings.
 *
 * @param orgSlug - Organization slug
 * @param version - Release version
 * @param refs - The refs that were sent
 * @param error - The error thrown by {@link setCommitsWithRefs}
 * @returns The error to throw
 */
export async function explainSetCommitsError(
  orgSlug: string,
  version: string,
  refs: CommitRef[],
  error: unknown,
): Promise<unknown> {
  const names = invalidRepositoryNames(error);
  if (!names) {
    return error;
  }
  const ref = refs.find((r) => names.includes(r.repository)) ?? refs[0];
  const repository = ref?.repository ?? names[0] ?? "";
  const commit = ref?.previousCommit
    ? `${ref.previousCommit}..${ref.commit}`
    : (ref?.commit ?? "<commit-sha>");
  const target = `${orgSlug}/${version}`;
  const commitExample = (name: string) =>
    sentry`release set-commits ${target} --commit '${name}@${commit}'`;
  const headline = `Sentry organization '${orgSlug}' has no repository named '${repository}'.`;

  let match: SentryRepository | undefined;
  let candidates: SentryRepository[] = [];
  let hasRepositories: boolean | undefined;
  try {
    const found = await findSentryRepository(orgSlug, repository);
    match = found.match;
    candidates = found.candidates;
    hasRepositories =
      found.foundAnyRepos || (await orgHasRepositories(orgSlug));
  } catch (lookupError) {
    log.debug(
      "Could not look up repositories for the --commit error",
      lookupError,
    );
  }

  if (match) {
    return validationError(
      `${headline} It has '${match.name}'. --commit needs the repository name exactly as Sentry shows it.`,
      [commitExample(match.name)],
      COMMIT_REPOSITORY_FIELD,
    );
  }
  if (hasRepositories === false) {
    return validationError(
      `${headline} It has no repositories yet, so it cannot associate commits.`,
      [sentry`integration list ${orgSlug}/`],
      COMMIT_REPOSITORY_FIELD,
      connectIntegrationHint(orgSlug),
    );
  }
  const suggestions = [...new Set(candidates.map((r) => r.name))].slice(
    0,
    MAX_REPO_SUGGESTIONS,
  );
  const didYouMean =
    suggestions.length > 0
      ? ` It has similarly named repositories: ${suggestions.join(", ")}.`
      : "";
  return validationError(
    `${headline}${didYouMean}`,
    [...suggestions.map(commitExample), sentry`repo list ${orgSlug}/`],
    COMMIT_REPOSITORY_FIELD,
    `Add the repository to Sentry through your source code integration: ${buildRepositorySettingsUrl(orgSlug)}`,
  );
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
  const config = getOrgSdkConfig();
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
