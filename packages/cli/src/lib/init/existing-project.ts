import { getProject, tryGetPrimaryDsn } from "../api-client.js";
import { ApiError } from "../errors.js";
import { buildProjectUrl } from "../sentry-urls.js";
import type { ExistingProjectData } from "./types.js";

/**
 * Fetch Sentry metadata for an existing project.
 *
 * Returns `null` when the project does not exist, while allowing other API
 * errors to propagate so callers can decide whether the lookup is best-effort
 * or should fail the current operation.
 */
export async function tryGetExistingProjectData(
  orgSlug: string,
  projectSlug: string
): Promise<ExistingProjectData | null> {
  try {
    const project = await getProject(orgSlug, projectSlug);
    const dsn = await tryGetPrimaryDsn(orgSlug, project.slug);
    return {
      orgSlug,
      projectSlug: project.slug,
      projectId: project.id,
      dsn: dsn ?? "",
      url: buildProjectUrl(orgSlug, project.slug),
      ...(project.platform ? { platform: project.platform } : {}),
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}
