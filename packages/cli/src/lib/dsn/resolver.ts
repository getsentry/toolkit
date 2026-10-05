/**
 * Project Resolver
 *
 * Resolves DSN to org/project information with caching.
 * Uses cached resolution when available to avoid API calls.
 */

import {
  findProjectByDsnKey,
  listOrganizations,
  listProjects,
  resolveOrgDisplayName,
} from "../api-client.js";
import { getCachedDsn, updateCachedResolution } from "../db/dsn-cache.js";
import { getDsnSourceDescription } from "./detector.js";
import type {
  DetectedDsn,
  ResolvedProject,
  ResolvedProjectInfo,
} from "./types.js";

/**
 * Resolve a detected DSN to full project information
 *
 * Uses cached resolution if available, otherwise fetches from API.
 * Updates cache with resolution for future use.
 *
 * @param cwd - Directory where DSN was detected
 * @param dsn - Detected DSN to resolve
 * @returns Resolved project with org/project slugs and names
 * @throws Error if DSN cannot be resolved (no org ID, API error, etc.)
 */
export async function resolveProject(
  cwd: string,
  dsn: DetectedDsn
): Promise<ResolvedProject> {
  // Check if we have cached resolution
  if (dsn.resolved) {
    return {
      ...dsn.resolved,
      dsn,
      sourceDescription: getDsnSourceDescription(dsn),
    };
  }

  // Check cache for resolution
  const cached = getCachedDsn(cwd);
  if (cached?.resolved && cached.dsn === dsn.raw) {
    return {
      ...cached.resolved,
      dsn,
      sourceDescription: getDsnSourceDescription(dsn),
    };
  }

  // Need to fetch from API
  // For DSNs without orgId, try to resolve by searching with the public key
  if (!dsn.orgId) {
    const project = await findProjectByDsnKey(dsn.publicKey);
    if (!project?.organization) {
      throw new Error(
        "Cannot resolve project: DSN could not be matched to any accessible project. " +
          "You may not have access, or specify the target explicitly: sentry <command> <org>/<project>"
      );
    }

    const resolved: ResolvedProjectInfo = {
      orgSlug: project.organization.slug,
      orgName: resolveOrgDisplayName(
        project.organization.slug,
        project.organization.name
      ),
      projectSlug: project.slug,
      projectName: project.name,
    };

    updateCachedResolution(cwd, resolved);

    return {
      ...resolved,
      dsn,
      sourceDescription: getDsnSourceDescription(dsn),
    };
  }

  const resolved = await fetchProjectInfo(dsn.orgId, dsn.projectId);

  // Update cache with resolution
  updateCachedResolution(cwd, resolved);

  return {
    ...resolved,
    dsn,
    sourceDescription: getDsnSourceDescription(dsn),
  };
}

/**
 * Fetch project info from Sentry API
 *
 * Since we only have orgId (numeric) and projectId (numeric) from the DSN,
 * we need to fetch the org and project to get slugs and names.
 */
async function fetchProjectInfo(
  orgId: string,
  projectId: string
): Promise<ResolvedProjectInfo> {
  // Fetch all orgs to find the one matching our orgId
  const orgs = await listOrganizations();

  // Find org by ID - org.id might be string or number depending on API
  const org = orgs.find((o) => String(o.id) === orgId);

  if (!org) {
    throw new Error(
      `Could not find organization with ID ${orgId}. ` +
        "You may not have access to this organization."
    );
  }

  // Fetch projects for this org to find the one matching our projectId
  const projects = await listProjects(org.slug);

  // Find project by ID
  const project = projects.find((p) => String(p.id) === projectId);

  if (!project) {
    throw new Error(
      `Could not find project with ID ${projectId} in organization ${org.slug}. ` +
        "You may not have access to this project."
    );
  }

  return {
    orgSlug: org.slug,
    orgName: org.name,
    projectSlug: project.slug,
    projectName: project.name,
  };
}

/** Project reference with org context */
type AccessibleProject = {
  org: string;
  project: string;
  orgName: string;
  projectName: string;
};

/**
 * Get list of accessible projects for the current user.
 * Fetches all projects from all accessible organizations.
 *
 * Used for "no DSN found" error messages to help user specify project.
 *
 * @returns Array of org/project pairs
 */
export async function getAccessibleProjects(): Promise<AccessibleProject[]> {
  const results: AccessibleProject[] = [];

  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const orgs = await listOrganizations();

    for (const org of orgs) {
      // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
      try {
        const projects = await listProjects(org.slug);

        for (const project of projects) {
          results.push({
            org: org.slug,
            project: project.slug,
            orgName: org.name,
            projectName: project.name,
          });
        }
      } catch {
        // Skip orgs we can't access
      }
    }
  } catch {
    // Not authenticated or API error
  }

  return results;
}
