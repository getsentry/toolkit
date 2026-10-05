/**
 * sentry project delete
 *
 * Permanently delete a Sentry project.
 *
 * ## Flow
 *
 * 1. Parse target arg → extract org/project (e.g., "acme/my-app" or "my-app")
 * 2. Verify the project exists via `getProject` (also displays its name)
 * 3. Prompt for confirmation by typing `org/project` (unless --yes is passed)
 * 4. Call `deleteProject` API
 * 5. Display result
 *
 * Safety measures:
 * - Uses `buildDeleteCommand` — auto-injects `--yes`/`--force`/`--dry-run`
 *   flags and enforces the non-interactive guard before `func()` runs
 * - No auto-detect mode: `requireExplicitTarget` blocks accidental deletion
 * - Type-out confirmation via `confirmByTyping` (unless --yes/--force)
 */

import type { SentryContext } from "../../context.js";
import {
  deleteProject,
  getOrganization,
  getProject,
} from "../../lib/api-client.js";
import { parseOrgProjectArg } from "../../lib/arg-parsing.js";
import { getCachedOrgRole } from "../../lib/db/regions.js";
import { ApiError } from "../../lib/errors.js";
import {
  formatProjectDeleted,
  type ProjectDeleteResult,
} from "../../lib/formatters/human.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";
import {
  buildDeleteCommand,
  confirmByTyping,
  isConfirmationBypassed,
  requireExplicitTarget,
} from "../../lib/mutate-command.js";
import { resolveProjectBoundTarget } from "../../lib/resolve-target.js";
import { buildProjectUrl } from "../../lib/sentry-urls.js";

const log = logger.withTag("project.delete");

/** Command name used in error messages and resolution hints */
const COMMAND_NAME = "project delete";

/**
 * Build an actionable 403 error by checking the user's org role.
 *
 * - member/billing → tell them they need a higher role
 * - manager/owner/admin → suggest checking token scope
 * - unknown/fetch failure → generic message covering both cases
 *
 * Never suggests `sentry auth login` — re-authenticating via OAuth won't
 * change permissions. The issue is either an insufficient org role or
 * a custom auth token missing the `project:admin` scope.
 */
async function buildPermissionError(
  orgSlug: string,
  projectSlug: string
): Promise<ApiError> {
  const label = `'${orgSlug}/${projectSlug}'`;
  const rolesWithAccess = "Manager, Owner, or Admin";

  // Try the org cache first (populated by listOrganizations), then fall back
  // to a fresh API call. The cache avoids an extra HTTP round-trip when the
  // org listing has already been fetched during this session.
  let orgRole = getCachedOrgRole(orgSlug);
  if (!orgRole) {
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      const org = await getOrganization(orgSlug);
      orgRole = (org as Record<string, unknown>).orgRole as string | undefined;
    } catch {
      // Fall through to generic message
    }
  }

  if (orgRole && ["member", "billing"].includes(orgRole)) {
    return new ApiError(
      `Permission denied: cannot delete ${label}.\n\n` +
        `Your organization role is '${orgRole}'. ` +
        `Project deletion requires a ${rolesWithAccess} role.\n` +
        "  Contact an org admin to change your role or delete the project for you.",
      403
    );
  }

  if (orgRole && ["manager", "owner", "admin"].includes(orgRole)) {
    return new ApiError(
      `Permission denied: cannot delete ${label}.\n\n` +
        `Your org role ('${orgRole}') should have permission. ` +
        "If using a custom auth token, ensure it includes the 'project:admin' scope.",
      403
    );
  }

  return new ApiError(
    `Permission denied: cannot delete ${label}.\n\n` +
      `This requires a ${rolesWithAccess} role, or a token with the 'project:admin' scope.\n` +
      `  Check your role:  sentry org view ${orgSlug}`,
    403
  );
}

/** Build a result object for both dry-run and actual deletion */
function buildResult(
  orgSlug: string,
  project: { slug: string; name: string },
  dryRun?: boolean
): ProjectDeleteResult {
  return {
    orgSlug,
    projectSlug: project.slug,
    projectName: project.name,
    url: buildProjectUrl(orgSlug, project.slug),
    dryRun,
  };
}

type DeleteFlags = {
  readonly yes: boolean;
  readonly force: boolean;
  readonly "dry-run": boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

export const deleteCommand = buildDeleteCommand({
  docs: {
    brief: "Delete a project",
    fullDescription:
      "Permanently delete a Sentry project. This action cannot be undone.\n\n" +
      "Requires explicit target — auto-detection is disabled for safety.\n\n" +
      "Examples:\n" +
      "  sentry project delete acme-corp/my-app\n" +
      "  sentry project delete my-app\n" +
      "  sentry project delete acme-corp/my-app --yes\n" +
      "  sentry project delete acme-corp/my-app --force\n" +
      "  sentry project delete acme-corp/my-app --dry-run",
  },
  output: {
    human: formatProjectDeleted,
    jsonTransform: (result: ProjectDeleteResult) => {
      if (result.dryRun) {
        return {
          dryRun: true,
          org: result.orgSlug,
          project: result.projectSlug,
          name: result.projectName,
          url: result.url,
        };
      }
      return {
        deleted: true,
        org: result.orgSlug,
        project: result.projectSlug,
      };
    },
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/project",
          brief: "<org>/<project> or <project> (search across orgs)",
          parse: String,
        },
      ],
    },
  },
  async *func(this: SentryContext, flags: DeleteFlags, target: string) {
    const { cwd } = this;

    // Block auto-detect for safety — destructive commands require explicit targets
    const parsed = parseOrgProjectArg(target);
    requireExplicitTarget(
      parsed,
      "Project target",
      `sentry ${COMMAND_NAME} <org>/<project>`
    );

    const resolved = await resolveProjectBoundTarget(parsed, cwd, COMMAND_NAME);
    const { org: orgSlug, project: projectSlug } = resolved;

    // Use already-fetched project data from project-search, or fetch for
    // explicit/auto-detect paths (also verifies the project exists)
    const project =
      resolved.projectData ?? (await getProject(orgSlug, projectSlug));

    // Dry-run mode: show what would be deleted without deleting it
    if (flags["dry-run"]) {
      yield new CommandOutput(buildResult(orgSlug, project, true));
      return;
    }

    // Confirmation gate — non-interactive guard is handled by buildDeleteCommand
    if (!isConfirmationBypassed(flags)) {
      const expected = `${orgSlug}/${project.slug}`;
      const confirmed = await confirmByTyping(
        expected,
        `Type '${expected}' to permanently delete project '${project.name}':`
      );
      if (!confirmed) {
        log.info("Cancelled.");
        return;
      }
    }

    try {
      await deleteProject(orgSlug, project.slug);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        throw await buildPermissionError(orgSlug, project.slug);
      }
      throw error;
    }

    yield new CommandOutput(buildResult(orgSlug, project));
  },
});
