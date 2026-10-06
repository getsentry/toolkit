/**
 * sentry project view
 *
 * View detailed information about Sentry projects.
 * Supports monorepos with multiple detected projects.
 */

import type { SentryContext } from "../../context.js";
import {
  getProject,
  resolveOrgDisplayName,
  tryGetPrimaryDsn,
} from "../../lib/api-client.js";
import {
  ProjectSpecificationType,
  parseOrgProjectArg,
} from "../../lib/arg-parsing.js";
import { openInBrowser } from "../../lib/browser.js";
import { buildCommand } from "../../lib/command.js";
import { AuthError, ContextError, withAuthGuard } from "../../lib/errors.js";
import { divider, formatProjectDetails } from "../../lib/formatters/index.js";
import { filterFields } from "../../lib/formatters/json.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
  TARGET_PATTERN_NOTE,
} from "../../lib/list-command.js";
import {
  type ResolvedTarget,
  resolveAllTargets,
  resolveProjectBoundSlug,
} from "../../lib/resolve-target.js";
import { buildProjectUrl } from "../../lib/sentry-urls.js";
import type { SentryProject } from "../../types/index.js";

type ViewFlags = {
  readonly json: boolean;
  readonly web: boolean;
  readonly fresh: boolean;
  readonly fields?: string[];
};

/** Usage hint for ContextError messages */
const USAGE_HINT = "sentry project view <org>/<project>";

/**
 * Build an error message for missing context, with optional DSN resolution hint.
 */
function buildContextError(skippedSelfHosted?: number): ContextError {
  if (skippedSelfHosted) {
    return new ContextError(
      "Organization and project",
      USAGE_HINT,
      undefined,
      `Found ${skippedSelfHosted} DSN(s) that could not be resolved — you may not have access to these projects`
    );
  }

  return new ContextError("Organization and project", USAGE_HINT);
}

/**
 * Handle --web flag: open a single project in browser.
 * Throws if multiple targets are found.
 */
async function handleWebView(resolvedTargets: ResolvedTarget[]): Promise<void> {
  if (resolvedTargets.length > 1) {
    throw new ContextError("Single project", `${USAGE_HINT} -w`, [
      `Found ${resolvedTargets.length} projects — specify which project to open in browser`,
    ]);
  }

  const target = resolvedTargets[0];
  await openInBrowser(
    target ? buildProjectUrl(target.org, target.project) : undefined,
    "project"
  );
}

/**
 * A project entry enriched with its DSN and optional detection source.
 * This is the data shape returned by the command for both JSON and human output.
 */
type ProjectViewEntry = SentryProject & {
  /** Primary DSN for the project, or null if unavailable */
  dsn: string | null;
  /** Where the project was auto-detected from (e.g. ".env", "source code") */
  detectedFrom?: string;
};

/** Result of fetching a single project with its DSN */
type ProjectWithDsn = {
  project: SentryProject;
  dsn: string | null;
};

/**
 * Parallel project + DSN fetch for a single target.
 *
 * `AuthError` always propagates so the auto-login middleware fires.
 * Other API failures rethrow so callers can choose to swallow
 * (auto-detect) or surface (explicit/search) them.
 */
async function fetchProjectAndDsn(
  target: ResolvedTarget
): Promise<ProjectWithDsn> {
  const result = await withAuthGuard(async () => {
    const [project, dsn] = await Promise.all([
      target.projectData
        ? Promise.resolve(target.projectData)
        : getProject(target.org, target.project),
      tryGetPrimaryDsn(target.org, target.project),
    ]);
    return { project, dsn };
  });
  if (result.ok) {
    return result.value;
  }
  throw result.error;
}

/**
 * Fetch details, swallowing non-auth failures (auto-detect mode).
 * `AuthError` still propagates for the auto-login middleware.
 */
async function fetchProjectDetails(
  target: ResolvedTarget
): Promise<ProjectWithDsn | null> {
  try {
    return await fetchProjectAndDsn(target);
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }
    return null;
  }
}

/**
 * Fetch details, rethrowing API errors verbatim.
 *
 * Used for explicit/project-search targets: the user named the
 * project, so surfacing the real 403/404 is more useful than the
 * generic "Could not auto-detect" fallback (getsentry/cli#785 #8).
 */
function fetchProjectDetailsOrThrow(
  target: ResolvedTarget
): Promise<ProjectWithDsn> {
  return fetchProjectAndDsn(target);
}

/** Result of fetching project details for multiple targets */
type FetchResult = {
  projects: SentryProject[];
  dsns: (string | null)[];
  targets: ResolvedTarget[];
};

/**
 * Fetch details for every auto-detected target in parallel, filtering
 * out failures while preserving target association.
 */
async function fetchAllProjectDetails(
  targets: ResolvedTarget[]
): Promise<FetchResult> {
  const results = await Promise.all(targets.map(fetchProjectDetails));

  const projects: SentryProject[] = [];
  const dsns: (string | null)[] = [];
  const validTargets: ResolvedTarget[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const target = targets[i];
    if (result && target) {
      projects.push(result.project);
      dsns.push(result.dsn);
      validTargets.push(target);
    }
  }

  return { projects, dsns, targets: validTargets };
}

/**
 * Re-hydrate `organization.name` on a project entry.
 *
 * `getProject()` passes `?collapse=organization` so the server returns
 * only `{id, slug}` for `organization` (~400-500ms faster). For JSON
 * consumers that scrape `.organization.name`, we refill the field from
 * the cached organizations list (or the slug as last resort) so the
 * JSON output shape stays stable across CLI versions.
 */
function hydrateOrganizationName(entry: ProjectViewEntry): ProjectViewEntry {
  if (!entry.organization || entry.organization.name) {
    return entry;
  }
  return {
    ...entry,
    organization: {
      ...entry.organization,
      name: resolveOrgDisplayName(entry.organization.slug),
    },
  };
}

/**
 * Build the JSON payload: strip `detectedFrom` (human-only), re-hydrate
 * `organization.name`, and apply `--fields` filtering.
 *
 * Replaces the simpler `jsonExclude: ["detectedFrom"]` config so we can
 * also restore `organization.name` that the collapsed API response omits.
 */
function jsonTransformProjectView(
  entries: ProjectViewEntry[],
  fields?: string[]
): unknown {
  const hydrated = entries.map((entry) => {
    const { detectedFrom: _detectedFrom, ...rest } =
      hydrateOrganizationName(entry);
    return rest;
  });
  if (fields && fields.length > 0) {
    return hydrated.map((item) => filterFields(item, fields));
  }
  return hydrated;
}

/**
 * Format project view entries for human-readable terminal output.
 *
 * Renders each project's details with dividers between multiple projects,
 * and appends detection source information when available.
 */
function formatProjectViewHuman(entries: ProjectViewEntry[]): string {
  const parts: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }

    if (i > 0) {
      parts.push(`\n${divider(60)}\n`);
    }

    parts.push(formatProjectDetails(entry, entry.dsn));
    if (entry.detectedFrom) {
      parts.push(`\nDetected from: ${entry.detectedFrom}`);
    }
  }

  return parts.join("\n");
}

export const viewCommand = buildCommand({
  docs: {
    brief: "View details of a project",
    fullDescription:
      "View detailed information about Sentry projects.\n\n" +
      "Target patterns:\n" +
      "  sentry project view                       # auto-detect from DSN or config\n" +
      "  sentry project view <org>/<project>       # explicit org and project\n" +
      "  sentry project view <project>             # find project across all orgs\n\n" +
      `${TARGET_PATTERN_NOTE}\n\n` +
      "In monorepos with multiple Sentry projects, shows details for all detected projects.",
  },
  output: {
    human: formatProjectViewHuman,
    jsonTransform: jsonTransformProjectView,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/project",
          brief: "<org>/<project>, <project> (search), or omit for auto-detect",
          parse: String,
          optional: true,
        },
      ],
    },
    flags: {
      web: {
        kind: "boolean",
        brief: "Open in browser",
        default: false,
      },
      fresh: FRESH_FLAG,
    },
    aliases: { ...FRESH_ALIASES, w: "web" },
  },
  async *func(this: SentryContext, flags: ViewFlags, targetArg?: string) {
    applyFreshFlag(flags);
    const { cwd } = this;

    const parsed = parseOrgProjectArg(targetArg);

    let resolvedTargets: ResolvedTarget[];
    let footer: string | undefined;

    switch (parsed.type) {
      case ProjectSpecificationType.Explicit:
        // Direct org/project - single target, no multi-target resolution
        resolvedTargets = [
          {
            org: parsed.org,
            project: parsed.project,
            orgDisplay: parsed.org,
            projectDisplay: parsed.project,
          },
        ];
        break;

      case ProjectSpecificationType.ProjectSearch: {
        // Search for project across all orgs - single target
        const resolved = await resolveProjectBoundSlug(
          parsed.projectSlug,
          USAGE_HINT,
          `sentry project view <org>/${parsed.projectSlug}`,
          parsed.originalSlug
        );
        resolvedTargets = [
          {
            org: resolved.org,
            project: resolved.project,
            orgDisplay: resolved.org,
            projectDisplay: resolved.project,
            projectData: resolved.projectData,
          },
        ];
        break;
      }

      case ProjectSpecificationType.OrgAll:
        throw new ContextError(
          "Specific project",
          `sentry project view ${parsed.org}/<project>`,
          ["Specify the full org/project target, not just the organization"]
        );

      case ProjectSpecificationType.AutoDetect: {
        // Auto-detect supports monorepo multi-target resolution
        const result = await resolveAllTargets({ cwd });

        if (result.targets.length === 0) {
          throw buildContextError(result.skippedSelfHosted);
        }

        resolvedTargets = result.targets;
        footer = result.footer;
        break;
      }

      default:
        throw new ContextError("Organization and project", USAGE_HINT);
    }

    if (flags.web) {
      await handleWebView(resolvedTargets);
      return;
    }

    // Auto-detect tolerates per-target failures (DSN scans may yield
    // inaccessible targets); explicit/search rethrows so the real
    // 403/404 surfaces instead of a misleading "not provided" error.
    let projects: SentryProject[];
    let dsns: (string | null)[];
    let targets: ResolvedTarget[];

    if (parsed.type === ProjectSpecificationType.AutoDetect) {
      const fetched = await fetchAllProjectDetails(resolvedTargets);
      projects = fetched.projects;
      dsns = fetched.dsns;
      targets = fetched.targets;
    } else {
      const firstTarget = resolvedTargets[0];
      if (!firstTarget) {
        throw buildContextError();
      }
      const detail = await fetchProjectDetailsOrThrow(firstTarget);
      projects = [detail.project];
      dsns = [detail.dsn];
      targets = [firstTarget];
    }

    if (projects.length === 0) {
      throw buildContextError();
    }

    // Build enriched entries array — always an array for consistent JSON shape
    const entries: ProjectViewEntry[] = projects.map((p, i) => ({
      ...p,
      dsn: dsns[i] ?? null,
      detectedFrom: targets[i]?.detectedFrom,
    }));

    yield new CommandOutput(entries);
    return { hint: footer };
  },
});
