/**
 * Shared infrastructure for org-scoped list commands (team, repo, project, issue, …).
 *
 * ## Config types
 *
 * Commands that rely entirely on default handlers supply a full {@link OrgListConfig}.
 * Commands that override every mode only need {@link ListCommandMeta} (metadata used
 * for error messages and cursor keys).
 *
 * ## Dispatch
 *
 * {@link dispatchOrgScopedList} merges a map of default handlers with caller-supplied
 * {@link ModeOverrides} using `{ ...defaults, ...overrides }`, then calls the handler
 * for the current parsed target type. This lets any command replace exactly the modes
 * it needs to customise while inheriting the rest.
 *
 * ## Default handler behaviour
 *
 * | Mode           | Default behaviour                                                        |
 * |----------------|--------------------------------------------------------------------------|
 * | auto-detect    | Resolve orgs from DSN/config; fetch from all, return items               |
 * | explicit       | If `listForProject` provided, use project-scoped fetch; else org-scoped  |
 * | project-search | Classify the target; use project or org-scoped fetch                    |
 * | org-all        | Cursor-paginated single-org listing                                      |
 *
 * ## Data flow
 *
 * All handlers return a {@link ListResult} containing items and rendering metadata.
 * The caller (typically {@link buildOrgListCommand} in `list-command.ts`) decides
 * how to render the result — JSON envelope, human table, or custom formatting.
 */

import { paginate } from "./api/infrastructure.js";
import { listOrganizations, type PaginatedResponse } from "./api-client.js";
import { explicitProjectSlugs, type ParsedOrgProject } from "./arg-parsing.js";
import {
  advancePaginationState,
  buildOrgContextKey,
  type CursorDirection,
  hasPreviousPage,
  resolveCursor,
} from "./db/pagination.js";
import {
  type AuthGuardSuccess,
  ResolutionError,
  ValidationError,
  withAuthGuard,
} from "./errors.js";
import { filterFields } from "./formatters/json.js";
import { paginationHint } from "./list-command.js";
import { logger } from "./logger.js";
import { withProgress } from "./polling.js";
import { resolveEffectiveOrg } from "./region.js";
import {
  classifyProjectSearchTarget,
  type ProjectSearchTargetResolution,
  projectSearchNotFoundSuggestions,
  resolveOrgsForListing,
} from "./resolve-target.js";
import { setOrgProjectContext } from "./telemetry.js";

const log = logger.withTag("org-list");

/**
 * Return type for all org-scoped list handlers.
 *
 * Contains the items plus metadata for rendering (human formatter)
 * and JSON serialization (jsonTransform). The caller decides how to
 * render — handlers never write to stdout directly.
 *
 * @template T - The item type (typically `TWithOrg` with org context)
 */
export type ListResult<T> = {
  /** The items to display */
  items: T[];
  /** Whether more pages are available */
  hasMore?: boolean;
  /** Whether a previous page exists (for bidirectional hint generation) */
  hasPrev?: boolean;
  /** Cursor for fetching the next page (only in paginated modes) */
  nextCursor?: string | null;
  /** Human-readable hint lines (tips, warnings, notes). Suppressed in JSON mode. */
  hint?: string;
  /** Header/title text shown above the table in human mode */
  header?: string;
  /** Fetch errors from partial failures (included in JSON output as `errors` key) */
  errors?: unknown[];
  /** Extra metadata to include in the JSON envelope */
  jsonExtra?: Record<string, unknown>;
};

/**
 * Transform a {@link ListResult} into the standard JSON output format.
 *
 * Paginated responses produce a `{ data, hasMore, nextCursor?, errors?, ... }` envelope.
 * Non-paginated responses produce a flat `[...]` array.
 * Field filtering is applied per-element inside `data`, not to the wrapper.
 *
 * This is the canonical implementation used by all list commands — callers
 * should not duplicate this logic.
 */
export function jsonTransformListResult<T>(
  result: ListResult<T>,
  fields?: string[],
): unknown {
  const items =
    fields && fields.length > 0
      ? result.items.map((item) => filterFields(item, fields))
      : result.items;

  // Paginated mode: wrap in envelope
  if (result.hasMore !== undefined) {
    const envelope: Record<string, unknown> = {
      data: items,
      hasMore: result.hasMore,
    };
    if (
      result.nextCursor !== null &&
      result.nextCursor !== undefined &&
      result.nextCursor !== ""
    ) {
      envelope.nextCursor = result.nextCursor;
    }
    envelope.hasPrev = !!result.hasPrev;
    if (result.errors && result.errors.length > 0) {
      envelope.errors = result.errors;
    }
    if (result.jsonExtra) {
      Object.assign(envelope, result.jsonExtra);
    }
    return envelope;
  }

  // Non-paginated: flat array
  return items;
}

/**
 * Per-target (or per-org) fetch result for budget-aware list commands.
 *
 * Wraps a success value or a captured error so that `fetchWithBudget`
 * can run all fetches in parallel and report partial failures via
 * `logger.warn` instead of throwing.
 *
 * @template T - The success payload type (e.g. `AlertRuleListFetchResult`)
 */
export type FetchResult<T> =
  | { success: true; data: T }
  | { success: false; error: Error };

/**
 * Distribute a global fetch budget across groups in deterministic order.
 *
 * By default, the returned quotas sum exactly to `limit`. When
 * `minimumPerGroup` is true, every group receives at least one slot, so the
 * sum can exceed `limit` if there are more groups than display slots. Use that
 * mode only for first-page fan-out where display trimming can suppress unsafe
 * cursor pagination.
 */
export function distributeFetchBudget(
  limit: number,
  groupCount: number,
  options: { minimumPerGroup?: boolean } = {},
): number[] {
  if (groupCount <= 0) {
    return [];
  }

  const total = Math.max(0, Math.floor(limit));
  const base = Math.floor(total / groupCount);
  const remainder = total % groupCount;
  const minimum = options.minimumPerGroup ? 1 : 0;

  return Array.from({ length: groupCount }, (_, i) =>
    Math.max(minimum, base + (i < remainder ? 1 : 0)),
  );
}

/** Cursor metadata required by the shared multi-group fetcher. */
export type ListFetchPage = {
  /** Whether the group has additional items. */
  hasMore?: boolean;
  /** Server cursor, absent when the group is exhausted. */
  nextCursor?: string;
};

/** A group's item budget and optional position within that group's results. */
export type GroupFetchOptions = {
  /** Maximum items to fetch for this group. */
  limit: number;
  /** Resume cursor; undefined starts at the group's first page. */
  startCursor?: string;
};

/** Domain adapters for fetching pages within one global item budget. */
export type FetchGroupsOptions<TGroup, TItem, TPage extends ListFetchPage> = {
  /** Total display budget, redistributed across groups. */
  limit: number;
  /** Resume positions keyed by getGroupKey; absent entries start fresh. */
  startCursors?: Map<string, string>;
  /** Stable identity associating a group with its cursor. */
  getGroupKey: (group: TGroup) => string;
  /** Fetch bounded items, capturing non-auth failures in FetchResult. */
  fetchGroup: (
    group: TGroup,
    options: GroupFetchOptions,
  ) => Promise<FetchResult<TPage>>;
  /** Returns the page's mutable item array; surplus results are appended to it. */
  getItems: (page: TPage) => TItem[];
  /** Receives the total fetched count after each budget phase. */
  onProgress: (fetched: number) => void;
};

function countFetchedItems<TItem, TPage>(
  results: FetchResult<TPage>[],
  getItems: (page: TPage) => TItem[],
): number {
  return results.reduce(
    (total, result) =>
      total + (result.success ? getItems(result.data).length : 0),
    0,
  );
}

function hasMorePages<TPage extends ListFetchPage>(
  results: FetchResult<TPage>[],
): boolean {
  return results.some((result) => result.success && result.data.hasMore);
}

/**
 * Fetch groups with a global budget, then redistribute unused slots once.
 *
 * Each group initially receives at least one slot. If there are more groups
 * than display slots, callers must trim the rows and suppress unsafe cursors.
 * A failed surplus request preserves the group's first-page data and cursor,
 * so a later request can retry without losing already fetched items.
 * Fetch callbacks own error capture; this helper preserves their result order.
 */
export async function fetchGroupsWithBudget<
  TGroup,
  TItem,
  TPage extends ListFetchPage,
>(
  groups: TGroup[],
  options: FetchGroupsOptions<TGroup, TItem, TPage>,
): Promise<{ results: FetchResult<TPage>[]; hasMore: boolean }> {
  const { limit, startCursors, getGroupKey, fetchGroup, getItems, onProgress } =
    options;
  const quotas = distributeFetchBudget(limit, groups.length, {
    minimumPerGroup: true,
  });
  const phase1 = await Promise.all(
    groups.map((group, index) =>
      fetchGroup(group, {
        limit: quotas[index] ?? 1,
        startCursor: startCursors?.get(getGroupKey(group)),
      }),
    ),
  );

  let totalFetched = countFetchedItems(phase1, getItems);
  onProgress(totalFetched);

  const surplus = limit - totalFetched;
  if (surplus <= 0) {
    return { results: phase1, hasMore: hasMorePages(phase1) };
  }

  const expandable = phase1.flatMap((result, index) => {
    const group = groups[index];
    if (group === undefined || !result.success || !result.data.nextCursor) {
      return [];
    }
    return [{ group, index, cursor: result.data.nextCursor }];
  });
  const extraQuotas = distributeFetchBudget(surplus, expandable.length);
  const requests = expandable.flatMap((request, index) => {
    const extraLimit = extraQuotas[index] ?? 0;
    return extraLimit > 0 ? [{ ...request, limit: extraLimit }] : [];
  });

  const phase2 = await Promise.all(
    requests.map(({ group, limit: requestLimit, cursor }) =>
      fetchGroup(group, { limit: requestLimit, startCursor: cursor }),
    ),
  );
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index];
    const p1 = request ? phase1[request.index] : undefined;
    const p2 = phase2[index];
    if (p1?.success && p2?.success) {
      getItems(p1.data).push(...getItems(p2.data));
      p1.data.hasMore = p2.data.hasMore;
      p1.data.nextCursor = p2.data.nextCursor;
    }
  }

  totalFetched = countFetchedItems(phase1, getItems);
  onProgress(totalFetched);
  return { results: phase1, hasMore: hasMorePages(phase1) };
}

/**
 * Trim an array to `limit` entries while guaranteeing at least one entry
 * per group (when possible).
 *
 * Algorithm:
 * 1. Walk the list, picking the first entry from each unseen group key until
 *    `limit` slots are filled or all groups are represented.
 * 2. Fill remaining slots from the top of the list, skipping already-selected
 *    entries.
 * 3. Return the final set in original order.
 *
 * When there are more groups than the limit, groups whose first entry ranks
 * highest in the input order get representation.
 *
 * @param rows - Input array (order is preserved in output)
 * @param limit - Maximum number of entries to return
 * @param getGroupKey - Returns the group key for an entry (e.g. "org/project")
 * @returns Trimmed array in the same order as the input
 */
export function trimWithGroupGuarantee<T>(
  rows: T[],
  limit: number,
  getGroupKey: (row: T) => string,
): T[] {
  if (rows.length <= limit) {
    return rows;
  }

  const seenGroups = new Set<string>();
  const guaranteed = new Set<number>();

  // Pass 1: pick one representative per group from the list
  for (let i = 0; i < rows.length && guaranteed.size < limit; i++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- i is within bounds
    const key = getGroupKey(rows[i]!);
    if (!seenGroups.has(key)) {
      seenGroups.add(key);
      guaranteed.add(i);
    }
  }

  // Pass 2: fill remaining budget from the top of the list
  const selected = new Set<number>(guaranteed);
  for (let i = 0; i < rows.length && selected.size < limit; i++) {
    selected.add(i);
  }

  return rows.filter((_, i) => selected.has(i));
}

/**
 * Metadata required by all list commands.
 *
 * Commands that override every dispatch mode can provide just this — the
 * metadata is used for cursor storage keys, error messages, and usage hints.
 */
export type ListCommandMeta = {
  /** Key stored in the pagination cursor table (e.g., "team-list") */
  paginationKey: string;
  /** Plural entity name for messages (e.g., "teams") */
  entityPlural: string;
  /** CLI command prefix for hints (e.g., "sentry team list") */
  commandPrefix: string;
};

/** Minimal flags required by the shared infrastructure. */
export type BaseListFlags = {
  readonly limit: number;
  readonly json: boolean;
  readonly cursor?: string;
  /** Pre-parsed field paths from `--fields` (injected by `buildCommand`). */
  readonly fields?: string[];
};

/**
 * Full configuration for an org-scoped list command using default handlers.
 *
 * @template TEntity   Raw entity type from the API (e.g., SentryTeam)
 * @template TWithOrg  Entity with orgSlug attached for display
 */
export type OrgListConfig<TEntity, TWithOrg> = ListCommandMeta & {
  /**
   * Fetch all entities for one org (non-paginated).
   * @returns Raw entities from the API
   */
  listForOrg: (orgSlug: string) => Promise<TEntity[]>;

  /**
   * Fetch one page of entities for an org (paginated).
   * @returns Paginated response with cursor info
   */
  listPaginated: (
    orgSlug: string,
    opts: { cursor?: string; perPage: number },
  ) => Promise<PaginatedResponse<TEntity[]>>;

  /**
   * Attach org context to a raw entity for display.
   * Typically `{ ...entity, orgSlug }`.
   */
  withOrg: (entity: TEntity, orgSlug: string) => TWithOrg;

  /**
   * Render a list of entities as a formatted table string.
   * Called by the human output path in `buildOrgListCommand`.
   */
  displayTable: (items: TWithOrg[]) => string;

  /**
   * Fetch entities scoped to a specific project (optional).
   *
   * When provided:
   * - `explicit` mode (`org/project`) fetches project-scoped entities instead
   *   of all entities in the org.
   * - `project-search` mode fetches project-scoped entities after finding the
   *   project via cross-org search.
   *
   * When absent:
   * - `explicit` mode falls back to org-scoped listing with a note that the
   *   entity type is org-scoped and the project part is ignored.
   * - `project-search` mode falls back to org-scoped listing from the found
   *   project's parent org.
   */
  listForProject?: (orgSlug: string, projectSlug: string) => Promise<TEntity[]>;

  /**
   * Valibot schema describing the JSON output shape of each list item.
   * Forwarded to `OutputConfig.schema` by `buildOrgListCommand` so
   * `--help`, `sentry help`, and SKILL.md can document available fields.
   */
  schema?: import("valibot").GenericSchema;
};

/** Extract a specific variant from the {@link ParsedOrgProject} union by its `type` discriminant. */
export type ParsedVariant<T extends ParsedOrgProject["type"]> = Extract<
  ParsedOrgProject,
  { type: T }
>;

/**
 * Context object passed to every mode handler by the dispatcher.
 *
 * Contains the correctly-narrowed parsed variant, working directory, flags,
 * and any request-scoped project-search classification.
 * Commands that need additional fields (e.g. `stderr`) can
 * spread the context and add their own: `(ctx) => handle({ ...ctx, extra })`.
 */
export type HandlerContext<
  T extends ParsedOrgProject["type"] = ParsedOrgProject["type"],
> = {
  /** Correctly-narrowed parsed target for this mode. */
  parsed: ParsedVariant<T>;
  /** Current working directory (for DSN auto-detection). */
  cwd: string;
  /** Shared list command flags (limit, json, cursor). */
  flags: BaseListFlags;
  /**
   * Request-scoped result from the bare project-slug pre-check.
   *
   * Present only when project-search mode continues to a handler.
   */
  projectSearchResolution?: ProjectSearchTargetResolution;
};

/**
 * A dispatch handler that receives a {@link HandlerContext} with the
 * correctly-narrowed parsed variant for its mode.
 *
 * Returns a {@link ListResult} containing items and rendering metadata.
 * The dispatcher guarantees `ctx.parsed.type` matches the handler key, so
 * callers can safely access variant-specific fields (e.g. `.org`, `.projectSlug`)
 * without runtime checks or manual casts.
 */
export type ModeHandler<
  T extends ParsedOrgProject["type"] = ParsedOrgProject["type"],
  TItem = unknown,
> = (ctx: HandlerContext<T>) => Promise<ListResult<TItem>>;

/**
 * Complete handler map — one handler per parsed target type.
 * Each handler receives a {@link HandlerContext} with the corresponding
 * {@link ParsedVariant} and returns a {@link ListResult}.
 */
export type ModeHandlerMap = {
  // oxlint-disable-next-line typescript/no-explicit-any -- item type varies per command; erased at dispatch
  [K in ParsedOrgProject["type"]]: ModeHandler<K, any>;
};

/**
 * Partial handler map for overriding specific dispatch modes.
 *
 * Provide only the modes you need to customise; the rest will use
 * the default handlers from {@link buildDefaultHandlers}.
 */
export type ModeOverrides = {
  // oxlint-disable-next-line typescript/no-explicit-any -- item type varies per command; erased at dispatch
  [K in ParsedOrgProject["type"]]?: ModeHandler<K, any>;
};

/**
 * Narrows `ListCommandMeta | OrgListConfig` to a full `OrgListConfig`.
 * Checks for the presence of `listForOrg` which only the full config has.
 */
export function isOrgListConfig<TEntity, TWithOrg>(
  config: ListCommandMeta | OrgListConfig<TEntity, TWithOrg>,
): config is OrgListConfig<TEntity, TWithOrg> {
  return "listForOrg" in config;
}

/**
 * Fetch entities for a single org, returning empty array on non-auth errors.
 * Auth errors propagate so the user sees "please log in".
 */
export async function fetchOrgSafe<TEntity, TWithOrg>(
  config: OrgListConfig<TEntity, TWithOrg>,
  orgSlug: string,
): Promise<TWithOrg[]> {
  const result = await withAuthGuard(async () => {
    const items = await config.listForOrg(orgSlug);
    return items.map((item) => config.withOrg(item, orgSlug));
  });
  return result.ok ? result.value : [];
}

/**
 * Fetch entities from all accessible organisations.
 * Skips orgs where the user lacks access (non-auth errors are swallowed).
 */
export async function fetchAllOrgs<TEntity, TWithOrg>(
  config: OrgListConfig<TEntity, TWithOrg>,
): Promise<TWithOrg[]> {
  const orgs = await listOrganizations();
  const results = await Promise.all(
    orgs.map((org) => fetchOrgSafe(config, org.slug)),
  );
  return results.flat();
}

/** Options for {@link handleOrgAll}. */
type OrgAllOptions<TEntity, TWithOrg> = {
  config: OrgListConfig<TEntity, TWithOrg>;
  org: string;
  flags: BaseListFlags;
  contextKey: string;
  cursor: string | undefined;
  direction: CursorDirection;
};

/**
 * Run org-all mode for a given org slug.
 *
 * Convenience wrapper around {@link handleOrgAll} used by the project-search
 * fallback when a bare slug turns out to be an organization. Starts a fresh
 * listing (no cursor) for the org.
 */
function runOrgAll<TEntity, TWithOrg>(
  config: OrgListConfig<TEntity, TWithOrg>,
  org: string,
  flags: BaseListFlags,
): Promise<ListResult<TWithOrg>> {
  const contextKey = buildOrgContextKey(org);
  return handleOrgAll({
    config,
    org,
    flags,
    contextKey,
    cursor: undefined,
    direction: "first",
  });
}

/**
 * Handle org-all mode: cursor-paginated listing for a single org.
 *
 * `--limit` is the total number of items to return. When it exceeds the API
 * page size, this handler auto-paginates via {@link paginate} instead of
 * sending an oversized `per_page` (some endpoints 400 rather than silently
 * cap).
 *
 * Returns a {@link ListResult} with items, pagination state, and human hints.
 * Cursor side effects (advancePaginationState/clearPaginationState) are performed
 * inside the handler so callers don't need to manage them.
 */
export async function handleOrgAll<TEntity, TWithOrg>(
  options: OrgAllOptions<TEntity, TWithOrg>,
): Promise<ListResult<TWithOrg>> {
  const { config, org, flags, contextKey, cursor, direction } = options;

  const response = await withProgress(
    {
      message: `Fetching ${config.entityPlural} (up to ${flags.limit})...`,
      json: flags.json,
    },
    () =>
      paginate({ limit: flags.limit, cursor }, (perPage, pageCursor) =>
        config.listPaginated(org, {
          cursor: pageCursor,
          perPage,
        }),
      ),
  );

  const { data: rawItems, nextCursor } = response;
  const items = rawItems.map((entity) => config.withOrg(entity, org));
  const hasMore = !!nextCursor;

  advancePaginationState(
    config.paginationKey,
    contextKey,
    direction,
    nextCursor ?? undefined,
  );
  const hasPrev = hasPreviousPage(config.paginationKey, contextKey);

  // Empty results use hint (rendered by human formatter directly).
  // Non-empty results use header (rendered inline after the table).
  let hint: string | undefined;
  let header: string | undefined;

  const base = `${config.commandPrefix} ${org}/`;
  const navHint = paginationHint({
    hasPrev,
    hasMore,
    prevHint: `${base} -c prev`,
    nextHint: `${base} -c next`,
  });

  if (items.length === 0) {
    if (navHint) {
      hint = `No ${config.entityPlural} on this page. ${navHint}`;
    } else {
      hint = `No ${config.entityPlural} found in organization '${org}'.`;
    }
  } else if (hasMore) {
    header = `Showing ${items.length} ${config.entityPlural} (more available)\n${navHint}`;
  } else if (navHint) {
    // Last page but previous pages exist — show count + nav hint without "more available"
    header = `Showing ${items.length} ${config.entityPlural}\n${navHint}`;
  } else {
    header = `Showing ${items.length} ${config.entityPlural}`;
  }

  return {
    items,
    hasMore,
    hasPrev,
    nextCursor: nextCursor ?? null,
    hint,
    header,
  };
}

/**
 * Handle auto-detect mode: resolve orgs from config/DSN, fetch all entities.
 *
 * Returns a {@link ListResult} with the merged items from all resolved orgs.
 */
export async function handleAutoDetect<TEntity, TWithOrg>(
  config: OrgListConfig<TEntity, TWithOrg>,
  cwd: string,
  flags: BaseListFlags,
): Promise<ListResult<TWithOrg>> {
  const {
    orgs: orgsToFetch,
    footer,
    skippedSelfHosted,
  } = await resolveOrgsForListing(undefined, cwd);

  const allItems = await withProgress(
    {
      message: `Fetching ${config.entityPlural} (up to ${flags.limit})...`,
      json: flags.json,
    },
    async () => {
      if (orgsToFetch.length > 0) {
        const results = await Promise.all(
          orgsToFetch.map((org) => fetchOrgSafe(config, org)),
        );
        return results.flat();
      }
      return fetchAllOrgs(config);
    },
  );

  const limitCount =
    orgsToFetch.length > 1 ? flags.limit * orgsToFetch.length : flags.limit;
  const limited = allItems.slice(0, limitCount);

  const hintParts: string[] = [];

  if (limited.length === 0) {
    const msg =
      orgsToFetch.length === 1
        ? `No ${config.entityPlural} found in organization '${orgsToFetch[0]}'.`
        : `No ${config.entityPlural} found.`;
    hintParts.push(msg);
  }

  if (allItems.length > limited.length) {
    hintParts.push(
      `Showing ${limited.length} of ${allItems.length} ${config.entityPlural}`,
    );
  }

  if (footer) {
    hintParts.push(footer);
  }

  if (skippedSelfHosted) {
    hintParts.push(
      `Note: ${skippedSelfHosted} DSN(s) could not be resolved. ` +
        `Specify the organization explicitly: ${config.commandPrefix} <org>/`,
    );
  }

  if (limited.length > 0) {
    hintParts.push(
      `Tip: Use '${config.commandPrefix} <org>/' to filter by organization`,
    );
  }

  return {
    items: limited,
    hint: hintParts.length > 0 ? hintParts.join("\n") : undefined,
  };
}

/** Options for {@link buildFetchedItemsResult}. */
type FetchedItemsOptions<TEntity, TWithOrg> = {
  config: OrgListConfig<TEntity, TWithOrg>;
  items: TWithOrg[];
  flags: BaseListFlags;
  /** Human-readable context for "No X found in <label>" messages. */
  contextLabel: string;
  /**
   * Raw org slug for the pagination hint command (e.g. "my-org").
   * When provided and results are truncated, emits a hint like
   * `sentry team list my-org/ for paginated results`.
   */
  orgSlugForHint?: string;
};

/**
 * Build a {@link ListResult} for entities fetched for a single org or project scope.
 * Shared by handleExplicitOrg and handleExplicitProject.
 */
function buildFetchedItemsResult<TEntity, TWithOrg>(
  opts: FetchedItemsOptions<TEntity, TWithOrg>,
): ListResult<TWithOrg> {
  const { config, items, flags, contextLabel, orgSlugForHint } = opts;
  const limited = items.slice(0, flags.limit);

  if (limited.length === 0) {
    return {
      items: [],
      hint: `No ${config.entityPlural} found in ${contextLabel}.`,
    };
  }

  const hintParts: string[] = [];
  if (items.length > limited.length) {
    const paginateTip = orgSlugForHint
      ? ` Use '${config.commandPrefix} ${orgSlugForHint}/' for paginated results.`
      : "";
    hintParts.push(
      `Showing ${limited.length} of ${items.length} ${config.entityPlural}.${paginateTip}`,
    );
  } else {
    hintParts.push(`Showing ${limited.length} ${config.entityPlural}`);
  }

  return {
    items: limited,
    hint: hintParts.join("\n"),
  };
}

/** Options for {@link handleExplicitOrg}. */
type ExplicitOrgOptions<TEntity, TWithOrg> = {
  config: OrgListConfig<TEntity, TWithOrg>;
  org: string;
  flags: BaseListFlags;
  /** When true, include a note that the entity type is org-scoped. */
  noteOrgScoped?: boolean;
};

/**
 * Handle a single explicit org (non-paginated fetch).
 *
 * When the config has no `listForProject`, this is also the fallback for
 * explicit `org/project` mode — a note is included to inform the user
 * that the entity type is org-scoped.
 *
 * Returns a {@link ListResult} with items and contextual hints.
 */
export async function handleExplicitOrg<TEntity, TWithOrg>(
  options: ExplicitOrgOptions<TEntity, TWithOrg>,
): Promise<ListResult<TWithOrg>> {
  const { config, org, flags, noteOrgScoped = false } = options;
  const items = await withProgress(
    {
      message: `Fetching ${config.entityPlural} (up to ${flags.limit})...`,
      json: flags.json,
    },
    () => fetchOrgSafe(config, org),
  );

  const result = buildFetchedItemsResult({
    config,
    items,
    flags,
    contextLabel: `organization '${org}'`,
  });

  // Org-scoped note goes in header so it renders as plain text (not muted).
  if (noteOrgScoped) {
    const note = `Note: ${config.entityPlural} are org-scoped. Showing all ${config.entityPlural} in '${org}'.`;
    result.header = result.header ? `${note}\n${result.header}` : note;
  }

  if (items.length > 0) {
    const tip = `Tip: Use '${config.commandPrefix} ${org}/' for paginated results`;
    result.hint = result.hint ? `${result.hint}\n${tip}` : tip;
  }

  return result;
}

/** Options for {@link handleExplicitProject}. */
type ExplicitProjectOptions<TEntity, TWithOrg> = {
  config: OrgListConfig<TEntity, TWithOrg>;
  org: string;
  project: string;
  flags: BaseListFlags;
};

/**
 * Handle explicit `org/project` mode when `listForProject` is available.
 * Fetches entities scoped to the specific project.
 *
 * `config.listForProject` must be defined — callers must guard before calling.
 *
 * Returns a {@link ListResult} with items and hint text.
 */
export async function handleExplicitProject<TEntity, TWithOrg>(
  options: ExplicitProjectOptions<TEntity, TWithOrg>,
): Promise<ListResult<TWithOrg>> {
  const { config, org, project, flags } = options;
  const listForProject = config.listForProject;
  if (!listForProject) {
    throw new Error(
      "handleExplicitProject called but config.listForProject is not defined",
    );
  }
  const raw = await withProgress(
    {
      message: `Fetching ${config.entityPlural} (up to ${flags.limit})...`,
      json: flags.json,
    },
    () => listForProject(org, project),
  );
  const items = raw.map((entity) => config.withOrg(entity, org));

  const result = buildFetchedItemsResult({
    config,
    items,
    flags,
    contextLabel: `project '${org}/${project}'`,
  });

  if (items.length > 0) {
    const tip = `Tip: Use '${config.commandPrefix} ${org}/' to see all ${config.entityPlural} in the org`;
    result.hint = result.hint ? `${result.hint}\n${tip}` : tip;
  }

  return result;
}

/**
 * Handle project-search mode (bare slug, e.g., "cli").
 *
 * Uses the shared target classifier. An exact project wins; when none exists
 * and the slug is an organization, callers pass `orgAllFallback`. The
 * trailing `/` form remains the explicit organization target.
 *
 * If `config.listForProject` is available, fetches entities scoped to each
 * matched project. Otherwise fetches org-scoped entities from the matched
 * project's parent org (since the entity type is org-scoped).
 *
 * @param orgAllFallback - Optional callback invoked when the slug matches
 *   an organization instead of a project. Receives the org slug and should
 *   delegate to the org-all handler. When not provided, a helpful error is
 *   thrown instead.
 *
 * Returns a {@link ListResult} with items and hint text.
 */
// multi-mode dispatch with recovery is inherently branchy
export async function handleProjectSearch<TEntity, TWithOrg>(
  config: OrgListConfig<TEntity, TWithOrg>,
  projectSlug: string,
  options: {
    flags: BaseListFlags;
    orgAllFallback?: (orgSlug: string) => Promise<ListResult<TWithOrg>>;
    /** Original user input before normalization — for clearer messages. */
    originalSlug?: string;
    /** Organization slug to scope the search to (e.g. from "org/My Project"). */
    org?: string;
    /** Classification supplied by the dispatcher after its target pre-check. */
    projectSearchResolution?: ProjectSearchTargetResolution;
  },
): Promise<ListResult<TWithOrg>> {
  const {
    flags,
    orgAllFallback,
    originalSlug,
    org: scopedOrg,
    projectSearchResolution,
  } = options;
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
        message: `Fetching ${config.entityPlural} (up to ${flags.limit})...`,
        json: flags.json,
      },
      () => classifyProjectSearchTarget(parsed),
    ));

  if (resolution.kind === "organization") {
    if (orgAllFallback) {
      log.warn(
        `'${projectSlug}' is an organization, not a project. ` +
          `Listing all ${config.entityPlural} in '${projectSlug}'.`,
      );
      return orgAllFallback(resolution.org);
    }
    throw new ResolutionError(
      `'${projectSlug}'`,
      "is an organization, not a project",
      `${config.commandPrefix} ${projectSlug}/`,
      [
        `List projects: sentry project list ${projectSlug}/`,
        `Specify a project: ${config.commandPrefix} ${projectSlug}/<project>`,
      ],
    );
  }

  if (resolution.kind === "not-found") {
    if (flags.json) {
      return { items: [] };
    }

    throw new ResolutionError(
      `Project '${resolution.displaySlug}'`,
      "not found",
      `${config.commandPrefix} <org>/${projectSlug}`,
      projectSearchNotFoundSuggestions(resolution),
    );
  }

  const matches =
    resolution.kind === "fuzzy-project"
      ? [resolution.projectData]
      : resolution.projects;
  const resolvedProjectSlug =
    resolution.kind === "fuzzy-project" ? resolution.project : projectSlug;
  let allItems: TWithOrg[];

  if (config.listForProject) {
    const listForProject = config.listForProject;
    const results = await Promise.all(
      matches.map((m) =>
        withAuthGuard(async () => {
          const raw = await listForProject(m.orgSlug, m.slug);
          return raw.map((entity) => config.withOrg(entity, m.orgSlug));
        }),
      ),
    );
    allItems = results
      .filter((r): r is AuthGuardSuccess<TWithOrg[]> => r.ok)
      .flatMap((r) => r.value);
  } else {
    const uniqueOrgs = [...new Set(matches.map((m) => m.orgSlug))];
    const results = await Promise.all(
      uniqueOrgs.map((org) => fetchOrgSafe(config, org)),
    );
    allItems = results.flat();
  }

  const limited = allItems.slice(0, flags.limit);

  if (limited.length === 0) {
    return {
      items: [],
      hint: `No ${config.entityPlural} found for project '${resolvedProjectSlug}'.`,
    };
  }

  const hintParts: string[] = [];
  if (allItems.length > limited.length) {
    hintParts.push(
      `Showing ${limited.length} of ${allItems.length} ${config.entityPlural}. Use --limit to show more.`,
    );
  } else {
    hintParts.push(`Showing ${limited.length} ${config.entityPlural}`);
  }

  if (matches.length > 1) {
    hintParts.push(
      `Found '${resolvedProjectSlug}' in ${matches.length} organizations`,
    );
  }

  return {
    items: limited,
    hint: hintParts.join("\n"),
  };
}

/**
 * Build the default `ModeHandlerMap` for the given config.
 *
 * Each handler receives a {@link HandlerContext} with the correctly-narrowed
 * parsed variant, so it can access variant-specific fields without casts.
 *
 * If `config` is only {@link ListCommandMeta} (not a full {@link OrgListConfig}),
 * each default handler throws when invoked — this only happens if a mode is not
 * covered by the caller's overrides, which would be a programming error.
 */
function buildDefaultHandlers<TEntity, TWithOrg>(
  config: ListCommandMeta | OrgListConfig<TEntity, TWithOrg>,
): ModeHandlerMap {
  function notSupported<T extends ParsedOrgProject["type"]>(
    mode: string,
  ): ModeHandler<T> {
    return () =>
      Promise.reject(
        new Error(
          `No handler for '${mode}' mode in '${config.commandPrefix}'. ` +
            "Provide a full OrgListConfig or an override for this mode.",
        ),
      );
  }

  if (!isOrgListConfig(config)) {
    return {
      "auto-detect": notSupported("auto-detect"),
      explicit: notSupported("explicit"),
      "project-search": notSupported("project-search"),
      "org-all": notSupported("org-all"),
    };
  }

  return {
    "auto-detect": (ctx) => handleAutoDetect(config, ctx.cwd, ctx.flags),

    explicit: (ctx) => {
      if (config.listForProject) {
        return handleExplicitProject({
          config,
          org: ctx.parsed.org,
          project: ctx.parsed.project,
          flags: ctx.flags,
        });
      }
      return handleExplicitOrg({
        config,
        org: ctx.parsed.org,
        flags: ctx.flags,
        noteOrgScoped: true,
      });
    },

    "project-search": (ctx) =>
      handleProjectSearch(config, ctx.parsed.projectSlug, {
        flags: ctx.flags,
        orgAllFallback: (orgSlug) => runOrgAll(config, orgSlug, ctx.flags),
        originalSlug: ctx.parsed.originalSlug,
        org: ctx.parsed.org,
        projectSearchResolution: ctx.projectSearchResolution,
      }),

    "org-all": (ctx) => {
      const contextKey = buildOrgContextKey(ctx.parsed.org);
      const { cursor, direction } = resolveCursor(
        ctx.flags.cursor,
        config.paginationKey,
        contextKey,
      );
      return handleOrgAll({
        config,
        org: ctx.parsed.org,
        flags: ctx.flags,
        contextKey,
        cursor,
        direction,
      });
    },
  };
}

/** Options for {@link dispatchOrgScopedList}. */
export type DispatchOptions<TEntity = unknown, TWithOrg = unknown> = {
  /** Full config (for default handlers) or just metadata (all modes overridden). */
  config: ListCommandMeta | OrgListConfig<TEntity, TWithOrg>;
  cwd: string;
  flags: BaseListFlags;
  parsed: ParsedOrgProject;
  /**
   * Per-mode handler overrides. Each key matches a `ParsedOrgProject["type"]`.
   * Provided handlers replace the corresponding default handler; unspecified
   * modes fall back to the defaults from {@link buildDefaultHandlers}.
   */
  overrides?: ModeOverrides;
  /**
   * Mode types that support cursor pagination in addition to `"org-all"`.
   *
   * By default, `--cursor` is rejected in all non-`"org-all"` modes. Callers
   * that implement their own cursor handling (e.g. compound cursors in
   * `issue list`) can list those mode types here to bypass the guard.
   */
  allowCursorInModes?: readonly ParsedOrgProject["type"][];
};

type OrgSlugMatchResult = {
  parsed: ParsedOrgProject;
  projectSearchResolution?: ProjectSearchTargetResolution;
};

/**
 * Pre-check: when a bare slug matches an organization and no project does,
 * redirect to org-all mode before handler dispatch.
 *
 * A project with the same slug wins. Scoped searches (`org/Name`) and
 * display names are left to the handler. `<org>/` never reaches here.
 */
async function resolveOrgSlugMatch(
  parsed: ParsedOrgProject & { type: "project-search" },
  config: ListCommandMeta,
  fuzzy: boolean,
): Promise<OrgSlugMatchResult> {
  if (parsed.org !== undefined || parsed.originalSlug !== undefined) {
    return { parsed };
  }

  const slug = parsed.projectSlug;
  const resolution = await classifyProjectSearchTarget(parsed, {
    fuzzy,
  });

  if (resolution.kind === "organization") {
    log.warn(
      `'${slug}' is an organization, not a project. ` +
        `Listing all ${config.entityPlural} in '${slug}'.`,
    );
    return { parsed: { type: "org-all", org: resolution.org } };
  }

  if (!fuzzy && resolution.kind === "not-found") {
    return { parsed };
  }
  return { parsed, projectSearchResolution: resolution };
}

/**
 * Resolve DSN-style org identifiers and set org/project context for modes
 * that carry an org field. Returns the (possibly updated) parsed object.
 */
async function resolveOrgInParsed(
  parsed: ParsedOrgProject,
): Promise<ParsedOrgProject> {
  if (!("org" in parsed && parsed.org)) {
    return parsed;
  }
  const effectiveOrg = await resolveEffectiveOrg(parsed.org);
  const resolved =
    effectiveOrg !== parsed.org ? { ...parsed, org: effectiveOrg } : parsed;
  if (resolved.type === "explicit" || resolved.type === "org-all") {
    setOrgProjectContext(
      [effectiveOrg],
      resolved.type === "explicit" ? explicitProjectSlugs(resolved) : [],
    );
  }
  return resolved;
}

/**
 * Validate the cursor flag and dispatch to the correct mode handler.
 *
 * Builds a {@link HandlerContext} from the shared fields (cwd, flags,
 * parsed) and passes it to the resolved handler. Merges default handlers
 * with caller-provided overrides using `{ ...defaults, ...overrides }`.
 *
 * Returns the {@link ListResult} from the resolved handler. The caller is
 * responsible for rendering (JSON or human output).
 *
 * This is the single entry point for all org-scoped list commands.
 */
export async function dispatchOrgScopedList<TEntity, TWithOrg>(
  options: DispatchOptions<TEntity, TWithOrg>,
  // oxlint-disable-next-line typescript/no-explicit-any -- TWithOrg varies per command; callers narrow the return type
): Promise<ListResult<any>> {
  const { config, cwd, flags, parsed, overrides } = options;

  let effectiveParsed: ParsedOrgProject = parsed;
  let projectSearchResolution: ProjectSearchTargetResolution | undefined;
  const cursorAllowedModes: readonly ParsedOrgProject["type"][] = [
    "org-all",
    ...(options.allowCursorInModes ?? []),
  ];

  if (effectiveParsed.type === "project-search") {
    const resolution = await resolveOrgSlugMatch(
      effectiveParsed,
      config,
      flags.cursor === undefined ||
        cursorAllowedModes.includes("project-search"),
    );
    effectiveParsed = resolution.parsed;
    projectSearchResolution = resolution.projectSearchResolution;
  }

  if (flags.cursor && !cursorAllowedModes.includes(effectiveParsed.type)) {
    const hint =
      effectiveParsed.type === "project-search"
        ? `\n\nDid you mean '${config.commandPrefix} ${effectiveParsed.projectSlug}/'? ` +
          `A bare name searches for a project — add a trailing slash to list an org's ${config.entityPlural}.`
        : "";
    throw new ValidationError(
      "The --cursor flag requires the <org>/ pattern " +
        `(e.g., ${config.commandPrefix} my-org/).` +
        hint,
      "cursor",
    );
  }

  effectiveParsed = await resolveOrgInParsed(effectiveParsed);

  const defaults = buildDefaultHandlers(config);
  const handlers: ModeHandlerMap = { ...defaults, ...overrides };
  const handler = handlers[effectiveParsed.type];

  const ctx: HandlerContext = {
    parsed: effectiveParsed,
    cwd,
    flags,
    projectSearchResolution,
  };

  // oxlint-disable-next-line typescript/no-explicit-any -- safe — dispatch guarantees type match
  return (handler as ModeHandler<any>)(ctx);
}
