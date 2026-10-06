/**
 * sentry dashboard create
 *
 * Create a new dashboard in a Sentry organization.
 */

import type { SentryContext } from "../../context.js";
import { createDashboard, getProject } from "../../lib/api-client.js";
import {
  type ParsedOrgProject,
  parseOrgProjectArg,
} from "../../lib/arg-parsing.js";
import { buildCommand } from "../../lib/command.js";
import { ContextError, ValidationError } from "../../lib/errors.js";
import { formatDashboardCreated } from "../../lib/formatters/human.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  fetchProjectId,
  resolveAllTargets,
  resolveOrg,
  resolveProjectBoundSlug,
  toNumericId,
} from "../../lib/resolve-target.js";
import { buildDashboardUrl } from "../../lib/sentry-urls.js";
import { setOrgProjectContext } from "../../lib/telemetry.js";
import type { DashboardDetail } from "../../types/dashboard.js";
import { enrichDashboardError } from "./resolve.js";

type CreateFlags = {
  readonly json: boolean;
  readonly fields?: string[];
};

type CreateResult = DashboardDetail & { url: string };

/**
 * Parse array positional args for `dashboard create`.
 *
 * Handles:
 * - `<title>` — title only (auto-detect org/project)
 * - `<target> <title>` — explicit target + title
 */
function parsePositionalArgs(args: string[]): {
  title: string;
  targetArg: string | undefined;
} {
  if (args.length === 0) {
    throw new ValidationError("Dashboard title is required.", "title");
  }
  if (args.length === 1) {
    return { title: args[0] as string, targetArg: undefined };
  }
  // Two args: first is target, second is title
  return { title: args[1] as string, targetArg: args[0] as string };
}

/** Result of resolving org + project IDs from the parsed target */
type ResolvedDashboardTarget = {
  orgSlug: string;
  projectIds: number[];
};

/** Enrich targets that lack a projectId by calling the project API */
async function enrichTargetProjectIds(
  targets: { org: string; project: string; projectId?: number }[]
): Promise<number[]> {
  const enriched = await Promise.all(
    targets.map(async (t) => {
      if (t.projectId !== undefined) {
        return t.projectId;
      }
      // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
      try {
        const info = await getProject(t.org, t.project);
        return toNumericId(info.id);
      } catch {
        return;
      }
    })
  );
  return enriched.filter((id): id is number => id !== undefined);
}

/** Resolve org and project IDs from the parsed target argument */
async function resolveDashboardTarget(
  parsed: ParsedOrgProject,
  cwd: string
): Promise<ResolvedDashboardTarget> {
  switch (parsed.type) {
    case "explicit": {
      setOrgProjectContext([parsed.org], [parsed.project]);
      const pid = await fetchProjectId(parsed.org, parsed.project);
      return {
        orgSlug: parsed.org,
        projectIds: pid !== undefined ? [pid] : [],
      };
    }
    case "org-all":
      setOrgProjectContext([parsed.org], []);
      return { orgSlug: parsed.org, projectIds: [] };

    case "project-search": {
      const found = await resolveProjectBoundSlug(
        parsed.projectSlug,
        "sentry dashboard create <org>/<project> <title>",
        undefined,
        parsed.originalSlug
      );
      const pid = toNumericId(found.projectData.id);
      return {
        orgSlug: found.org,
        projectIds: pid !== undefined ? [pid] : [],
      };
    }
    case "auto-detect": {
      const result = await resolveAllTargets({ cwd });
      if (result.targets.length === 0) {
        const resolved = await resolveOrg({ cwd });
        if (!resolved) {
          throw new ContextError(
            "Organization",
            "sentry dashboard create <org>/ <title>"
          );
        }
        return { orgSlug: resolved.org, projectIds: [] };
      }
      const orgSlug = (result.targets[0] as (typeof result.targets)[0]).org;
      const projectIds = await enrichTargetProjectIds(result.targets);
      return { orgSlug, projectIds };
    }
    default: {
      const _exhaustive: never = parsed;
      throw new Error(
        `Unexpected parsed type: ${(_exhaustive as { type: string }).type}`
      );
    }
  }
}

export const createCommand = buildCommand({
  docs: {
    brief: "Create a dashboard",
    fullDescription:
      "Create a new Sentry dashboard.\n\n" +
      "Examples:\n" +
      "  sentry dashboard create 'My Dashboard'\n" +
      "  sentry dashboard create my-org/ 'My Dashboard'\n" +
      "  sentry dashboard create my-org/my-project 'My Dashboard'\n\n" +
      "Add widgets after creation with:\n" +
      '  sentry dashboard widget add <dashboard> "My Widget" --display line --query count',
  },
  output: {
    human: formatDashboardCreated,
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        placeholder: "org/project/title",
        brief: "[<org/project>] <title>",
        parse: String,
      },
    },
    flags: {},
  },
  async *func(this: SentryContext, _flags: CreateFlags, ...args: string[]) {
    const { cwd } = this;

    const { title, targetArg } = parsePositionalArgs(args);
    const parsed = parseOrgProjectArg(targetArg);
    const { orgSlug, projectIds } = await resolveDashboardTarget(parsed, cwd);

    const dashboard = await createDashboard(orgSlug, {
      title,
      widgets: [],
      projects: projectIds.length > 0 ? projectIds : undefined,
    }).catch(async (error: unknown) =>
      enrichDashboardError(error, { orgSlug, operation: "create" })
    );
    const url = buildDashboardUrl(orgSlug, dashboard.id);

    yield new CommandOutput({ ...dashboard, url } as CreateResult);
    return { hint: `Dashboard: ${url}` };
  },
});
