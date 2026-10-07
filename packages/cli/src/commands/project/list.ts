/**
 * sentry project list
 *
 * List projects in an organization with pagination and flexible targeting.
 *
 * Supports:
 * - Auto-detection from DSN/config
 * - Explicit org/project targeting (e.g., sentry/sentry)
 * - Org-scoped listing with cursor pagination (e.g., sentry/)
 * - Cross-org project search (e.g., sentry)
 */

import type { SentryContext } from "../../context.js";
import {
  getProject,
  listOrganizations,
  listProjects,
  listProjectsAllPages,
  type PaginatedResponse,
} from "../../lib/api-client.js";
import {
  type ParsedOrgProject,
  parseOrgProjectArg,
} from "../../lib/arg-parsing.js";
import { getDefaultOrganization } from "../../lib/db/defaults.js";
import {
  advancePaginationState,
  type CursorDirection,
  escapeContextKeyValue,
  hasPreviousPage,
  resolveCursor,
} from "../../lib/db/pagination.js";
import { ResolutionError, withAuthGuard } from "../../lib/errors.js";
import { escapeMarkdownCell } from "../../lib/formatters/markdown.js";
import {
  CommandOutput,
  type OutputConfig,
} from "../../lib/formatters/output.js";
import { type Column, formatTable } from "../../lib/formatters/table.js";
import {
  buildListCommand,
  buildListLimitFlag,
  LIST_BASE_ALIASES,
  LIST_TARGET_POSITIONAL,
  paginationHint,
  targetPatternExplanation,
} from "../../lib/list-command.js";

import {
  dispatchOrgScopedList,
  jsonTransformListResult,
  type ListCommandMeta,
  type ListResult,
} from "../../lib/org-list.js";
import { withProgress } from "../../lib/polling.js";
import {
  classifyProjectSearchTarget,
  type ProjectSearchTargetResolution,
  projectSearchNotFoundSuggestions,
  type ResolvedTarget,
  resolveAllTargets,
} from "../../lib/resolve-target.js";
import { getApiBaseUrl } from "../../lib/sentry-client.js";
import type { SentryProject } from "../../types/index.js";

/** Extended result type with optional title shown above the table. */
type ProjectListResult = ListResult<ProjectWithOrg> & { title?: string };

/** Command key for pagination cursor storage */
export const PAGINATION_KEY = "project-list";

type ListFlags = {
  readonly limit: number;
  readonly json: boolean;
  readonly cursor?: string;
  readonly platform?: string;
  readonly fresh: boolean;
  readonly fields?: string[];
};

/**
 * Project with optional organization context for display.
 * Uses optional orgSlug since some internal functions (e.g., filterByPlatform)
 * operate on projects before org context is attached.
 * The canonical exported type with required orgSlug lives in api-client.ts.
 */
type ProjectWithOrg = SentryProject & { orgSlug?: string };

/**
 * Fetch projects for a single organization (all pages).
 *
 * @param orgSlug - Organization slug to fetch projects from
 * @returns Projects with org context attached
 */
export async function fetchOrgProjects(
  orgSlug: string,
): Promise<ProjectWithOrg[]> {
  const projects = await listProjects(orgSlug);
  return projects.map((p) => ({ ...p, orgSlug }));
}

/**
 * Fetch projects for a single org, returning empty array on non-auth errors.
 * Auth errors propagate so user sees "please log in" message.
 */
export async function fetchOrgProjectsSafe(
  orgSlug: string,
): Promise<ProjectWithOrg[]> {
  const result = await withAuthGuard(() => fetchOrgProjects(orgSlug));
  return result.ok ? result.value : [];
}

/**
 * Fetch projects from all accessible organizations.
 * Skips orgs where the user lacks access.
 *
 * @returns Combined list of projects from all accessible orgs
 */
export async function fetchAllOrgProjects(): Promise<ProjectWithOrg[]> {
  const orgs = await listOrganizations();
  const results: ProjectWithOrg[] = [];

  for (const org of orgs) {
    const projectsResult = await withAuthGuard(() =>
      fetchOrgProjects(org.slug),
    );
    if (projectsResult.ok) {
      results.push(...projectsResult.value);
    }
  }

  return results;
}

/**
 * Filter projects by platform name (case-insensitive partial match).
 *
 * @param projects - Projects to filter
 * @param platform - Platform substring to match (e.g., "javascript", "python")
 * @returns Filtered projects, or all projects if no platform specified
 */
export function filterByPlatform(
  projects: ProjectWithOrg[],
  platform?: string,
): ProjectWithOrg[] {
  if (!platform) {
    return projects;
  }
  const lowerPlatform = platform.toLowerCase();
  return projects.filter((p) =>
    p.platform?.toLowerCase().includes(lowerPlatform),
  );
}

/**
 * Build a context key for pagination cursor validation.
 * Captures the query parameters that affect result ordering,
 * so cursors from different queries are not accidentally reused.
 *
 * Includes the Sentry host so cursors from different instances
 * (SaaS vs self-hosted) are never mixed.
 *
 * Format: `host:<url>|type:<kind>[:<arg>][|platform:<name>]`
 */
export function buildContextKey(
  parsed: ParsedOrgProject,
  flags: { platform?: string },
  host: string,
): string {
  const parts: string[] = [`host:${host}`];
  switch (parsed.type) {
    case "org-all":
      parts.push(`type:org:${parsed.org}`);
      break;
    case "auto-detect":
      parts.push("type:auto");
      break;
    case "explicit":
      parts.push(`type:explicit:${parsed.org}/${parsed.project}`);
      break;
    case "project-search":
      parts.push(`type:search:${parsed.projectSlug}`);
      break;
    default: {
      const _exhaustive: never = parsed;
      parts.push(`type:unknown:${String(_exhaustive)}`);
    }
  }
  if (flags.platform) {
    // Normalize to lowercase since platform filtering is case-insensitive.
    parts.push(
      `platform:${escapeContextKeyValue(flags.platform.toLowerCase())}`,
    );
  }
  return parts.join("|");
}

/** Result of resolving organizations to fetch projects from */
type OrgResolution = {
  orgs: string[];
  footer?: string;
  skippedSelfHosted?: number;
};

/**
 * Resolve which organizations to fetch projects from (auto-detect mode).
 * Uses config defaults or DSN auto-detection.
 */
async function resolveOrgsForAutoDetect(cwd: string): Promise<OrgResolution> {
  // 1. Check config defaults
  const defaultOrg = getDefaultOrganization();
  if (defaultOrg) {
    return { orgs: [defaultOrg] };
  }

  // 2. Auto-detect from DSNs (may find multiple in monorepos)
  const targetsResult = await withAuthGuard(() => resolveAllTargets({ cwd }));
  if (targetsResult.ok) {
    const { targets, footer, skippedSelfHosted } = targetsResult.value;
    if (targets.length > 0) {
      const uniqueOrgs = [
        ...new Set(targets.map((t: ResolvedTarget) => t.org)),
      ];
      return { orgs: uniqueOrgs, footer, skippedSelfHosted };
    }
    return { orgs: [], skippedSelfHosted };
  }

  return { orgs: [] };
}

/** Column definitions for the project table. */
const PROJECT_COLUMNS: Column<ProjectWithOrg>[] = [
  { header: "ORG", value: (p) => p.orgSlug || "" },
  { header: "PROJECT", value: (p) => p.slug || "" },
  { header: "NAME", value: (p) => escapeMarkdownCell(p.name) },
  { header: "PLATFORM", value: (p) => p.platform || "" },
];

/** Format projects as a table string. */
export function displayProjectTable(projects: ProjectWithOrg[]): string {
  return formatTable(projects, PROJECT_COLUMNS);
}

/**
 * Fetch up to `limit` projects from one org, with error handling
 * that mirrors `fetchOrgProjectsSafe` — re-throws auth errors but
 * silently returns empty for other failures (403, network errors).
 */
type PaginatedResult = { projects: ProjectWithOrg[]; nextCursor?: string };

async function fetchPaginatedSafe(
  org: string,
  limit: number,
): Promise<PaginatedResult> {
  const result = await withAuthGuard(async () => {
    const response = await listProjectsAllPages(org, { limit });
    return {
      projects: response.data.map((p) => ({ ...p, orgSlug: org })),
      nextCursor: response.nextCursor,
    };
  });
  return result.ok ? result.value : { projects: [] };
}

/**
 * Fetch projects for auto-detect mode.
 *
 * Optimization: when targeting a single org without platform filter, uses
 * {@link listProjectsAllPages} (capped `per_page`, auto-paginate up to
 * `limit`) instead of fetching every project. Multi-org or filtered queries
 * still require full fetch + client-side slicing.
 */
async function fetchAutoDetectProjects(
  orgs: string[],
  flags: ListFlags,
): Promise<{ projects: ProjectWithOrg[]; nextCursor?: string }> {
  if (orgs.length === 1 && !flags.platform) {
    return fetchPaginatedSafe(orgs[0] as string, flags.limit);
  }
  if (orgs.length > 0) {
    const results = await Promise.all(orgs.map(fetchOrgProjectsSafe));
    return { projects: results.flat() };
  }
  return { projects: await fetchAllOrgProjects() };
}

/** Build a pagination hint for auto-detect JSON output. */
function autoDetectPaginationHint(orgs: string[]): string {
  return orgs.length === 1
    ? `sentry project list ${orgs[0]}/ --json`
    : "sentry project list <org>/ --json";
}

/** Build the truncation header for auto-detect mode. */
function autoDetectHeader(
  count: number,
  hasMore: boolean,
  nextCursor: string | undefined,
  orgs: string[],
): string | undefined {
  if (!hasMore) {
    return;
  }
  if (nextCursor && orgs.length === 1) {
    const org = orgs[0] as string;
    return (
      `Showing ${count} projects (more available). ` +
      `Use 'sentry project list ${org}/' for paginated results.`
    );
  }
  return `Showing ${count} projects (more available). Use --limit to show more.`;
}

/** Build self-hosted DSN warning text, or undefined if none skipped. */
function selfHostedWarning(
  skippedSelfHosted: number | undefined,
): string | undefined {
  if (!skippedSelfHosted) {
    return;
  }
  return (
    `Note: ${skippedSelfHosted} DSN(s) could not be resolved. ` +
    "Specify the organization explicitly: sentry project list <org>/"
  );
}

/**
 * Handle auto-detect mode: resolve orgs from config/DSN, fetch all projects,
 * apply client-side filtering and limiting.
 */
export async function handleAutoDetect(
  cwd: string,
  flags: ListFlags,
): Promise<ListResult<ProjectWithOrg>> {
  const {
    orgs: orgsToFetch,
    footer,
    skippedSelfHosted,
  } = await resolveOrgsForAutoDetect(cwd);

  const { projects: allProjects, nextCursor } = await withProgress(
    {
      message: `Fetching projects (up to ${flags.limit})...`,
      json: flags.json,
    },
    () => fetchAutoDetectProjects(orgsToFetch, flags),
  );

  const filtered = filterByPlatform(allProjects, flags.platform);
  const limitCount =
    orgsToFetch.length > 1 ? flags.limit * orgsToFetch.length : flags.limit;
  const limited = filtered.slice(0, limitCount);

  const hasMore = filtered.length > limited.length || !!nextCursor;
  const header = autoDetectHeader(
    limited.length,
    hasMore,
    nextCursor,
    orgsToFetch,
  );

  const hintParts: string[] = [];

  if (limited.length === 0) {
    hintParts.push("No projects found.");
  } else {
    // header is rendered inline by the human formatter — don't duplicate here
    if (footer) {
      hintParts.push(footer);
    }
    hintParts.push(
      "Tip: Use 'sentry project view <org>/<project>' for details",
    );
  }

  const warning = selfHostedWarning(skippedSelfHosted);
  if (warning) {
    hintParts.push(warning);
  }

  return {
    items: limited,
    hasMore,
    header,
    hint: hintParts.length > 0 ? hintParts.join("\n") : undefined,
    jsonExtra: hasMore
      ? { hint: autoDetectPaginationHint(orgsToFetch) }
      : undefined,
  };
}

/**
 * Handle explicit org/project targeting (e.g., sentry/sentry).
 * Fetches the specific project directly via the API.
 */
export async function handleExplicit(
  org: string,
  projectSlug: string,
  flags: ListFlags,
): Promise<ListResult<ProjectWithOrg>> {
  const projectResult = await withProgress(
    { message: "Fetching project...", json: flags.json },
    () => withAuthGuard(() => getProject(org, projectSlug)),
  );
  if (!projectResult.ok) {
    return {
      items: [],
      hint:
        `No project '${projectSlug}' found in organization '${org}'.\n` +
        `Tip: Use 'sentry project list ${org}/' to see all projects`,
    };
  }
  const project: ProjectWithOrg = { ...projectResult.value, orgSlug: org };

  const filtered = filterByPlatform([project], flags.platform);

  if (filtered.length === 0) {
    return {
      items: [],
      hint: `No project '${projectSlug}' found matching platform '${flags.platform}'.`,
    };
  }

  return {
    items: filtered,
    hint: `Tip: Use 'sentry project view ${org}/${projectSlug}' for details`,
  };
}

export type OrgAllOptions = {
  org: string;
  flags: ListFlags;
  contextKey: string;
  cursor: string | undefined;
  direction: CursorDirection;
};

/**
 * Handle org-all mode (e.g., sentry/).
 * Uses cursor pagination for efficient page-by-page listing.
 * `--limit` above the API page size auto-paginates via
 * {@link listProjectsAllPages} instead of sending an oversized `per_page`.
 */
export async function handleOrgAll(
  options: OrgAllOptions,
): Promise<ListResult<ProjectWithOrg>> {
  const { org, flags, contextKey, cursor, direction } = options;
  const response: PaginatedResponse<SentryProject[]> = await withProgress(
    {
      message: `Fetching projects (up to ${flags.limit})...`,
      json: flags.json,
    },
    () => listProjectsAllPages(org, { limit: flags.limit, cursor }),
  );

  const projects: ProjectWithOrg[] = response.data.map((p) => ({
    ...p,
    orgSlug: org,
  }));

  const filtered = filterByPlatform(projects, flags.platform);

  const hasMore = !!response.nextCursor;

  // Update cursor stack for bidirectional navigation
  advancePaginationState(
    PAGINATION_KEY,
    contextKey,
    direction,
    response.nextCursor ?? undefined,
  );
  const hasPrev = hasPreviousPage(PAGINATION_KEY, contextKey);

  let hint: string | undefined;
  let header: string | undefined;

  const base = `sentry project list ${org}/`;
  const suffix = flags.platform ? ` --platform ${flags.platform}` : "";
  const navHint = paginationHint({
    hasPrev,
    hasMore,
    prevHint: `${base} -c prev${suffix}`,
    nextHint: `${base} -c next${suffix}`,
  });

  if (filtered.length === 0) {
    const platformCtx = flags.platform
      ? ` matching platform '${flags.platform}'`
      : "";
    if (navHint) {
      hint = `No${platformCtx} projects on this page. ${navHint}`;
    } else if (flags.platform) {
      hint = `No projects${platformCtx} in organization '${org}'.`;
    } else {
      hint = `No projects found in organization '${org}'.`;
    }
  } else {
    if (hasMore) {
      header = `Showing ${filtered.length} projects (more available)\n${navHint}`;
    } else if (navHint) {
      header = `Showing ${filtered.length} projects\n${navHint}`;
    } else {
      header = `Showing ${filtered.length} projects`;
    }
    const tip = "Tip: Use 'sentry project view <org>/<project>' for details";
    hint = tip;
  }

  return {
    items: filtered,
    hasMore,
    hasPrev,
    nextCursor: response.nextCursor ?? null,
    header,
    hint,
  };
}

/**
 * Handle project-search mode (bare slug, e.g., "sentry").
 * Searches for the project across all accessible organizations.
 */
export async function handleProjectSearch(
  projectSlug: string,
  flags: ListFlags,
  options?: {
    /** Original user input before normalization — for clearer messages. */
    originalSlug?: string;
    /** Organization slug to scope the search to (e.g. from "org/My Project"). */
    scopedOrg?: string;
    /** Classification supplied by the dispatcher after its target pre-check. */
    projectSearchResolution?: ProjectSearchTargetResolution;
  },
): Promise<ListResult<ProjectWithOrg>> {
  const { originalSlug, scopedOrg, projectSearchResolution } = options ?? {};
  const parsed = {
    type: "project-search" as const,
    projectSlug,
    ...(originalSlug !== undefined && { originalSlug }),
    ...(scopedOrg !== undefined && { org: scopedOrg }),
  };
  const resolution =
    projectSearchResolution ??
    (await withProgress(
      {
        message: `Fetching projects (up to ${flags.limit})...`,
        json: flags.json,
      },
      () => classifyProjectSearchTarget(parsed),
    ));

  if (resolution.kind === "organization") {
    const contextKey = buildContextKey(
      { type: "org-all", org: resolution.org },
      flags,
      getApiBaseUrl(),
    );
    const result = await handleOrgAll({
      org: resolution.org,
      flags,
      contextKey,
      cursor: undefined,
      direction: "first",
    });
    const projectListResult = result as ProjectListResult;
    projectListResult.title = `'${projectSlug}' is an organization, not a project. Showing all projects in '${resolution.org}'`;
    return projectListResult;
  }

  if (resolution.kind === "not-found") {
    return handleProjectSearchNotFound(resolution, projectSlug, flags.json);
  }

  const projects =
    resolution.kind === "fuzzy-project"
      ? [resolution.projectData]
      : resolution.projects;
  const resolvedProjectSlug =
    resolution.kind === "fuzzy-project" ? resolution.project : projectSlug;
  const filtered = filterByPlatform(projects, flags.platform);
  if (filtered.length === 0 && flags.platform) {
    return {
      items: [],
      hint: `No project '${resolvedProjectSlug}' found matching platform '${flags.platform}'.`,
    };
  }

  const limited = filtered.slice(0, flags.limit);

  let header: string | undefined;

  if (filtered.length > limited.length) {
    header = `Showing ${limited.length} of ${filtered.length} matches. Use --limit to show more.`;
  } else if (limited.length > 1) {
    header = `Found '${resolvedProjectSlug}' in ${limited.length} organizations`;
  }

  return {
    items: limited,
    header,
    hint: "Tip: Use 'sentry project view <org>/<project>' for details",
  };
}

function handleProjectSearchNotFound(
  resolution: Extract<ProjectSearchTargetResolution, { kind: "not-found" }>,
  projectSlug: string,
  json: boolean,
): ListResult<ProjectWithOrg> {
  if (json) {
    return { items: [] };
  }
  throw new ResolutionError(
    `Project '${resolution.displaySlug}'`,
    "not found",
    `sentry project list <org>/${projectSlug}`,
    projectSearchNotFoundSuggestions(resolution),
  );
}

/** Metadata used by the shared dispatch infrastructure for error messages and cursor keys. */
const projectListMeta: ListCommandMeta = {
  paginationKey: PAGINATION_KEY,
  entityPlural: "projects",
  commandPrefix: "sentry project list",
};

export const listCommand = buildListCommand("project", {
  docs: {
    brief: "List projects",
    fullDescription:
      "List projects in an organization.\n\n" +
      "Target patterns:\n" +
      "  sentry project list                # auto-detect from DSN or config\n" +
      "  sentry project list <org>/         # all projects in org (paginated)\n" +
      "  sentry project list <org>/<proj>   # show specific project\n" +
      "  sentry project list <project>      # find project across all orgs\n\n" +
      `${targetPatternExplanation("Cursor pagination (--cursor) requires the <org>/ form.")}\n\n` +
      "Pagination:\n" +
      "  sentry project list <org>/ -c next      # next page\n" +
      "  sentry project list <org>/ -c prev      # previous page\n" +
      "  sentry project list <org>/ -c <cursor>  # resume at specific cursor\n\n" +
      "Filtering and output:\n" +
      "  sentry project list --platform javascript  # filter by platform\n" +
      "  sentry project list --limit 50              # show more results\n" +
      "  sentry project list --json                  # output as JSON\n\n" +
      "Alias: `sentry projects` → `sentry project list`",
  },
  output: {
    human: (data: ListResult<ProjectWithOrg>) => {
      const result = data as ProjectListResult;
      if (result.items.length === 0) {
        return result.hint ?? "No projects found.";
      }
      const parts: string[] = [];
      if (result.title) {
        parts.push(`\n${result.title}\n\n`);
      }
      parts.push(displayProjectTable(result.items));
      if (result.header) {
        parts.push(`\n${result.header}`);
      }
      return parts.join("");
    },
    jsonTransform: jsonTransformListResult,
  } satisfies OutputConfig<ListResult<ProjectWithOrg>>,
  parameters: {
    positional: LIST_TARGET_POSITIONAL,
    flags: {
      limit: buildListLimitFlag("projects"),
      platform: {
        kind: "parsed",
        parse: String,
        brief: "Filter by platform (e.g., javascript, python)",
        optional: true,
      },
    },
    aliases: { ...LIST_BASE_ALIASES, p: "platform" },
  },
  async *func(this: SentryContext, flags: ListFlags, target?: string) {
    const { cwd } = this;

    const parsed = parseOrgProjectArg(target);

    const result = await dispatchOrgScopedList({
      config: projectListMeta,
      cwd,
      flags,
      parsed,
      overrides: {
        "auto-detect": (ctx) => handleAutoDetect(ctx.cwd, flags),
        explicit: (ctx) =>
          handleExplicit(ctx.parsed.org, ctx.parsed.project, flags),
        "org-all": (ctx) => {
          // Build context key and resolve cursor only in org-all mode, after
          // dispatchOrgScopedList has already validated --cursor is allowed here.
          const contextKey = buildContextKey(
            ctx.parsed,
            flags,
            getApiBaseUrl(),
          );
          const { cursor, direction } = resolveCursor(
            flags.cursor,
            PAGINATION_KEY,
            contextKey,
          );
          return handleOrgAll({
            org: ctx.parsed.org,
            flags,
            contextKey,
            cursor,
            direction,
          });
        },
        "project-search": (ctx) =>
          handleProjectSearch(ctx.parsed.projectSlug, flags, {
            originalSlug: ctx.parsed.originalSlug,
            scopedOrg: ctx.parsed.org,
            projectSearchResolution: ctx.projectSearchResolution,
          }),
      },
    });

    // Only forward hint to the footer when items exist — empty results
    // already render hint text inside the human formatter.
    const hint = result.items.length > 0 ? result.hint : undefined;
    yield new CommandOutput(result);
    return { hint };
  },
});
