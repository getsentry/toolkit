/**
 * sentry release list
 *
 * List releases in an organization with health/adoption metrics,
 * project scoping, environment filtering, and rich terminal styling.
 */

import type { SentryContext } from "../../context.js";
import {
  type ListReleasesOptions,
  listProjectEnvironments,
  listReleasesForProject,
  listReleasesPaginated,
  type ReleaseSortValue,
} from "../../lib/api-client.js";
import {
  type ParsedOrgProject,
  parseOrgProjectArg,
} from "../../lib/arg-parsing.js";
import {
  colorTag,
  escapeMarkdownInline,
} from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { sparkline } from "../../lib/formatters/sparkline.js";
import { type Column, formatTable } from "../../lib/formatters/table.js";
import { formatRelativeTime } from "../../lib/formatters/time-utils.js";
import {
  buildListCommand,
  buildListLimitFlag,
  LIST_BASE_ALIASES,
  LIST_TARGET_POSITIONAL,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import {
  dispatchOrgScopedList,
  type HandlerContext,
  jsonTransformListResult,
  type ListResult,
  type OrgListConfig,
} from "../../lib/org-list.js";
import {
  type ResolvedTarget,
  resolveAllTargets,
  toNumericId,
} from "../../lib/resolve-target.js";
import { buildReleaseUrl } from "../../lib/sentry-web-urls.js";
import type { SentryRelease } from "../../types/index.js";
import { fmtCrashFree } from "./view.js";

const log = logger.withTag("release.list");

export const PAGINATION_KEY = "release-list";

type ReleaseWithOrg = SentryRelease & {
  orgSlug?: string;
  /** Project slug when from multi-project auto-detect (for labeling). */
  targetProject?: string;
};

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

const VALID_SORT_VALUES: ReleaseSortValue[] = [
  "date",
  "sessions",
  "users",
  "crash_free_sessions",
  "crash_free_users",
];

const SORT_ALIASES: Record<string, ReleaseSortValue> = {
  stable_sessions: "crash_free_sessions",
  stable_users: "crash_free_users",
  cfs: "crash_free_sessions",
  cfu: "crash_free_users",
};

const DEFAULT_SORT: ReleaseSortValue = "date";

function parseSortFlag(value: string): ReleaseSortValue {
  if (VALID_SORT_VALUES.includes(value as ReleaseSortValue)) {
    return value as ReleaseSortValue;
  }
  const alias = SORT_ALIASES[value];
  if (alias) {
    return alias;
  }
  const allAccepted = [...VALID_SORT_VALUES, ...Object.keys(SORT_ALIASES)].join(
    ", "
  );
  throw new Error(`Invalid sort value. Must be one of: ${allAccepted}`);
}

// ---------------------------------------------------------------------------
// Health data helpers
// ---------------------------------------------------------------------------

/** Pick health data from the first project that has it. */
function getHealthData(release: SentryRelease) {
  return release.projects?.find((p) => p.healthData?.hasHealthData)?.healthData;
}

/** Extract session time-series from health stats `{ "<period>": [[ts, count], ...] }`. */
function extractSessionPoints(stats?: Record<string, unknown>): number[] {
  if (!stats) {
    return [];
  }
  const key = Object.keys(stats)[0];
  if (!key) {
    return [];
  }
  const buckets = stats[key];
  if (!Array.isArray(buckets)) {
    return [];
  }
  return buckets.map((b: unknown) =>
    Array.isArray(b) && b.length >= 2 ? Number(b[1]) || 0 : 0
  );
}

// ---------------------------------------------------------------------------
// Cell formatters (rich styling, matching issue list patterns)
// ---------------------------------------------------------------------------

/**
 * Format the VERSION cell: bold version linked to Sentry release page.
 * Second line: muted "age | last-deploy-env".
 */
function formatVersionCell(r: ReleaseWithOrg): string {
  const version = escapeMarkdownInline(r.shortVersion || r.version);
  const org = r.orgSlug || "";
  const linked = org
    ? `[**${version}**](${buildReleaseUrl(org, r.version)})`
    : `**${version}**`;
  const age = r.dateCreated ? formatRelativeTime(r.dateCreated) : "";
  const env = r.lastDeploy?.environment || "";
  const subtitle = [age, env].filter(Boolean).join(" | ");
  if (subtitle) {
    return `${linked}\n${colorTag("muted", subtitle)}`;
  }
  return linked;
}

/** Color adoption percentage: green ≥ 50%, yellow ≥ 10%, default otherwise. */
function formatAdoption(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return colorTag("muted", "—");
  }
  const text = `${value.toFixed(0)}%`;
  if (value >= 50) {
    return colorTag("green", text);
  }
  if (value >= 10) {
    return colorTag("yellow", text);
  }
  return text;
}

/** Session sparkline in muted color. */
function formatSessionSparkline(r: SentryRelease): string {
  const health = getHealthData(r);
  if (!health) {
    return "";
  }
  const points = extractSessionPoints(
    health.stats as Record<string, unknown> | undefined
  );
  if (points.length === 0) {
    return "";
  }
  return colorTag("muted", sparkline(points));
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

/** Format the CRASHES cell: red when > 0, green when 0, muted dash when absent. */
function formatCrashes(r: ReleaseWithOrg): string {
  const h = getHealthData(r);
  const v = h?.sessionsCrashed;
  if (v === undefined || v === null) {
    return colorTag("muted", "—");
  }
  return v > 0 ? colorTag("red", String(v)) : colorTag("green", "0");
}

/** Build columns for the release table. Includes PROJECT when multi-project. */
function buildColumns(multiProject: boolean): Column<ReleaseWithOrg>[] {
  const cols: Column<ReleaseWithOrg>[] = [
    { header: "ORG", value: (r) => r.orgSlug || "" },
  ];
  if (multiProject) {
    cols.push({
      header: "PROJECT",
      value: (r) =>
        colorTag("muted", r.targetProject || r.projects?.[0]?.slug || ""),
    });
  }
  cols.push(
    {
      header: "VERSION",
      value: formatVersionCell,
      shrinkable: false,
    },
    {
      header: "ADOPTION",
      value: (r) => formatAdoption(getHealthData(r)?.adoption),
      align: "right",
    },
    {
      header: "SESSIONS",
      value: formatSessionSparkline,
    },
    {
      header: "CRASH-FREE",
      value: (r) => fmtCrashFree(getHealthData(r)?.crashFreeSessions),
      align: "right",
    },
    {
      header: "CRASHES",
      value: formatCrashes,
      align: "right",
    },
    {
      header: "NEW ISSUES",
      value: (r) => String(r.newGroups ?? 0),
      align: "right",
    }
  );
  return cols;
}

/** Default single-project columns. */
const RELEASE_COLUMNS = buildColumns(false);

/** Muted ANSI color for row separators (matches issue list). */
const MUTED_ANSI = "\x1b[38;2;137;130;148m";

// ---------------------------------------------------------------------------
// Config builder
// ---------------------------------------------------------------------------

/** Extra API options shared across listForOrg, listPaginated, and listForProject. */
type ExtraApiOptions = Pick<
  ListReleasesOptions,
  "sort" | "environment" | "statsPeriod" | "status"
>;

function buildReleaseListConfig(
  extra: ExtraApiOptions
): OrgListConfig<SentryRelease, ReleaseWithOrg> {
  return {
    paginationKey: PAGINATION_KEY,
    entityPlural: "releases",
    commandPrefix: "sentry release list",
    listForOrg: async (org) => {
      const { data } = await listReleasesPaginated(org, {
        perPage: 100,
        health: true,
        ...extra,
      });
      return data;
    },
    listPaginated: (org, opts) =>
      listReleasesPaginated(org, { ...opts, health: true, ...extra }),
    listForProject: (org, project) =>
      listReleasesForProject(org, project, { health: true, ...extra }),
    withOrg: (release, orgSlug) => ({ ...release, orgSlug }),
    displayTable: (releases: ReleaseWithOrg[]) =>
      formatTable(releases, RELEASE_COLUMNS, { rowSeparator: MUTED_ANSI }),
  };
}

// ---------------------------------------------------------------------------
// Human formatter
// ---------------------------------------------------------------------------

function formatListHuman(result: ListResult<ReleaseWithOrg>): string {
  const parts: string[] = [];

  if (result.items.length === 0) {
    if (result.hint) {
      parts.push(result.hint);
    }
    return parts.join("\n");
  }

  // Detect multi-project from items and use appropriate columns
  const projects = new Set(result.items.map((r) => r.targetProject || ""));
  const isMulti = projects.size > 1 && !projects.has("");
  const columns = isMulti ? buildColumns(true) : RELEASE_COLUMNS;

  parts.push(formatTable(result.items, columns, { rowSeparator: MUTED_ANSI }));

  if (result.header) {
    parts.push(`\n${result.header}`);
  }

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Auto-detect override: resolve DSN → project-scoped listing
// ---------------------------------------------------------------------------

/** Matches DSN source paths in primary app directories. */
const PRIMARY_SOURCE_RE = /^(src|lib|app)\//;
/** Matches .env and .env.local files. */
const ENV_FILE_RE = /\.(env|env\.local)$/;

/**
 * Rank a detected target for primary-project selection.
 *
 * Lower score = higher priority. Prefers DSNs found in application source
 * (`src/`, `lib/`, `app/`) over ancillary paths (`docs/`, `test/`, `scripts/`).
 */
function targetPriority(t: ResolvedTarget): number {
  const from = t.detectedFrom?.toLowerCase() ?? "";
  // Primary source directories — most likely the "real" project
  if (PRIMARY_SOURCE_RE.test(from) || ENV_FILE_RE.test(from)) {
    return 0;
  }
  // Config files at project root
  if (!from.includes("/")) {
    return 1;
  }
  // Everything else (docs/, test/, scripts/, etc.)
  return 2;
}

/** Deduplicate and rank targets, best candidate first. */
function deduplicateTargets(targets: ResolvedTarget[]): ResolvedTarget[] {
  const seen = new Set<string>();
  const result: ResolvedTarget[] = [];
  for (const t of targets) {
    const key = `${t.org}/${t.project}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(t);
    }
  }
  return result.sort((a, b) => targetPriority(a) - targetPriority(b));
}

/**
 * Resolve a project slug to a numeric ID array for the API query param.
 * Returns a non-empty array on success, or an empty array when the project
 * cannot be resolved (error or unexpected ID shape). The caller must
 * short-circuit on an empty result to avoid unscoped org-wide queries.
 */
async function resolveProjectIds(
  org: string,
  project: string
): Promise<number[]> {
  try {
    const { getProject } = await import("../../lib/api-client.js");
    const info = await getProject(org, project);
    const id = toNumericId(info.id);
    if (!id) {
      log.debug(
        `Project ${org}/${project} returned non-numeric ID: ${info.id}`
      );
      return [];
    }
    return [id];
  } catch (error) {
    log.debug(`Failed to resolve project ID for ${org}/${project}`, error);
    return [];
  }
}

/**
 * Fetch releases for a single target, scoped by project ID.
 * Tags each release with orgSlug and targetProject for labeling.
 * Returns an empty array when project ID resolution fails to avoid
 * returning unscoped org-wide releases mislabeled as the target project.
 */
async function fetchReleasesForTarget(
  t: ResolvedTarget,
  extra: ExtraApiOptions,
  perPage: number
): Promise<ReleaseWithOrg[]> {
  const ids = t.projectId
    ? [t.projectId]
    : await resolveProjectIds(t.org, t.project);
  if (ids.length === 0) {
    return [];
  }
  const { data } = await listReleasesPaginated(t.org, {
    perPage,
    health: true,
    project: ids,
    ...extra,
  });
  return data.map((r) => ({ ...r, orgSlug: t.org, targetProject: t.project }));
}

/**
 * Build a comparator for client-side merge-sort of multi-project results.
 *
 * The API already returns per-project results in the requested sort order,
 * so this mirrors the same ordering for the cross-project merge. All
 * comparators sort descending (highest/newest first).
 */
function buildMergeSorter(
  sort: ReleaseSortValue
): (a: ReleaseWithOrg, b: ReleaseWithOrg) => number {
  return (a, b) => {
    const diff = getSortValue(b, sort) - getSortValue(a, sort);
    if (diff !== 0) {
      return diff;
    }
    // Tiebreak by dateCreated descending
    const da = a.dateCreated ? new Date(a.dateCreated).getTime() : 0;
    const db = b.dateCreated ? new Date(b.dateCreated).getTime() : 0;
    return db - da;
  };
}

/** Extract the numeric value used for sorting from a release. */
function getSortValue(r: ReleaseWithOrg, sort: ReleaseSortValue): number {
  const h = getHealthData(r);
  switch (sort) {
    case "date":
      return r.dateCreated ? new Date(r.dateCreated).getTime() : 0;
    case "sessions":
      return h?.totalSessions24h ?? 0;
    case "users":
      return h?.totalUsers24h ?? 0;
    case "crash_free_sessions":
      return h?.crashFreeSessions ?? -1;
    case "crash_free_users":
      return h?.crashFreeUsers ?? -1;
    default:
      return r.dateCreated ? new Date(r.dateCreated).getTime() : 0;
  }
}

/**
 * Trim merged results to `limit`, guaranteeing at least one release per
 * project appears — so no project is invisible in the output.
 * Follows the same pattern as `trimWithProjectGuarantee` in issue list.
 */
function trimWithProjectGuarantee(
  items: ReleaseWithOrg[],
  limit: number,
  comparator: (a: ReleaseWithOrg, b: ReleaseWithOrg) => number
): ReleaseWithOrg[] {
  if (items.length <= limit) {
    return items;
  }
  const seenProjects = new Set<string>();
  const guaranteed: ReleaseWithOrg[] = [];
  const rest: ReleaseWithOrg[] = [];
  // First pass: pick one representative per project
  for (const item of items) {
    const key = item.targetProject || item.orgSlug || "";
    if (seenProjects.has(key)) {
      rest.push(item);
    } else {
      seenProjects.add(key);
      guaranteed.push(item);
    }
  }
  // If guaranteed alone fills the limit, no room for extras
  if (guaranteed.length >= limit) {
    return guaranteed.slice(0, limit);
  }
  // Fill remaining slots from rest (already in sorted order)
  const filler = rest.slice(0, limit - guaranteed.length);
  // Merge and re-sort to maintain date order
  return [...guaranteed, ...filler].sort(comparator);
}

/**
 * Custom auto-detect handler: resolves DSN/config to org+project targets,
 * fetches releases from ALL detected projects in parallel, merges with
 * client-side sort by dateCreated, and shows a PROJECT column when
 * multiple projects contribute results.
 *
 * Follows the issue list pattern: fetch all, sort, trim with project
 * guarantee (at least 1 release per project in output).
 *
 * When no `--environment` is given, auto-defaults to `production` or
 * `prod` if the primary project has that environment.
 */
async function handleAutoDetectWithProject(
  extra: ExtraApiOptions,
  ctx: HandlerContext<"auto-detect">
): Promise<ListResult<ReleaseWithOrg>> {
  const { cwd, flags } = ctx;
  const resolved = await resolveAllTargets({ cwd });
  const unique = deduplicateTargets(resolved.targets);

  if (unique.length === 0) {
    return {
      items: [],
      hint: "No project detected. Specify a target: sentry release list <org>/<project>",
    };
  }

  // Smart env default from primary (highest-ranked) target
  const effectiveExtra = await applySmartEnvDefault(extra, unique[0]);
  const isMultiProject = unique.length > 1;

  // Fetch from ALL targets in parallel, each scoped by project ID
  const perTarget = Math.min(Math.ceil(flags.limit / unique.length), 100);
  const results = await Promise.all(
    unique.map((t) => fetchReleasesForTarget(t, effectiveExtra, perTarget))
  );
  const merged = results.flat();

  // Client-side sort matching the --sort flag, then trim with project guarantee
  const comparator = buildMergeSorter(
    (effectiveExtra.sort as ReleaseSortValue) ?? "date"
  );
  merged.sort(comparator);
  const limited = isMultiProject
    ? trimWithProjectGuarantee(merged, flags.limit, comparator)
    : merged.slice(0, flags.limit);

  const hintParts: string[] = [];
  if (limited.length === 0) {
    const names = unique.map((t) => `${t.org}/${t.project}`).join(", ");
    hintParts.push(`No releases found for ${names}.`);
  }
  if (resolved.footer) {
    hintParts.push(resolved.footer);
  }
  // Only show env hint when it was auto-applied (not when user passed -e)
  if (effectiveExtra.environment && !extra.environment) {
    hintParts.push(
      `Environment: ${effectiveExtra.environment.join(", ")} (use -e to change)`
    );
  }

  return {
    items: limited,
    hint: hintParts.length > 0 ? hintParts.join("\n") : undefined,
  };
}

/** Apply smart production env default from a resolved target. */
async function applySmartEnvDefault(
  extra: ExtraApiOptions,
  primary?: ResolvedTarget
): Promise<ExtraApiOptions> {
  if (extra.environment || !primary) {
    return extra;
  }
  const env = await resolveDefaultEnvironment(primary.org, primary.project);
  return env ? { ...extra, environment: env } : extra;
}

/**
 * Apply smart production env default from the parsed target argument.
 *
 * For explicit targets (`org/project`), resolves the environment immediately.
 * For auto-detect, the override handler applies its own default.
 * For org-all and project-search, skipped (no reliable project to check).
 */
async function resolveEnvForParsedTarget(
  extra: ExtraApiOptions,
  parsed: ParsedOrgProject
): Promise<ExtraApiOptions> {
  if (extra.environment) {
    return extra;
  }
  if (parsed.type === "explicit") {
    const env = await resolveDefaultEnvironment(parsed.org, parsed.project);
    return env ? { ...extra, environment: env } : extra;
  }
  return extra;
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

/** Known production environment names to auto-detect as default. */
const PRODUCTION_ENV_NAMES = ["production", "prod"];

/**
 * Resolve environment filter for the API call.
 *
 * When the user passes `-e`, those values are used directly.
 * When no `-e` is given and we have a detected project, check if
 * `production` or `prod` exists and default to it — matching the
 * Sentry web UI's default behavior of showing production releases.
 *
 * Returns `undefined` (all environments) if no production env is found.
 */
async function resolveDefaultEnvironment(
  org: string,
  project: string
): Promise<string[] | undefined> {
  try {
    const envs = await listProjectEnvironments(org, project);
    const names = envs.map((e) => e.name);
    for (const candidate of PRODUCTION_ENV_NAMES) {
      if (names.includes(candidate)) {
        return [candidate];
      }
    }
  } catch (error) {
    log.debug(`Failed to list environments for ${org}/${project}`, error);
  }
  return;
}

type ListFlags = {
  readonly limit: number;
  readonly sort: ReleaseSortValue;
  readonly environment?: readonly string[];
  readonly period: string;
  readonly status: string;
  readonly json: boolean;
  readonly cursor?: string;
  readonly fresh: boolean;
  readonly fields?: string[];
};

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const listCommand = buildListCommand("release", {
  docs: {
    brief: "List releases with adoption and health metrics",
    fullDescription:
      "List releases in an organization with adoption and crash-free metrics.\n\n" +
      "When run from a project directory (DSN auto-detection or explicit\n" +
      "<org>/<project> target), shows only releases for that project.\n\n" +
      "Sort options:\n" +
      "  date                 # by creation date (default)\n" +
      "  sessions             # by total sessions\n" +
      "  users                # by total users\n" +
      "  crash_free_sessions  # by crash-free session rate (aliases: stable_sessions, cfs)\n" +
      "  crash_free_users     # by crash-free user rate (aliases: stable_users, cfu)\n\n" +
      "Target specification:\n" +
      "  sentry release list               # auto-detect from DSN (project-scoped)\n" +
      "  sentry release list <org>/        # list all releases in org (paginated)\n" +
      "  sentry release list <org>/<proj>  # list releases for project\n" +
      "  sentry release list <org>         # list releases in org\n\n" +
      "Pagination:\n" +
      "  sentry release list <org>/ -c next  # fetch next page\n" +
      "  sentry release list <org>/ -c prev  # fetch previous page\n\n" +
      "Examples:\n" +
      "  sentry release list                         # auto-detect project\n" +
      "  sentry release list my-org/                  # all releases in org\n" +
      "  sentry release list my-org/my-proj           # project-scoped\n" +
      "  sentry release list --sort cfs               # sort by crash-free sessions\n" +
      "  sentry release list --environment production  # filter by env\n" +
      "  sentry release list --period 7d              # last 7 days of health data\n" +
      "  sentry release list --json\n\n" +
      "Alias: `sentry releases` → `sentry release list`",
  },
  output: {
    human: formatListHuman,
    jsonTransform: (result: ListResult<ReleaseWithOrg>, fields?: string[]) =>
      jsonTransformListResult(result, fields),
  },
  parameters: {
    positional: LIST_TARGET_POSITIONAL,
    flags: {
      limit: buildListLimitFlag("releases"),
      sort: {
        kind: "parsed" as const,
        parse: parseSortFlag,
        brief:
          "Sort: date, sessions, users, crash_free_sessions (cfs), crash_free_users (cfu)",
        default: DEFAULT_SORT,
      },
      environment: {
        kind: "parsed" as const,
        parse: String,
        brief: "Filter by environment (repeatable, comma-separated)",
        variadic: true as const,
        optional: true as const,
      },
      period: {
        kind: "parsed" as const,
        parse: String,
        brief: "Health stats period (e.g., 24h, 7d, 14d, 90d)",
        default: "90d",
      },
      status: {
        kind: "parsed" as const,
        parse: String,
        brief: "Filter by status: open (default) or archived",
        default: "open",
      },
    },
    aliases: { ...LIST_BASE_ALIASES, s: "sort", e: "environment", t: "period" },
  },
  async *func(this: SentryContext, flags: ListFlags, target?: string) {
    const { cwd } = this;
    const parsed = parseOrgProjectArg(target);
    // Flatten: -e prod,dev -e staging → ["prod", "dev", "staging"]
    const envFilter = flags.environment
      ? [...flags.environment]
          .flatMap((v) => v.split(","))
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const extra: ExtraApiOptions = {
      sort: flags.sort,
      environment: envFilter,
      statsPeriod: flags.period,
      status: flags.status,
    };

    // Smart env default: when no -e given and we know the project, check
    // if "production"/"prod" exists and auto-select it. Applies to explicit
    // (org/project) here; auto-detect handles its own default in the override.
    const resolvedExtra = await resolveEnvForParsedTarget(extra, parsed);
    const config = buildReleaseListConfig(resolvedExtra);
    const result = await dispatchOrgScopedList({
      config,
      cwd,
      flags,
      parsed,
      overrides: {
        "auto-detect": (ctx: HandlerContext<"auto-detect">) =>
          handleAutoDetectWithProject(resolvedExtra, ctx),
      },
    });
    yield new CommandOutput(result);
    // Only return the env hint here — result.hint is already rendered
    // by formatListHuman (for empty results) or as the header (for non-empty).
    // Returning it again would duplicate the text.
    if (resolvedExtra.environment && !envFilter) {
      return {
        hint: `Environment: ${resolvedExtra.environment.join(", ")} (use -e to change)`,
      };
    }
    return { hint: result.hint };
  },
});
