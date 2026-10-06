/**
 * List public DSNs for a project or organization using Client Keys fields.
 * Project resolution, output rendering, and cursor history use shared helpers.
 */

import pLimit from "p-limit";
import type { SentryContext } from "../../context.js";
import { ORG_FANOUT_CONCURRENCY } from "../../lib/api/infrastructure.js";
import {
  listOrganizationDsns,
  listProjectDsns,
} from "../../lib/api/projects.js";
import { parseOrgProjectArg, validateLimit } from "../../lib/arg-parsing.js";
import {
  advancePaginationState,
  buildMultiTargetContextKey,
  buildPaginationContextKey,
  decodeTargetCursors,
  encodeCompoundCursor,
  hasPreviousPage,
  resolveCursor,
} from "../../lib/db/pagination.js";
import { formatMultipleProjectsFooter } from "../../lib/dsn/index.js";
import { ApiError, ContextError, withAuthGuard } from "../../lib/errors.js";
import { type DsnListItem, formatDsnList } from "../../lib/formatters/dsn.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  buildListCommand,
  buildListLimitFlag,
  LIST_MAX_LIMIT,
  LIST_MIN_LIMIT,
  LIST_TARGET_POSITIONAL,
  paginationHint,
  targetPatternExplanation,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import {
  type BaseListFlags,
  dispatchOrgScopedList,
  type FetchResult,
  fetchGroupsWithBudget,
  type GroupFetchOptions,
  type HandlerContext,
  jsonTransformListResult,
  type ListCommandMeta,
  type ListResult,
  trimWithGroupGuarantee,
} from "../../lib/org-list.js";
import { withProgress } from "../../lib/polling.js";
import {
  type ResolvedTarget,
  resolveProjectBoundTargets,
  resolveTargetSlugs,
} from "../../lib/resolve-target.js";

const PAGINATION_KEY = "dsn-list";
const USAGE_HINT = "sentry dsn list <org>/<project>";

const listConfig: ListCommandMeta = {
  paginationKey: PAGINATION_KEY,
  entityPlural: "DSNs",
  commandPrefix: "sentry dsn list",
};

/** List an organization's keys directly, preserving its cursor history. */
async function listForOrganization(
  org: string,
  flags: BaseListFlags
): Promise<ListResult<DsnListItem>> {
  const target = `${org}/`;
  const contextKey = buildPaginationContextKey("org", target, {
    limit: String(flags.limit),
  });
  const { cursor, direction } = resolveCursor(
    flags.cursor,
    PAGINATION_KEY,
    contextKey
  );
  const response = await withProgress(
    { message: "Fetching DSNs...", json: flags.json },
    () => listOrganizationDsns(org, { limit: flags.limit, cursor })
  );
  const { data, nextCursor } = response;
  advancePaginationState(PAGINATION_KEY, contextKey, direction, nextCursor);
  const hasPrev = hasPreviousPage(PAGINATION_KEY, contextKey);
  const hasMore = !!nextCursor;
  const command = `sentry dsn list ${target} --limit ${flags.limit}`;

  return {
    items: data.map((dsn) => ({ ...dsn, org })),
    hasMore,
    hasPrev,
    nextCursor,
    hint: paginationHint({
      hasPrev,
      hasMore,
      prevHint: `${command} -c prev`,
      nextHint: `${command} -c next`,
    }),
  };
}

/** A page of keys belonging to a resolved project. */
type DsnProjectPage = {
  /** Canonical organization/project context for these keys. */
  target: ResolvedTarget;
  /** Public key fields and slugs used in both output formats. */
  items: DsnListItem[];
  /** Whether the project has another page. */
  hasMore: boolean;
  /** Server cursor, absent when the project is exhausted. */
  nextCursor?: string;
};

/** Fetch a bounded project page, allowing callers to report partial failures. */
async function fetchProjectPage(
  target: ResolvedTarget,
  options: GroupFetchOptions
): Promise<FetchResult<DsnProjectPage>> {
  const result = await withAuthGuard(async () => {
    const page = await listProjectDsns(target.org, target.project, {
      limit: options.limit,
      cursor: options.startCursor,
    });
    return {
      target,
      items: page.data.map((dsn) => ({
        ...dsn,
        org: target.org,
        project: target.project,
      })),
      hasMore: !!page.nextCursor,
      nextCursor: page.nextCursor ?? undefined,
    };
  });
  return result.ok
    ? { success: true, data: result.value }
    : {
        success: false,
        error:
          result.error instanceof Error
            ? result.error
            : new Error(String(result.error)),
      };
}

/** Stable identity for both resolved targets and displayed rows. */
const targetKey = (target: Pick<ResolvedTarget, "org" | "project">) =>
  `${target.org}/${target.project}`;

/** Collect successful pages, reporting partial failures and throwing if all fail. */
function collectProjectResults(
  results: FetchResult<DsnProjectPage>[],
  targets: ResolvedTarget[]
) {
  const pages = new Map<string, DsnProjectPage>();
  const failures: { project: string; error: Error }[] = [];
  for (const [index, result] of results.entries()) {
    if (result.success) {
      pages.set(targetKey(result.data.target), result.data);
    } else {
      const target = targets[index];
      if (target) {
        failures.push({ project: targetKey(target), error: result.error });
      }
    }
  }
  if (pages.size === 0 && failures[0]) {
    throw failures[0].error;
  }
  if (failures.length > 0) {
    logger.warn(
      `Failed to fetch DSNs from ${failures.map((failure) => failure.project).join(", ")}. Showing results from ${pages.size} project(s).`
    );
  }
  return { pages, failures };
}

/** Resolve list targets, then merge bounded pages using the shared cursor stack. */
async function listForResolvedProjects<
  T extends "auto-detect" | "explicit" | "project-search",
>(ctx: HandlerContext<T>): Promise<ListResult<DsnListItem>> {
  const resolution = await resolveProjectBoundTargets(ctx.parsed, {
    cwd: ctx.cwd,
    usageHint: USAGE_HINT,
    projectSearchResolution: ctx.projectSearchResolution,
  });
  if (resolution.targets.length === 0) {
    throw new ContextError(
      "Organization and project",
      USAGE_HINT,
      undefined,
      resolution.skippedSelfHosted
        ? `Found ${resolution.skippedSelfHosted} DSN(s) that could not be resolved — you may not have access to these projects`
        : undefined
    );
  }

  const limitRequests = pLimit(ORG_FANOUT_CONCURRENCY);
  // Canonical slugs keep both output and cursor identity stable as caches warm.
  const targets = await Promise.all(
    resolution.targets.map((target) =>
      limitRequests(() => resolveTargetSlugs(target))
    )
  );
  const { flags } = ctx;
  const firstTarget = targets[0];
  const contextKey =
    targets.length === 1 && firstTarget
      ? buildPaginationContextKey(
          "project",
          `${firstTarget.org}/${firstTarget.project}`,
          { limit: String(flags.limit) }
        )
      : buildMultiTargetContextKey(targets, { limit: flags.limit });
  const { cursor, direction } = resolveCursor(
    flags.cursor,
    PAGINATION_KEY,
    contextKey
  );
  const sortedKeys = targets.map(targetKey).sort();
  const { startCursors, exhausted } = decodeTargetCursors(cursor, sortedKeys);
  const activeTargets = targets.filter(
    (target) => !exhausted.has(targetKey(target))
  );
  const { results, hasMore } = await withProgress(
    { message: "Fetching DSNs...", json: flags.json },
    (setMessage) =>
      fetchGroupsWithBudget(activeTargets, {
        limit: flags.limit,
        startCursors,
        getGroupKey: targetKey,
        getItems: (page: DsnProjectPage) => page.items,
        fetchGroup: (target, options) =>
          limitRequests(() => fetchProjectPage(target, options)),
        onProgress: (count) =>
          setMessage(
            `Fetching DSNs, ${count} and counting (up to ${flags.limit})...`
          ),
      })
  );
  const { pages, failures } = collectProjectResults(results, activeTargets);
  const allItems = [...pages.values()].flatMap((page) => page.items);
  const items = trimWithGroupGuarantee(allItems, flags.limit, targetKey);
  const trimmed = items.length < allItems.length;
  const cursors = sortedKeys.map((key) => {
    if (exhausted.has(key)) {
      return null;
    }
    const page = pages.get(key);
    return page ? (page.nextCursor ?? null) : (startCursors.get(key) ?? null);
  });
  // A cursor after display trimming would skip fetched but undisplayed keys.
  const nextCursor =
    !trimmed && cursors.some((value) => value !== null)
      ? encodeCompoundCursor(cursors)
      : undefined;
  advancePaginationState(PAGINATION_KEY, contextKey, direction, nextCursor);
  const hasPrev = hasPreviousPage(PAGINATION_KEY, contextKey);
  const more = hasMore || trimmed || !!nextCursor;
  const nav = paginationHint({
    hasPrev,
    hasMore: !!nextCursor,
    prevHint: "-c prev",
    nextHint: "-c next",
  });
  const footer = resolution.detectedDsns
    ? formatMultipleProjectsFooter(targets)
    : resolution.footer;
  const higherLimit = Math.min(flags.limit * 2, LIST_MAX_LIMIT);
  return {
    items,
    hasMore: more,
    hasPrev,
    nextCursor,
    hint: [
      footer,
      nav,
      trimmed && higherLimit > flags.limit
        ? `Use -n ${higherLimit} for more.`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
    errors:
      failures.length > 0
        ? failures.map(({ project, error }) => ({
            project,
            ...(error instanceof ApiError && { status: error.status }),
            message: error.message,
          }))
        : undefined,
  };
}

export const listCommand = buildListCommand("dsn", {
  docs: {
    brief: "List DSNs",
    fullDescription:
      "List public DSNs with their name, enabled status, and creation date.\n" +
      "Includes enabled and disabled client keys.\n\n" +
      "Use <org>/ to list DSNs across all accessible projects in an organization.\n" +
      "Omit the target to detect projects from your config or DSNs, including monorepos.\n" +
      `${targetPatternExplanation()}\n\n` +
      "Examples:\n" +
      "  sentry dsn list\n" +
      "  sentry dsn list my-org/my-project\n" +
      "  sentry dsn list my-org/\n" +
      "  sentry dsn list my-org/ -c next\n" +
      "  sentry dsn list my-org/my-project -c next\n" +
      "  sentry dsn list my-org/my-project --json\n\n" +
      "JSON fields: org, project, name, dsn, isActive, dateCreated.",
  },
  output: {
    human: formatDsnList,
    jsonTransform: (result: ListResult<DsnListItem>, fields?: string[]) =>
      jsonTransformListResult(result, fields),
  },
  parameters: {
    positional: LIST_TARGET_POSITIONAL,
    flags: {
      limit: {
        ...buildListLimitFlag("DSNs"),
        parse: (value: string) =>
          validateLimit(value, LIST_MIN_LIMIT, LIST_MAX_LIMIT),
      },
    },
    aliases: { n: "limit" },
  },
  async *func(this: SentryContext, flags: BaseListFlags, target?: string) {
    const result: ListResult<DsnListItem> = await dispatchOrgScopedList({
      config: listConfig,
      parsed: parseOrgProjectArg(target),
      cwd: this.cwd,
      flags,
      allowCursorInModes: ["auto-detect", "explicit", "project-search"],
      overrides: {
        "org-all": (ctx) => listForOrganization(ctx.parsed.org, ctx.flags),
        explicit: listForResolvedProjects,
        "auto-detect": listForResolvedProjects,
        "project-search": listForResolvedProjects,
      },
    });
    yield new CommandOutput(result);
    return { hint: result.hint };
  },
});
