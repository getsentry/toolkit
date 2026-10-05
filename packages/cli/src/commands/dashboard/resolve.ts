/**
 * Shared dashboard resolution utilities
 *
 * Provides org resolution from parsed target arguments and dashboard
 * ID resolution from numeric IDs or title strings.
 */

import { MAX_PAGINATION_PAGES } from "../../lib/api/infrastructure.js";
import {
  API_MAX_PER_PAGE,
  listDashboardsPaginated,
} from "../../lib/api-client.js";
import type { parseOrgProjectArg } from "../../lib/arg-parsing.js";
import {
  ApiError,
  ResolutionError,
  ValidationError,
} from "../../lib/errors.js";
import { fuzzyMatch } from "../../lib/fuzzy.js";
import { logger } from "../../lib/logger.js";
import { resolveOrgOnlyTarget } from "../../lib/resolve-target.js";
import {
  applySentryUrlContext,
  parseSentryUrl,
} from "../../lib/sentry-url-parser.js";
import { isAllDigits } from "../../lib/utils.js";
import {
  type DashboardWidget,
  DISPLAY_TYPES,
  parseAggregate,
  parseSortExpression,
  parseWidgetInput,
  prepareWidgetQueries,
  validateAggregateNames,
  WIDGET_TYPES,
} from "../../types/dashboard.js";

/** Shared widget query flags used by `add` and `edit` commands */
export type WidgetQueryFlags = {
  readonly display?: string;
  readonly dataset?: string;
  readonly query?: string[];
  readonly where?: string;
  readonly "group-by"?: string[];
  readonly sort?: string;
  readonly limit?: number;
};

/**
 * Resolve org slug from a parsed org/project target argument.
 *
 * Dashboard commands only need the org (dashboards are org-scoped), so
 * explicit, org-all, project-search, and auto-detect all resolve to just
 * the org slug.
 *
 * @param parsed - Parsed org/project argument
 * @param cwd - Current working directory for auto-detection
 * @param usageHint - Usage example for error messages
 * @returns Organization slug
 */
export function resolveOrgFromTarget(
  parsed: ReturnType<typeof parseOrgProjectArg>,
  cwd: string,
  usageHint: string
): Promise<string> {
  return resolveOrgOnlyTarget(parsed, cwd, "dashboard", usageHint);
}

/** Result of URL-based dashboard arg extraction */
type DashboardArgResult = {
  dashboardRef: string;
  targetArg: string | undefined;
};

/**
 * Try to extract dashboard ref + org from a Sentry URL.
 *
 * Calls `applySentryUrlContext` for host-scoping trust checks on non-SaaS URLs.
 * Returns null if the input isn't a recognized Sentry URL.
 */
function tryExtractDashboardUrl(
  first: string,
  args: string[]
): DashboardArgResult | null {
  const urlParsed = parseSentryUrl(first);
  if (!urlParsed) {
    return null;
  }
  applySentryUrlContext(urlParsed.baseUrl);
  if (urlParsed.dashboardId) {
    log.warn(
      `Extracted dashboard ID ${urlParsed.dashboardId} from URL` +
        (urlParsed.org ? ` (org: ${urlParsed.org})` : "")
    );
    return {
      dashboardRef: urlParsed.dashboardId,
      targetArg: urlParsed.org ? `${urlParsed.org}/` : undefined,
    };
  }
  // URL recognized but no dashboardId — use org context if available
  if (urlParsed.org) {
    log.warn(`Extracted org '${urlParsed.org}' from URL`);
    if (args.length >= 2) {
      return {
        dashboardRef: args[1] as string,
        targetArg: `${urlParsed.org}/`,
      };
    }
    throw new ValidationError(
      "Dashboard ID or title is required.\n\n" +
        "The URL provided contains an org but no dashboard ID.\n" +
        `Try: sentry dashboard <command> ${urlParsed.org}/ <id-or-title>`,
      "dashboard"
    );
  }
  return null;
}

/**
 * Parse a dashboard reference and optional target from array positional args.
 *
 * Handles:
 * - `<id-or-title>` — single arg (auto-detect org)
 * - `<target> <id-or-title>` — explicit target + dashboard ref
 * - Full Sentry dashboard URL — extracts org + dashboard ID
 *
 * When two args are provided and the first is a bare slug (no `/`), it is
 * normalized to `slug/` so `parseOrgProjectArg` treats it as an org-all
 * target. Dashboards are org-scoped so the project component is irrelevant.
 *
 * @param args - Raw positional arguments
 * @returns Dashboard reference string and optional target arg
 */
export function parseDashboardPositionalArgs(
  args: string[]
): DashboardArgResult {
  if (args.length === 0) {
    throw new ValidationError(
      "Dashboard ID or title is required.",
      "dashboard"
    );
  }

  const first = args[0] as string;

  // URL detection — extract org + dashboard ID from pasted Sentry URLs
  const urlResult = tryExtractDashboardUrl(first, args);
  if (urlResult) {
    return urlResult;
  }

  if (args.length === 1) {
    return {
      dashboardRef: first,
      targetArg: undefined,
    };
  }
  // Normalize bare org slug → org/ (dashboards are org-scoped)
  const target = first.includes("/") ? first : `${first}/`;
  return {
    dashboardRef: args[1] as string,
    targetArg: target,
  };
}

/**
 * Parse dashboard list positional args into a target and optional title filter.
 *
 * Handles:
 * - (empty) — auto-detect org, no filter
 * - `<org/>` or `<org/project>` — target, no filter
 * - `'CLI'` or `'Error*'` or `'*API*'` — auto-detect org, title filter
 * - `<org/> 'Error*'` or `<org> 'Error*'` — target + glob filter
 *
 * A single arg without `/` is always treated as a title filter, not a
 * project-search target. Dashboards are org-scoped so project-search
 * doesn't apply — `resolveOrgFromTarget` ignores the slug anyway.
 * To specify an org, use `org/` or pass two args: `org 'filter'`.
 *
 * When two args are provided and the first is a bare slug (no `/`), it is
 * normalized to `slug/` so `parseOrgProjectArg` treats it as an org-all target.
 *
 * @param args - Raw positional arguments
 * @returns Target arg for org resolution and optional title filter glob
 */
/** Result of URL-based list arg extraction */
type ListArgResult = {
  targetArg: string | undefined;
  titleFilter: string | undefined;
};

/**
 * Try to extract org context from a Sentry URL in dashboard list args.
 *
 * When the URL contains a dashboard ID, throws a helpful error suggesting
 * `sentry dashboard view` instead. When only an org is present, extracts
 * it as the target.
 */
function tryExtractListUrl(
  first: string,
  remaining: string[]
): ListArgResult | null {
  const urlParsed = parseSentryUrl(first);
  if (!urlParsed) {
    return null;
  }
  applySentryUrlContext(urlParsed.baseUrl);
  if (urlParsed.dashboardId) {
    const orgPrefix = urlParsed.org ? `${urlParsed.org}/ ` : "";
    const orgSuffix = urlParsed.org ? ` ${urlParsed.org}/` : "";
    const orgNote = urlParsed.org ? ` in '${urlParsed.org}'` : "";
    throw new ValidationError(
      "This looks like a dashboard URL. To view a specific dashboard:\n\n" +
        `  sentry dashboard view ${orgPrefix}${urlParsed.dashboardId}\n\n` +
        `To list dashboards${orgNote}:\n\n` +
        `  sentry dashboard list${orgSuffix}`,
      "dashboard"
    );
  }
  if (urlParsed.org) {
    log.warn(`Extracted org '${urlParsed.org}' from URL`);
    const titleFilter = remaining.length > 0 ? remaining.join(" ") : undefined;
    return { targetArg: `${urlParsed.org}/`, titleFilter };
  }
  return null;
}

export function parseDashboardListArgs(args: string[]): ListArgResult {
  // buildListCommand's interceptSubcommand may replace args[0] with undefined
  // when the first positional matches a subcommand name (e.g. "view", "create").
  // Filter those out so we don't crash on .includes("/").
  const filtered = args.filter(
    (a): a is string => a !== null && a !== undefined && a !== ""
  );
  if (filtered.length === 0) {
    return { targetArg: undefined, titleFilter: undefined };
  }

  // URL detection — extract org or suggest `view` for dashboard-specific URLs
  const urlResult = tryExtractListUrl(filtered[0] as string, filtered.slice(1));
  if (urlResult) {
    return urlResult;
  }

  if (filtered.length >= 2) {
    // First arg is the target, remaining args are joined as the filter.
    // This handles unquoted multi-word titles: `my-org/ CLI Health` arrives
    // as ["my-org/", "CLI", "Health"] and becomes filter "CLI Health".
    // Normalize bare org slug to org/ format so parseOrgProjectArg treats
    // it as org-all (dashboards are org-scoped, project is irrelevant).
    const raw = filtered[0] as string;
    const target = raw.includes("/") ? raw : `${raw}/`;
    const titleFilter = filtered.slice(1).join(" ");
    return { targetArg: target, titleFilter };
  }
  // 1 arg: if it contains "/" it may be a target, or an org/project/name combo.
  // Without "/" it's always a title filter (dashboards are org-scoped).
  const arg = filtered[0] as string;
  if (arg.includes("/")) {
    return splitOrgProjectName(arg);
  }
  return { targetArg: undefined, titleFilter: arg };
}

/**
 * Split a slash-containing single arg into target and optional title filter.
 *
 * - `org/` or `org/project` (≤1 slash) → target only, no filter
 * - `org/project/name` (2+ slashes) → target is `org/project`, filter is the rest
 *
 * This lets users type `sentry dashboard list my-org/my-project/CLI` as a
 * single arg instead of requiring two separate args.
 */
function splitOrgProjectName(arg: string): {
  targetArg: string | undefined;
  titleFilter: string | undefined;
} {
  const firstSlash = arg.indexOf("/");
  const secondSlash = arg.indexOf("/", firstSlash + 1);

  if (secondSlash === -1) {
    // Only one slash: "org/" or "org/project" — target only
    return { targetArg: arg, titleFilter: undefined };
  }

  // Two+ slashes: split into target + name filter
  const target = arg.slice(0, secondSlash);
  const name = arg.slice(secondSlash + 1);
  if (!name) {
    // Trailing slash after project: "org/project/" → target only
    return { targetArg: arg, titleFilter: undefined };
  }
  return { targetArg: target, titleFilter: name };
}

/**
 * Resolve a dashboard reference (numeric ID or title) to a numeric ID string.
 *
 * If the reference is all digits, returns it directly. Otherwise, paginates
 * through all dashboards searching for a case-insensitive title match.
 * Stops early on first match. On failure, uses fuzzy matching to suggest
 * similar dashboard titles.
 *
 * @param orgSlug - Organization slug
 * @param ref - Dashboard reference (numeric ID or title)
 * @returns Numeric dashboard ID as a string
 */
export async function resolveDashboardId(
  orgSlug: string,
  ref: string
): Promise<string> {
  if (isAllDigits(ref)) {
    return ref;
  }

  const lowerRef = ref.toLowerCase();
  const allTitles: string[] = [];
  const titleToId = new Map<string, string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
    const { data, nextCursor } = await listDashboardsPaginated(orgSlug, {
      perPage: API_MAX_PER_PAGE,
      cursor,
    }).catch(async (error: unknown) =>
      enrichDashboardError(error, { orgSlug, operation: "list" })
    );
    // Match by ID/slug first (e.g. "default-overview"), then fall back to title
    const match =
      data.find((d) => d.id.toLowerCase() === lowerRef) ??
      data.find((d) => (d.title ?? "").toLowerCase() === lowerRef);
    if (match) {
      return match.id;
    }

    for (const d of data) {
      const title = d.title ?? "(untitled)";
      allTitles.push(title);
      titleToId.set(title, d.id);
    }
    if (!nextCursor) {
      break;
    }
    cursor = nextCursor;
  }

  // No match — use fuzzy search for suggestions
  const similar = fuzzyMatch(ref, allTitles, { maxResults: 5 });
  const suggestions = similar
    .map((t) => `  ${titleToId.get(t)}  ${t}`)
    .join("\n");
  let hint: string;
  if (similar.length > 0) {
    hint = `\n\nDid you mean:\n${suggestions}`;
  } else if (allTitles.length > 0) {
    hint = `\n\nThe org has ${allTitles.length} dashboard(s) but none matched.`;
  } else {
    hint = "\n\nNo dashboards found in this organization.";
  }

  throw new ValidationError(
    `No dashboard with title '${ref}' found in '${orgSlug}'.${hint}`
  );
}

/**
 * Resolve widget index from --index or --title flags.
 *
 * @param widgets - Array of widgets in the dashboard
 * @param index - Explicit 0-based widget index
 * @param title - Widget title to match
 * @returns Resolved widget index
 */
export function resolveWidgetIndex(
  widgets: DashboardWidget[],
  index: number | undefined,
  title: string | undefined
): number {
  if (index !== undefined) {
    if (index < 0 || index >= widgets.length) {
      throw new ValidationError(
        `Widget index ${index} out of range (dashboard has ${widgets.length} widgets).`,
        "index"
      );
    }
    return index;
  }
  const lowerTitle = (title ?? "").toLowerCase();
  const matchIndex = widgets.findIndex(
    (w) => (w.title ?? "").toLowerCase() === lowerTitle
  );
  if (matchIndex === -1) {
    throw new ValidationError(
      `No widget with title '${title}' found in dashboard.`,
      "title"
    );
  }
  return matchIndex;
}

/**
 * Validate that a sort expression references an aggregate present in the query.
 * The Sentry API returns 400 when the sort field isn't in the widget's aggregates.
 *
 * @param orderby - Parsed sort expression (e.g., "-count()", "p90(span.duration)")
 * @param aggregates - Parsed aggregate expressions from the query
 */
export function validateSortReferencesAggregate(
  orderby: string,
  aggregates: string[]
): void {
  // Strip leading "-" for descending sorts
  const sortAgg = orderby.startsWith("-") ? orderby.slice(1) : orderby;
  if (!aggregates.includes(sortAgg)) {
    throw new ValidationError(
      `Sort expression "${orderby}" references "${sortAgg}" which is not in the query.\n\n` +
        "The --sort field must be one of the aggregate expressions in --query.\n" +
        `Current aggregates: ${aggregates.join(", ")}\n\n` +
        `Either add "${sortAgg}" to --query or sort by an existing aggregate.`,
      "sort"
    );
  }
}

/**
 * Default limit for grouped widgets.
 *
 * Matches the Sentry UI default for grouped widgets. The Sentry API rejects
 * grouped widgets without a limit, so the CLI transparently applies this
 * value when the user passes --group-by without --limit instead of erroring.
 */
export const DEFAULT_GROUP_BY_LIMIT = 5;

/**
 * Compute the limit to use for a grouped widget.
 *
 * Returns the provided limit when set. When the widget has group-by columns
 * and no limit, returns `DEFAULT_GROUP_BY_LIMIT` so the API accepts the
 * widget. Otherwise returns `undefined` (ungrouped widgets don't need a limit).
 *
 * Callers should `log.info` when the auto-default is applied so users
 * understand why their request accepted without an explicit limit.
 *
 * @param columns - Group-by columns (empty for ungrouped widgets)
 * @param limit - User-provided or existing limit (undefined/null if unset)
 * @returns Effective limit, or `undefined` when no limit is needed
 */
export function autoDefaultGroupLimit(
  columns: string[],
  limit: number | null | undefined
): number | undefined {
  if (limit !== undefined && limit !== null) {
    return limit;
  }
  if (columns.length > 0) {
    return DEFAULT_GROUP_BY_LIMIT;
  }
  return;
}

const log = logger.withTag("dashboard");

/**
 * Apply the group-by limit auto-default for a user-initiated --group-by.
 *
 * Only fires when the user explicitly passed --group-by (not for auto-defaulted
 * columns like the `["issue"]` default for issue-dataset tables — those widgets
 * work without a limit). Emits `log.info` when the auto-default takes effect so
 * users see why their command accepted without an explicit --limit.
 *
 * @param userGroupBy - The raw --group-by flag (undefined when not passed)
 * @param columns - Effective columns after any defaulting
 * @param limit - User-provided or existing limit (undefined/null if unset)
 * @returns Effective limit to use in the widget payload
 */
export function applyGroupLimitAutoDefault(
  userGroupBy: string[] | undefined,
  columns: string[],
  limit: number | null | undefined
): number | null | undefined {
  if (!userGroupBy || userGroupBy.length === 0) {
    return limit;
  }
  const effective = autoDefaultGroupLimit(columns, limit);
  if (effective !== limit && effective !== undefined) {
    log.info(
      `Auto-defaulting --limit to ${DEFAULT_GROUP_BY_LIMIT} for grouped widget. Pass --limit <n> to override.`
    );
    return effective;
  }
  return limit;
}

/**
 * Known aggregatable fields for the spans dataset.
 *
 * Span attributes (e.g., dsn.files_collected, resolve.method) are key-value
 * metadata and cannot be used as aggregate fields — only in --where or --group-by.
 * This set covers built-in numeric fields that support aggregation.
 * Measurements (http.*, cache.*, etc.) are project-specific and may not be
 * exhaustive — we warn instead of error for unknown fields.
 */
const KNOWN_SPAN_AGGREGATE_FIELDS = new Set([
  "span.duration",
  "span.self_time",
  "http.response_content_length",
  "http.decoded_response_content_length",
  "http.response_transfer_size",
  "cache.item_size",
]);

/**
 * Aggregate functions that require numeric measurement fields.
 * Functions like count_unique, any, count accept non-numeric columns
 * (e.g., transaction, span.op) and should not trigger the warning.
 */
const NUMERIC_AGGREGATE_FUNCTIONS = new Set([
  "avg",
  "sum",
  "min",
  "max",
  "p50",
  "p75",
  "p90",
  "p95",
  "p99",
  "p100",
  "percentile",
]);

/**
 * Warn when a numeric aggregate function (avg, sum, p50, etc.) is applied
 * to a field that isn't a known aggregatable span measurement. Functions
 * like count_unique(transaction) or any(span.op) accept non-numeric
 * columns and are not checked.
 *
 * Only checks for the spans dataset.
 */
function warnUnknownAggregateFields(
  aggregates: string[],
  dataset: string | undefined
): void {
  if (dataset && dataset !== "spans") {
    return;
  }
  for (const agg of aggregates) {
    const parenIdx = agg.indexOf("(");
    if (parenIdx < 0) {
      continue;
    }
    const fn = agg.slice(0, parenIdx);
    // Only check numeric aggregate functions — count_unique, any, etc. accept any column
    if (!NUMERIC_AGGREGATE_FUNCTIONS.has(fn)) {
      continue;
    }
    const inner = agg.slice(parenIdx + 1, -1);
    if (!inner) {
      continue;
    }
    if (!KNOWN_SPAN_AGGREGATE_FIELDS.has(inner)) {
      log.warn(
        `Aggregate field "${inner}" in "${agg}" is not a known aggregatable span field. ` +
          "Span attributes (custom tags) cannot be used with numeric aggregates — " +
          "use them in --where or --group-by instead. " +
          `Known numeric fields: ${[...KNOWN_SPAN_AGGREGATE_FIELDS].join(", ")}`
      );
    }
  }
}

/**
 * Build a widget from user-provided flag values.
 *
 * Shared between `dashboard widget add` and `dashboard widget edit`.
 * Parses aggregate shorthand, sort expressions, and validates via Zod schema.
 *
 * @param opts - Widget configuration from parsed flags
 * @returns Validated widget with computed query fields
 */
export function buildWidgetFromFlags(opts: {
  title: string;
  display: string;
  dataset?: string;
  query?: string[];
  where?: string;
  groupBy?: string[];
  sort?: string;
  limit?: number;
}): DashboardWidget {
  const aggregates = (opts.query ?? ["count"]).map(parseAggregate);
  validateAggregateNames(aggregates, opts.dataset);
  warnUnknownAggregateFields(aggregates, opts.dataset);

  // Issue table widgets need at least one column or the Sentry UI shows "Columns: None".
  // Default to ["issue"] for table display only — timeseries (line/area/bar) don't use columns.
  const columns =
    opts.groupBy ??
    (opts.dataset === "issue" && opts.display === "table" ? ["issue"] : []);
  // Auto-default orderby to first aggregate descending when group-by is used.
  // Without this, chart widgets (line/area/bar) with group-by + limit error
  // because the dashboard can't determine which top N groups to display.
  let orderby = opts.sort ? parseSortExpression(opts.sort) : undefined;
  if (columns.length > 0 && !orderby && aggregates.length > 0) {
    orderby = `-${aggregates[0]}`;
  }

  const limit = applyGroupLimitAutoDefault(opts.groupBy, columns, opts.limit);

  if (orderby) {
    validateSortReferencesAggregate(orderby, aggregates);
  }

  const raw = {
    title: opts.title,
    displayType: opts.display,
    ...(opts.dataset && { widgetType: opts.dataset }),
    queries: [
      {
        aggregates,
        columns,
        conditions: opts.where ?? "",
        ...(orderby && { orderby }),
        name: "",
      },
    ],
    ...(limit !== undefined && { limit }),
  };
  return prepareWidgetQueries(parseWidgetInput(raw));
}

/** Context for enriching dashboard API errors with actionable messages */
export type DashboardErrorContext = {
  /** Organization slug (when known) */
  orgSlug?: string;
  /** Dashboard ID (when known) */
  dashboardId?: string;
  /** The operation being performed, for error messages */
  operation: "list" | "view" | "create" | "update";
};

/** Maximum number of dashboard suggestions to show in 404 errors */
const MAX_404_SUGGESTIONS = 5;

/**
 * Build an enriched error for a 404 response on a dashboard API call.
 *
 * When a numeric dashboard ID is not found, fetches available dashboards
 * from the org and includes up to {@link MAX_404_SUGGESTIONS} as suggestions
 * so the user (or AI agent) can see what's actually available.
 */
async function build404Error(
  ctx: DashboardErrorContext,
  org: string
): Promise<never> {
  if (ctx.operation === "list") {
    throw new ResolutionError(
      `Organization ${org}`,
      "not found or has no dashboards",
      "sentry dashboard list <org>/",
      [
        "Verify the organization slug with: sentry org list",
        "Check that you have access to the organization",
      ]
    );
  }
  const listHint = `sentry dashboard list ${ctx.orgSlug ?? "<org>"}/`;
  if (ctx.dashboardId) {
    // Fetch available dashboards to suggest alternatives
    const alternatives = [
      "The dashboard may have been deleted",
      "Check the dashboard ID or title with: sentry dashboard list",
    ];
    if (ctx.orgSlug) {
      try {
        const { data } = await listDashboardsPaginated(ctx.orgSlug, {
          perPage: MAX_404_SUGGESTIONS,
        });
        if (data.length > 0) {
          const lines = data.map(
            (d) => `    ${d.id}  ${d.title ?? "(untitled)"}`
          );
          alternatives.push(`Available dashboards:\n${lines.join("\n")}`);
        }
      } catch (error) {
        log.debug("Suggestion fetch failed for 404 alternatives", error);
      }
    }
    throw new ResolutionError(
      `Dashboard ${ctx.dashboardId} in ${org}`,
      "not found",
      listHint,
      alternatives
    );
  }
  // Generic 404 for create or other operations
  throw new ResolutionError(
    `Organization ${org}`,
    "not found",
    "sentry org list",
    ["Verify the organization slug and your access"]
  );
}

/** Build an enriched error for a 403 response on a dashboard API call */
function build403Error(
  ctx: DashboardErrorContext,
  org: string,
  detail: string | undefined
): never {
  const message = detail ?? "You do not have permission.";
  if (ctx.dashboardId) {
    throw new ResolutionError(
      `Dashboard ${ctx.dashboardId} in ${org}`,
      "access denied",
      `sentry dashboard list ${ctx.orgSlug ?? "<org>"}/`,
      [message, "Check your organization membership and role"]
    );
  }
  throw new ResolutionError(
    `Dashboards in ${org}`,
    "access denied",
    "sentry org list",
    [message, "Check your organization membership and role"]
  );
}

/**
 * Enrich an API error from a dashboard command with actionable suggestions.
 *
 * Catches 404, 403, and 400 errors and converts them to `ResolutionError`
 * or enriched `ApiError` instances with hints about what to try next.
 * Re-throws non-`ApiError` and unhandled statuses unchanged.
 *
 * @param error - The caught error
 * @param ctx - Context about the operation for building error messages
 */
export async function enrichDashboardError(
  error: unknown,
  ctx: DashboardErrorContext
): Promise<never> {
  if (!(error instanceof ApiError)) {
    throw error;
  }

  const org = ctx.orgSlug ? `'${ctx.orgSlug}'` : "this organization";

  if (error.status === 404) {
    // Awaited explicitly so the linter doesn't flag a missing `await` in this
    // async function, and so a future non-throwing codepath in build404Error
    // wouldn't silently fall through.
    return await build404Error(ctx, org);
  }

  if (error.status === 403) {
    // Centralized 403 enrichment (infrastructure.ts) already added
    // scope/token hints. Re-throw the enriched ApiError directly —
    // passing the multi-line enriched detail into build403Error would
    // nest it as a single messy bullet in a ResolutionError.
    if (error.enriched403) {
      throw error;
    }
    return build403Error(ctx, org, error.detail);
  }

  // 400 on create/update — preserve API detail (plan limits, invalid config)
  if (
    error.status === 400 &&
    (ctx.operation === "create" || ctx.operation === "update")
  ) {
    throw new ApiError(
      `Dashboard ${ctx.operation} failed in ${org}`,
      error.status,
      error.detail ??
        "The API rejected the request. Check widget configuration.",
      error.endpoint
    );
  }

  throw error;
}

/**
 * User-facing dataset synonyms resolved to the canonical Sentry widget type.
 *
 * The Sentry API/UI and docs surface names like `errors` but widget types
 * use `error-events`. The CLI accepts both forms so users copying from
 * docs or using API-dataset terminology don't have to translate.
 *
 * Keys are lowercase; matching is case-insensitive via {@link normalizeDataset}.
 */
const DATASET_ALIASES: Record<string, string> = {
  error: "error-events",
  errors: "error-events",
  log: "logs",
  // `metrics` and `metricsEnhanced` both alias to the canonical `tracemetrics`.
  // `metricsEnhanced` is a legacy API synonym and may appear in older docs.
  metrics: "tracemetrics",
  metricsenhanced: "tracemetrics",
};

/**
 * Normalize a user-provided `--dataset` value to the canonical widget type.
 *
 * - Case-insensitive (e.g. `Errors`, `ERRORS` → `error-events`).
 * - Maps known synonyms via {@link DATASET_ALIASES}.
 * - Returns the lower-cased input unchanged if no alias matches (the enum
 *   check in {@link validateWidgetEnums} will reject unknown values).
 * - Returns `undefined` for `undefined` input.
 *
 * Must be called once, up-front, and the result threaded through every
 * downstream consumer (aggregate validator, warnings, PUT body). Leaving
 * an un-normalized value in `flags.dataset` causes dataset-specific
 * aggregate validation (e.g. `count_if` for `error-events`) to see
 * the alias instead of the canonical name and reject valid inputs.
 */
export function normalizeDataset(dataset?: string): string | undefined {
  if (dataset === undefined) {
    return;
  }
  const lower = dataset.toLowerCase();
  return DATASET_ALIASES[lower] ?? lower;
}

/**
 * Validate --display and --dataset flag values against known enums.
 *
 * Callers MUST pass a dataset value already normalized via
 * {@link normalizeDataset} so aliases and casing don't leak into the
 * enum check. This function does not mutate or resolve aliases itself —
 * it is a pure validator.
 *
 * @param display - Display type flag value
 * @param dataset - Dataset flag value (already normalized)
 */
export function validateWidgetEnums(display?: string, dataset?: string): void {
  if (
    display &&
    !DISPLAY_TYPES.includes(display as (typeof DISPLAY_TYPES)[number])
  ) {
    throw new ValidationError(
      `Invalid --display value "${display}".\nValid display types: ${DISPLAY_TYPES.join(", ")}`,
      "display"
    );
  }
  if (
    dataset &&
    !WIDGET_TYPES.includes(dataset as (typeof WIDGET_TYPES)[number])
  ) {
    throw new ValidationError(
      `Invalid --dataset value "${dataset}".\nValid datasets: ${WIDGET_TYPES.join(", ")}`,
      "dataset"
    );
  }
  // The Sentry backend validates displayType and widgetType as independent enums —
  // any valid display type is accepted with any valid dataset. No cross-validation needed.
}
