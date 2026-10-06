/**
 * Team API functions
 *
 * CRUD operations for Sentry teams, including project-scoped team listing.
 */

import {
  addOrganizationMemberTeam,
  createOrganizationTeam,
  listOrganizationTeams,
  listProjectTeams as sdkListProjectTeams,
} from "@sentry/api";
// biome-ignore lint/performance/noNamespaceImport: Sentry SDK recommends namespace import
import * as Sentry from "@sentry/node-core/light";

import type { SentryTeam } from "../../types/index.js";

import { logger } from "../logger.js";

import {
  getOrgSdkConfig,
  type PaginatedResponse,
  unwrapPaginatedResult,
  unwrapResult,
} from "./infrastructure.js";

/**
 * List teams in an organization.
 * Uses region-aware routing for multi-region support.
 */
export async function listTeams(orgSlug: string): Promise<SentryTeam[]> {
  const config = await getOrgSdkConfig(orgSlug);

  const result = await listOrganizationTeams({
    ...config,
    path: { organization_id_or_slug: orgSlug },
  });

  return unwrapResult<SentryTeam[]>(result, "Failed to list teams");
}

/**
 * List teams in an organization with pagination control.
 * Returns a single page of results with cursor metadata.
 *
 * @param orgSlug - Organization slug
 * @param options - Pagination options
 * @returns Single page of teams with cursor metadata
 */
export async function listTeamsPaginated(
  orgSlug: string,
  options: { cursor?: string; perPage?: number } = {}
): Promise<PaginatedResponse<SentryTeam[]>> {
  const config = await getOrgSdkConfig(orgSlug);

  const result = await listOrganizationTeams({
    ...config,
    path: { organization_id_or_slug: orgSlug },
    query: {
      cursor: options.cursor,
      per_page: options.perPage ?? 25,
    } as { cursor?: string; per_page?: number },
  });

  return unwrapPaginatedResult<SentryTeam[]>(result, "Failed to list teams");
}

/**
 * List teams that have access to a specific project.
 *
 * Uses the project-scoped endpoint (`/projects/{org}/{project}/teams/`) which
 * returns only the teams with access to that project, not all teams in the org.
 *
 * @param orgSlug - Organization slug
 * @param projectSlug - Project slug
 * @returns Teams with access to the project
 */
export async function listProjectTeams(
  orgSlug: string,
  projectSlug: string
): Promise<SentryTeam[]> {
  const config = await getOrgSdkConfig(orgSlug);
  const result = await sdkListProjectTeams({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      project_id_or_slug: projectSlug,
    },
  });
  return unwrapResult<SentryTeam[]>(result, "Failed to list project teams");
}

/**
 * Create a new team in an organization and add the current user as a member.
 *
 * The Sentry API does not automatically add the creator to a new team,
 * so we follow up with an `addMemberToTeam("me")` call. The member-add
 * is best-effort — if it fails (e.g., permissions), the team is still
 * returned successfully.
 *
 * @param orgSlug - The organization slug
 * @param slug - Team slug (also used as display name)
 * @returns The created team
 */
export async function createTeam(
  orgSlug: string,
  slug: string
): Promise<SentryTeam> {
  const config = await getOrgSdkConfig(orgSlug);
  const result = await createOrganizationTeam({
    ...config,
    path: { organization_id_or_slug: orgSlug },
    body: { slug },
  });
  const team = unwrapResult<SentryTeam>(result, "Failed to create team");

  // Best-effort: add the current user to the team
  try {
    await addMemberToTeam(orgSlug, team.slug, "me");
  } catch (error) {
    Sentry.captureException(error, {
      extra: { orgSlug, teamSlug: team.slug, context: "auto-add member" },
    });
    logger.warn(
      `Team '${team.slug}' was created but you could not be added as a member.`
    );
  }

  return team;
}

/**
 * Add an organization member to a team.
 *
 * @param orgSlug - The organization slug
 * @param teamSlug - The team slug
 * @param memberId - The member ID (use "me" for the current user)
 */
export async function addMemberToTeam(
  orgSlug: string,
  teamSlug: string,
  memberId: string
): Promise<void> {
  const config = await getOrgSdkConfig(orgSlug);
  const result = await addOrganizationMemberTeam({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      member_id: memberId,
      team_id_or_slug: teamSlug,
    },
  });
  unwrapResult(result, "Failed to add member to team");
}
