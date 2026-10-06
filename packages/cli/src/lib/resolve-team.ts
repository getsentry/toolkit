/**
 * Team Resolution
 *
 * Resolves which team to use for operations that require one (e.g., project creation).
 * Shared across create commands that need a team in the API path.
 *
 * ## Resolution flow
 *
 * 1. Explicit `--team` flag → use as-is, no validation
 * 2. Fetch org teams via `listTeams`
 *    - On 404: org doesn't exist → resolve effective org via cache, show org list
 *    - On other errors: surface status + generic hint
 * 3. If zero teams → auto-create a team named after the project (slug-based),
 *    or defer init-specific creation until the final slug is known
 * 4. If exactly one team → auto-select it
 * 5. Filter to teams the user belongs to (`isMember === true`)
 *    - If exactly one member team → auto-select it
 * 6. Multiple candidate teams → error with team list and `--team` hint
 *
 * The auto-created team (step 3) mirrors the Sentry UI behavior where new
 * organizations always have at least one team.
 */

import type { SentryTeam } from "../types/index.js";
import { createTeam, listOrganizations, listTeams } from "./api-client.js";
import {
  ApiError,
  AuthError,
  CliError,
  ContextError,
  ResolutionError,
} from "./errors.js";
import { logger } from "./logger.js";
import { resolveEffectiveOrg } from "./region.js";
import { getSentryBaseUrl } from "./sentry-urls.js";

const log = logger.withTag("resolve-team");

/**
 * Best-effort fetch the user's organizations and format as a hint string.
 * Returns a fallback hint if the API call fails or no orgs are found.
 *
 * @param fallbackHint - Shown when the org list can't be fetched
 * @returns Formatted org list like "Your organizations:\n\n  acme-corp\n  other-org"
 */
async function fetchOrgListHint(fallbackHint: string): Promise<string> {
  try {
    const orgs = await listOrganizations();
    if (orgs.length > 0) {
      const orgList = orgs.map((o) => `  ${o.slug}`).join("\n");
      return `Your organizations:\n\n${orgList}`;
    }
  } catch (error) {
    log.debug("Failed to fetch org list for hint", error);
  }
  return fallbackHint;
}

/** Options for resolving a team within an organization */
export type ResolveTeamOptions = {
  /** Explicit team slug from --team flag */
  team?: string;
  /** Source of the auto-detected org, shown in error messages */
  detectedFrom?: string;
  /** Usage hint shown in errors (e.g., "sentry project create <org>/<name>:<platform>") */
  usageHint: string;
  /**
   * Slug to use when auto-creating a team in an empty org.
   * If not provided and the org has zero teams, an error is thrown instead
   * unless empty-org auto-creation is being deferred.
   */
  autoCreateSlug?: string;
  /**
   * When true, skip the actual team creation API call and return what
   * would be created. The returned ResolvedTeam has source "auto-created"
   * with the autoCreateSlug value.
   */
  dryRun?: boolean;
  /**
   * When true, an empty org returns a deferred result instead of auto-creating
   * a team immediately. This lets callers wait until they know the final slug.
   */
  deferAutoCreateOnEmptyOrg?: boolean;
  /**
   * Called when multiple candidate teams remain after membership filtering.
   * Return the selected team slug. If not provided, a ContextError is thrown.
   */
  onAmbiguous?: (candidates: SentryTeam[]) => Promise<string>;
};

/** Result of team resolution that produced a concrete team slug. */
export type ResolvedConcreteTeam = {
  /** The resolved team slug */
  slug: string;
  /** How the team was determined */
  source: "explicit" | "auto-selected" | "auto-created";
};

/** Result of init-specific deferred team resolution for empty organizations. */
export type DeferredResolvedTeam = {
  /** Indicates that team creation should happen later once the final slug is known. */
  source: "deferred";
};

/** Result of team resolution, including deferred empty-org handling for init. */
export type ResolvedTeam = ResolvedConcreteTeam | DeferredResolvedTeam;

/**
 * Resolve which team to use for an operation.
 *
 * @param orgSlug - Organization to list teams from
 * @param options - Resolution options (team flag, usage hint, detection source)
 * @returns Resolved team slug with source info
 * @throws {ContextError} When team cannot be resolved
 * @throws {ResolutionError} When org slug returns 404
 */

/**
 * Handle errors from `listTeams` during team resolution.
 *
 * - 404 → org not found (builds a rich error with org list)
 * - 403 → member lacks team:read; re-thrown as `ApiError` so callers that
 *   implement a member-accessible fallback can detect it and use
 *   POST /organizations/{org}/projects/ instead.
 * - 401 → re-thrown as `ApiError` so the enriched detail (expired session,
 *   member-disabled-over-limit, etc.) survives instead of being flattened.
 * - other → generic ResolutionError (5xx, network, etc.)
 */
async function handleListTeamsError(
  error: unknown,
  orgSlug: string,
  options: ResolveTeamOptions
): Promise<never> {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return await buildOrgNotFoundError(
        orgSlug,
        options.usageHint,
        options.detectedFrom
      );
    }
    if (error.status === 403) {
      throw error;
    }
    if (error.status === 401) {
      throw error;
    }
    throw new ResolutionError(
      `Organization '${orgSlug}'`,
      `could not be accessed (${error.status})`,
      `${options.usageHint} --team <team-slug>`,
      ["The organization may not exist, or you may lack access"]
    );
  }
  throw error;
}

export async function resolveOrCreateTeam(
  orgSlug: string,
  options: ResolveTeamOptions & {
    deferAutoCreateOnEmptyOrg?: false | undefined;
  }
): Promise<ResolvedConcreteTeam>;
export async function resolveOrCreateTeam(
  orgSlug: string,
  options: ResolveTeamOptions & { deferAutoCreateOnEmptyOrg: true }
): Promise<ResolvedTeam>;
export async function resolveOrCreateTeam(
  orgSlug: string,
  options: ResolveTeamOptions
): Promise<ResolvedTeam> {
  if (options.team) {
    return { slug: options.team, source: "explicit" };
  }

  let teams: SentryTeam[];
  try {
    teams = await listTeams(orgSlug);
  } catch (error) {
    return await handleListTeamsError(error, orgSlug, options);
  }

  // No teams — auto-create one if a slug was provided
  if (teams.length === 0) {
    return resolveEmptyTeams(orgSlug, options);
  }

  // Single team — auto-select
  if (teams.length === 1) {
    return { slug: (teams[0] as SentryTeam).slug, source: "auto-selected" };
  }

  // Multiple teams — prefer teams the user belongs to
  const memberTeams = teams.filter((t) => t.isMember === true);
  const candidates = memberTeams.length > 0 ? memberTeams : teams;

  if (candidates.length === 1) {
    return {
      slug: (candidates[0] as SentryTeam).slug,
      source: "auto-selected",
    };
  }

  // Multiple candidates — let caller choose or throw
  if (options.onAmbiguous) {
    const slug = await options.onAmbiguous(candidates);
    return { slug, source: "auto-selected" };
  }

  const label =
    memberTeams.length > 0
      ? `You belong to ${candidates.length} teams in ${orgSlug}`
      : `Multiple teams found in ${orgSlug}`;
  throw new ContextError(
    "Team",
    `${options.usageHint} --team ${(candidates[0] as SentryTeam).slug}`,
    [
      `${label}. Specify one with --team`,
      ...candidates.map((t) => `Available: ${t.slug}`),
    ]
  );
}

/**
 * Handle the case when an org has zero teams.
 * Either defers init-specific creation, auto-creates a team, returns a dry-run
 * preview, or throws.
 */
function resolveEmptyTeams(
  orgSlug: string,
  options: ResolveTeamOptions
): Promise<ResolvedTeam> | ResolvedTeam {
  if (options.deferAutoCreateOnEmptyOrg) {
    return { source: "deferred" };
  }
  if (!options.autoCreateSlug) {
    const teamsUrl = `${getSentryBaseUrl()}/settings/${orgSlug}/teams/`;
    throw new ContextError("Team", `${options.usageHint} --team <team-slug>`, [
      `No teams found in org '${orgSlug}'`,
      `Create a team at ${teamsUrl}`,
    ]);
  }
  if (options.dryRun) {
    return { slug: options.autoCreateSlug, source: "auto-created" };
  }
  return autoCreateTeam(orgSlug, options.autoCreateSlug);
}

/**
 * Auto-create a team in an org that has no teams.
 * Uses the provided slug as the team name.
 */
async function autoCreateTeam(
  orgSlug: string,
  slug: string
): Promise<ResolvedTeam> {
  try {
    const team = await createTeam(orgSlug, slug);
    return { slug: team.slug, source: "auto-created" };
  } catch (error) {
    // Let auth errors propagate so the central handler can trigger auto-login
    if (error instanceof AuthError) {
      throw error;
    }
    // 403 means the user lacks permission to create teams (e.g., org member role).
    // Re-throw as ApiError so callers can fall back to the org-scoped endpoint
    // (POST /organizations/{org}/projects/) instead of showing a dead-end error.
    if (error instanceof ApiError && error.status === 403) {
      throw error;
    }
    // Other failures (permissions, network, etc.) — surface with manual fallback
    throw new CliError(
      `No teams found in org '${orgSlug}' and automatic team creation failed.\n\n` +
        `Create a team manually at ${getSentryBaseUrl()}/settings/${orgSlug}/teams/` +
        (error instanceof ApiError
          ? `\n\nAPI error (${error.status}): ${error.detail ?? error.message}`
          : "")
    );
  }
}

/**
 * Build an error for when an org slug is not found (404).
 * Uses resolveEffectiveOrg for offline validation of DSN org prefixes,
 * then best-effort fetches the user's actual organizations to help them fix it.
 *
 * @param orgSlug - The org slug that was not found
 * @param usageHint - Usage example shown in error message
 * @param detectedFrom - Where the org was auto-detected from, if applicable
 */
export async function buildOrgNotFoundError(
  orgSlug: string,
  usageHint: string,
  detectedFrom?: string
): Promise<never> {
  // Try resolving DSN-style org IDs (e.g., o1081365 → actual slug)
  const effectiveOrg = await resolveEffectiveOrg(orgSlug);
  if (effectiveOrg !== orgSlug) {
    throw new ResolutionError(
      `Organization '${orgSlug}'`,
      `not found (did you mean '${effectiveOrg}'?)`,
      usageHint,
      [`Try using '${effectiveOrg}' as the org slug instead of '${orgSlug}'`]
    );
  }

  const orgHint = await fetchOrgListHint(
    `Specify org explicitly: ${usageHint}`
  );

  const suggestions: string[] = [];
  if (detectedFrom) {
    suggestions.push(`Org '${orgSlug}' was auto-detected from ${detectedFrom}`);
  }
  suggestions.push(orgHint);

  throw new ResolutionError(
    `Organization '${orgSlug}'`,
    "not found",
    usageHint,
    suggestions
  );
}
