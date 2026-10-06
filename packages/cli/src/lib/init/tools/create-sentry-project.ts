/**
 * Sentry project creation tool for the init wizard.
 *
 * Implements the `create-sentry-project` and `ensure-sentry-project` wizard
 * operations. Uses the team-scoped endpoint for explicit or Team Admin teams;
 * otherwise uses POST /organizations/{org}/projects/, the onboarding endpoint
 * that auto-creates a personal team for eligible members.
 */

import { captureException } from "@sentry/node-core/light";
import {
  createProjectWithAutoTeam,
  createProjectWithDsn,
  MEMBER_PROJECT_CREATION_DISABLED_DETAIL,
} from "../../api-client.js";
import { ApiError } from "../../errors.js";
import { resolveOrCreateTeam } from "../../resolve-team.js";
import { captureOAuthScopeRecoveryGate } from "../../scope-recovery.js";
import { slugify } from "../../utils.js";
import { tryGetExistingProjectData } from "../existing-project.js";
import { formatMemberProjectCreationDisabledError } from "../project-creation-errors.js";
import type {
  CreateSentryProjectPayload,
  EnsureSentryProjectPayload,
  ToolResult,
} from "../types.js";
import { formatToolError } from "./shared.js";
import type { InitToolDefinition, ToolContext } from "./types.js";

type ProjectData = {
  projectSlug: string;
  projectId: string;
  dsn: string;
  url: string;
};

type ProjectCreationResponse = {
  project: {
    id: string;
    slug: string;
  };
  dsn?: string | null;
  url: string;
};

function toProjectData(response: ProjectCreationResponse): ProjectData {
  return {
    projectSlug: response.project.slug,
    projectId: response.project.id,
    dsn: response.dsn ?? "",
    url: response.url,
  };
}

/**
 * Resolve project creation using the frontend onboarding policy.
 *
 * @param opts.org - Organization slug
 * @param opts.name - Project display name
 * @param opts.platform - Platform identifier (null/undefined → omitted from request)
 * @param opts.team - Pre-resolved team slug (explicit or auto-selected by preflight).
 *   When undefined, use the org-scoped onboarding endpoint directly.
 * @param opts.suppressFallback - When true, a 403 from the team-scoped flow is
 *   surfaced directly rather than triggering the org-scoped fallback. Set only
 *   when the team was explicitly named via `--team` — a 403 there is meaningful
 *   user feedback, not a permission gap.
 * @returns Resolved project identifiers and DSN
 */
async function resolveProjectCreation(opts: {
  org: string;
  name: string;
  platform: string | null | undefined;
  team: string | undefined;
  suppressFallback: boolean;
}): Promise<ProjectData> {
  const { org, name, team, suppressFallback } = opts;
  // Coerce null → undefined: CreateProjectBody.platform is string | undefined.
  const platform = opts.platform ?? undefined;

  const withPlatformFallback = async (
    fn: (p: string | undefined) => Promise<ProjectData>
  ): Promise<ProjectData> => {
    try {
      return await fn(platform);
    } catch (err) {
      // The registry may include SDK keys whose derived platform slug (e.g.
      // "javascript-hono") is not yet in the Sentry API's allowed platform
      // list. Retry without a platform so the project is still created, and
      // capture to track which slugs need to be added to the API allowlist.
      if (
        err instanceof ApiError &&
        err.status === 400 &&
        platform &&
        err.detail?.includes("Invalid platform")
      ) {
        captureException(err, {
          extra: {
            attemptedPlatform: platform,
            projectName: name,
            apiResponseDetail: err.detail,
            apiStatus: err.status,
          },
        });
        return await fn(undefined);
      }
      throw err;
    }
  };

  if (!team) {
    return await withPlatformFallback(async (p) => {
      const result = await createProjectWithAutoTeam(org, {
        name,
        platform: p,
      });
      return toProjectData(result);
    });
  }

  try {
    return await withPlatformFallback(async (p) => {
      const result = await createProjectWithDsn(org, team, {
        name,
        platform: p,
      });
      return toProjectData(result);
    });
  } catch (innerError) {
    // Fall back to org-scoped endpoint on 403, unless the fallback is suppressed
    // (explicit --team means the 403 is meaningful feedback, not a permission gap).
    // Note: a 403 can originate from either the initial createProjectWithDsn call
    // or from the platform-less retry inside withPlatformFallback — both mean the
    // caller lacks team:write, so the org-scoped fallback is correct in either case.
    if (
      !(innerError instanceof ApiError && innerError.status === 403) ||
      suppressFallback
    ) {
      throw innerError;
    }
    // Policy 403: org has disabled member project creation. The org-scoped
    // endpoint enforces the same flag — re-throw immediately so the outer
    // catch surfaces the friendly disabled-policy message without a wasted round-trip.
    if (innerError.detail?.includes(MEMBER_PROJECT_CREATION_DISABLED_DETAIL)) {
      throw innerError;
    }
    return await withPlatformFallback(async (p) => {
      const result = await createProjectWithAutoTeam(org, {
        name,
        platform: p,
      });
      return toProjectData(result);
    });
  }
}

/**
 * Validate explicit team access for a dry-run, mirroring preflight.ts:resolveTeam.
 *
 * When `team` is undefined, preflight intentionally chose the org-scoped
 * onboarding endpoint, so there is no local team path to validate.
 *
 * @throws Non-403 errors from resolveOrCreateTeam (org not found, network, etc.)
 */
async function validateTeamForDryRun(
  org: string,
  team: string | undefined,
  autoCreateSlug: string
): Promise<void> {
  if (!team) {
    return;
  }

  try {
    await resolveOrCreateTeam(org, {
      team,
      autoCreateSlug,
      usageHint: "sentry init",
      dryRun: true,
      deferAutoCreateOnEmptyOrg: true,
    });
  } catch (teamErr) {
    if (!(teamErr instanceof ApiError && teamErr.status === 403)) {
      throw teamErr;
    }
  }
}

/**
 * Create a new Sentry project using the org that preflight already resolved.
 * When preflight does not resolve a Team Admin team, creation uses the same
 * org-scoped auto-team endpoint as Sentry onboarding.
 *
 * New Sentry orgs have member project creation disabled by default
 * (Organization.flags.disable_member_project_creation = true). When the org
 * restricts project creation for members, we surface a clear error with an
 * escape hatch: the user can pass `sentry init <org>/<project-slug>` once an
 * admin creates the project, which resolves to an existing project and skips
 * creation entirely (preflight.ts:261).
 */
export async function createSentryProject(
  payload: CreateSentryProjectPayload | EnsureSentryProjectPayload,
  context: Pick<
    ToolContext,
    | "dryRun"
    | "existingProject"
    | "isExplicitTeam"
    | "org"
    | "team"
    | "project"
    | "yes"
  >
): Promise<ToolResult> {
  const name = context.project ?? payload.params.name;
  const slug = slugify(name);
  if (!slug) {
    return {
      ok: false,
      error: `Invalid project name: "${name}" produces an empty slug.`,
    };
  }

  if (context.existingProject) {
    return {
      ok: true,
      message: `Using existing project "${context.existingProject.projectSlug}" in ${context.existingProject.orgSlug}`,
      data: context.existingProject,
    };
  }

  const scopeRecovery = captureOAuthScopeRecoveryGate();
  try {
    const existingProject = await tryGetExistingProjectData(context.org, slug);
    if (existingProject) {
      return {
        ok: true,
        message: `Using existing project "${existingProject.projectSlug}" in ${existingProject.orgSlug}`,
        data: existingProject,
      };
    }

    if (context.dryRun) {
      // Validate team access in dry-run — mirrors preflight.ts:resolveTeam.
      // Not needed in real runs: resolveProjectCreation handles its own resolution.
      await validateTeamForDryRun(context.org, context.team, slug);
      return {
        ok: true,
        data: {
          orgSlug: context.org,
          projectSlug: slug,
          projectId: "(dry-run)",
          dsn: "https://key@o0.ingest.sentry.io/0",
          url: "https://sentry.io/dry-run",
        },
      };
    }

    // Use the Team Admin path when preflight found one; otherwise use the
    // org-scoped onboarding path, which auto-creates a personal team for
    // eligible members.
    const projectData = await resolveProjectCreation({
      org: context.org,
      name,
      platform: payload.params.platform,
      team: context.team,
      suppressFallback: Boolean(context.isExplicitTeam),
    });

    return {
      ok: true,
      data: {
        orgSlug: context.org,
        projectSlug: projectData.projectSlug,
        projectId: projectData.projectId,
        dsn: projectData.dsn,
        url: projectData.url,
      },
    };
  } catch (error) {
    // Org-level policy: member project creation is disabled on this org.
    // Surface a clear message with the escape hatch.
    if (
      error instanceof ApiError &&
      error.status === 403 &&
      error.detail?.includes(MEMBER_PROJECT_CREATION_DISABLED_DETAIL)
    ) {
      return {
        ok: false,
        error: formatMemberProjectCreationDisabledError(context.org),
      };
    }
    if (
      await scopeRecovery.shouldDelegate(error, {
        unattended: context.yes || context.dryRun,
      })
    ) {
      throw error;
    }
    // 409: project already exists (from either the team-scoped or org-scoped
    // endpoint — both propagate here). Surface a friendly message with a view
    // hint rather than the raw API error text.
    if (error instanceof ApiError && error.status === 409) {
      return {
        ok: false,
        error:
          `A project named "${name}" already exists in "${context.org}".\n` +
          `View it: sentry project view ${context.org}/${slugify(name)}`,
      };
    }
    return { ok: false, error: formatToolError(error) };
  }
}

/**
 * Tool definition for creating or ensuring a Sentry project exists for init.
 */
const describeCreateSentryProject = (
  payload: CreateSentryProjectPayload | EnsureSentryProjectPayload
): string =>
  payload.detail ??
  `Ensuring project \`${payload.params.name}\` (${payload.params.platform})...`;

export const createSentryProjectTool: InitToolDefinition<"create-sentry-project"> =
  {
    operation: "create-sentry-project",
    describe: describeCreateSentryProject,
    execute: createSentryProject,
  };

export const ensureSentryProjectTool: InitToolDefinition<"ensure-sentry-project"> =
  {
    operation: "ensure-sentry-project",
    describe: describeCreateSentryProject,
    execute: createSentryProject,
  };
