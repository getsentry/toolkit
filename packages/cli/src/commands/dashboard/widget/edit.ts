/**
 * sentry dashboard widget edit
 *
 * Edit a widget in an existing dashboard using inline flags.
 */

import type { SentryContext } from "../../../context.js";
import { getDashboard, updateDashboard } from "../../../lib/api-client.js";
import { parseOrgProjectArg } from "../../../lib/arg-parsing.js";
import { buildCommand, numberParser } from "../../../lib/command.js";
import { ValidationError } from "../../../lib/errors.js";
import { formatWidgetEdited } from "../../../lib/formatters/human.js";
import { CommandOutput } from "../../../lib/formatters/output.js";
import { buildDashboardUrl } from "../../../lib/sentry-urls.js";
import {
  type DashboardDetail,
  type DashboardWidget,
  type DashboardWidgetQuery,
  FALLBACK_LAYOUT,
  parseAggregate,
  parseSortExpression,
  parseWidgetInput,
  prepareDashboardForUpdate,
  prepareWidgetQueries,
  validateAggregateNames,
  validateWidgetLayout,
  type WidgetLayoutFlags,
} from "../../../types/dashboard.js";
import {
  applyGroupLimitAutoDefault,
  enrichDashboardError,
  normalizeDataset,
  parseDashboardPositionalArgs,
  resolveDashboardId,
  resolveOrgFromTarget,
  resolveWidgetIndex,
  validateSortReferencesAggregate,
  validateWidgetEnums,
  type WidgetQueryFlags,
} from "../resolve.js";

type EditFlags = WidgetQueryFlags &
  WidgetLayoutFlags & {
    readonly index?: number;
    readonly title?: string;
    readonly "new-title"?: string;
    readonly json: boolean;
    readonly fields?: string[];
  };

type EditResult = {
  dashboard: DashboardDetail;
  widget: DashboardWidget;
  url: string;
};

/** Merge query-level flags over existing widget query */
function mergeQueries(
  flags: EditFlags,
  existingQuery: DashboardWidgetQuery | undefined
): DashboardWidgetQuery[] | undefined {
  const hasChanges =
    flags.query || flags.where !== undefined || flags["group-by"] || flags.sort;

  if (!hasChanges) {
    return; // signal: keep existing
  }

  // Destructure to omit stale `fields` — prepareWidgetQueries will
  // recompute it from the updated aggregates/columns.
  const { fields: _staleFields, ...base } = existingQuery ?? {};
  return [
    {
      ...base,
      ...(flags.query && { aggregates: flags.query.map(parseAggregate) }),
      ...(flags.where !== undefined && { conditions: flags.where }),
      ...(flags["group-by"] && { columns: flags["group-by"] }),
      ...(flags.sort && { orderby: parseSortExpression(flags.sort) }),
    },
  ];
}

/** Merge layout flags over existing layout, returning the result or the existing layout unchanged */
function mergeLayout(
  flags: WidgetLayoutFlags,
  existing: DashboardWidget
): DashboardWidget["layout"] {
  const hasChange =
    flags.col !== undefined ||
    flags.row !== undefined ||
    flags.width !== undefined ||
    flags.height !== undefined;

  if (!hasChange) {
    return existing.layout;
  }

  return {
    ...(existing.layout ?? FALLBACK_LAYOUT),
    ...(flags.col !== undefined && { x: flags.col }),
    ...(flags.row !== undefined && { y: flags.row }),
    ...(flags.width !== undefined && { w: flags.width }),
    ...(flags.height !== undefined && { h: flags.height }),
  };
}

/**
 * Validate enum and aggregate constraints on the effective (merged) widget state.
 * Extracted from buildReplacement to stay under Biome's complexity limit.
 */
function validateEnumsAndAggregates(
  flags: EditFlags,
  existing: DashboardWidget,
  mergedQueries: DashboardWidgetQuery[] | undefined
): void {
  const newDataset = flags.dataset ?? existing.widgetType;
  const aggregatesToValidate =
    mergedQueries?.[0]?.aggregates ?? existing.queries?.[0]?.aggregates;
  if ((flags.query || flags.dataset) && aggregatesToValidate) {
    validateAggregateNames(aggregatesToValidate, newDataset);
  }

  if (flags.display || flags.dataset) {
    const effectiveDisplay = flags.display ?? existing.displayType;
    const effectiveDataset = flags.dataset ?? existing.widgetType;
    validateWidgetEnums(effectiveDisplay, effectiveDataset);
  }
}

/**
 * Validate sort constraints on the effective (merged) widget state.
 *
 * Only runs when the user explicitly passes --sort — not when merely changing
 * --query (which may leave the existing auto-defaulted sort stale), and not
 * when preserving existing widget state which may predate these validations.
 */
function validateQueryConstraints(
  flags: EditFlags,
  existing: DashboardWidget,
  mergedQueries: DashboardWidgetQuery[] | undefined
): void {
  if (!flags.sort) {
    return;
  }
  const orderby = mergedQueries?.[0]?.orderby ?? existing.queries?.[0]?.orderby;
  const aggregates =
    mergedQueries?.[0]?.aggregates ?? existing.queries?.[0]?.aggregates ?? [];
  if (orderby && aggregates.length > 0) {
    validateSortReferencesAggregate(orderby, aggregates);
  }
}

/** Build the replacement widget object by merging flags over existing */
function buildReplacement(
  flags: EditFlags,
  existing: DashboardWidget
): DashboardWidget {
  const mergedQueries = mergeQueries(flags, existing.queries?.[0]);
  const baseLimit = flags.limit !== undefined ? flags.limit : existing.limit;
  const columns =
    mergedQueries?.[0]?.columns ?? existing.queries?.[0]?.columns ?? [];
  const limit = applyGroupLimitAutoDefault(
    flags["group-by"],
    columns,
    baseLimit
  );

  validateEnumsAndAggregates(flags, existing, mergedQueries);
  validateQueryConstraints(flags, existing, mergedQueries);

  const raw: Record<string, unknown> = {
    title: flags["new-title"] ?? existing.title,
    displayType: flags.display ?? existing.displayType,
    queries: mergedQueries ?? existing.queries,
    layout: mergeLayout(flags, existing),
  };
  // Only set widgetType if explicitly provided via --dataset or already on the widget.
  // Avoids parseWidgetInput defaulting to "spans" for widgets without a widgetType.
  if (flags.dataset) {
    raw.widgetType = flags.dataset;
  } else if (existing.widgetType) {
    raw.widgetType = existing.widgetType;
  }
  if (limit !== undefined && limit !== null) {
    raw.limit = limit;
  }

  return prepareWidgetQueries(parseWidgetInput(raw));
}

export const editCommand = buildCommand({
  docs: {
    brief: "Edit a widget in a dashboard",
    fullDescription:
      "Edit a widget in an existing Sentry dashboard.\n\n" +
      "The dashboard can be specified by numeric ID or title.\n" +
      "Identify the widget by --index (0-based) or --title.\n" +
      "Only provided flags are changed — omitted values are preserved.\n\n" +
      "Layout flags (--col/-x, --row/-y, --width, --height) control widget position\n" +
      "and size in the 6-column dashboard grid.\n\n" +
      "Examples:\n" +
      "  sentry dashboard widget edit 12345 --title 'Error Rate' --display bar\n" +
      "  sentry dashboard widget edit 'My Dashboard' --index 0 --query p95:span.duration\n" +
      "  sentry dashboard widget edit 12345 --title 'Old Name' --new-title 'New Name'\n" +
      "  sentry dashboard widget edit 12345 --index 0 --col 0 --row 0 --width 6 --height 2",
  },
  output: {
    human: formatWidgetEdited,
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        placeholder: "org/project/dashboard",
        brief: "[<org/project>] <dashboard-id-or-title>",
        parse: String,
      },
    },
    flags: {
      index: {
        kind: "parsed",
        parse: numberParser,
        brief: "Widget index (0-based)",
        optional: true,
      },
      title: {
        kind: "parsed",
        parse: String,
        brief: "Widget title to match",
        optional: true,
      },
      "new-title": {
        kind: "parsed",
        parse: String,
        brief: "New widget title",
        optional: true,
      },
      display: {
        kind: "parsed",
        parse: String,
        brief:
          "Display type (big_number, line, area, bar, table, stacked_area, top_n, text, categorical_bar, details, wheel, rage_and_dead_clicks, server_tree, agents_traces_table)",
        optional: true,
      },
      dataset: {
        kind: "parsed",
        parse: String,
        brief:
          "Widget dataset (default: spans). Accepts canonical names and API synonyms: spans, error-events/errors, tracemetrics/metrics, logs, issue",
        optional: true,
      },
      query: {
        kind: "parsed",
        parse: String,
        brief: "Aggregate expression (e.g. count, p95:span.duration)",
        variadic: true,
        optional: true,
      },
      where: {
        kind: "parsed",
        parse: String,
        brief: "Search conditions filter (e.g. is:unresolved)",
        optional: true,
      },
      "group-by": {
        kind: "parsed",
        parse: String,
        brief: "Group-by column (repeatable)",
        variadic: true,
        optional: true,
      },
      sort: {
        kind: "parsed",
        parse: String,
        brief: "Order by (prefix - for desc, e.g. -count)",
        optional: true,
      },
      limit: {
        kind: "parsed",
        parse: numberParser,
        brief: "Result limit",
        optional: true,
      },
      col: {
        kind: "parsed",
        parse: numberParser,
        brief: "Grid column position (0-based, 0–5)",
        optional: true,
      },
      row: {
        kind: "parsed",
        parse: numberParser,
        brief: "Grid row position (0-based)",
        optional: true,
      },
      width: {
        kind: "parsed",
        parse: numberParser,
        brief: "Widget width in grid columns (1–6)",
        optional: true,
      },
      height: {
        kind: "parsed",
        parse: numberParser,
        brief: "Widget height in grid rows (min 1)",
        optional: true,
      },
    },
    aliases: {
      i: "index",
      t: "title",
      d: "display",
      q: "query",
      w: "where",
      g: "group-by",
      s: "sort",
      n: "limit",
      x: "col",
      y: "row",
    },
  },
  async *func(this: SentryContext, flags: EditFlags, ...args: string[]) {
    const { cwd } = this;

    if (flags.index === undefined && !flags.title) {
      throw new ValidationError(
        "Specify --index or --title to identify the widget to edit.\n\n" +
          "Example:\n" +
          "  sentry dashboard widget edit <dashboard> --title 'My Widget' --display bar",
        "index"
      );
    }

    // Resolve dataset aliases (e.g. "errors" → "error-events") once, up front.
    // Replace flags.dataset with the canonical value so every downstream
    // consumer — validateEnumsAndAggregates, validateAggregateNames, and the
    // PUT body — sees the normalized name. Without this, dataset-aware
    // aggregate validation (e.g. count_if for error-events) would fail
    // when the user passes --dataset errors.
    const normalizedDataset = normalizeDataset(flags.dataset);
    const normalizedFlags: EditFlags =
      normalizedDataset === flags.dataset
        ? flags
        : { ...flags, dataset: normalizedDataset };

    validateWidgetEnums(normalizedFlags.display, normalizedFlags.dataset);

    const { dashboardRef, targetArg } = parseDashboardPositionalArgs(args);
    const parsed = parseOrgProjectArg(targetArg);
    const orgSlug = await resolveOrgFromTarget(
      parsed,
      cwd,
      "sentry dashboard widget edit <org>/ <dashboard> --title <name> --display <type>"
    );
    const dashboardId = await resolveDashboardId(orgSlug, dashboardRef);

    // GET current dashboard → find widget → merge changes → PUT
    const current = await getDashboard(orgSlug, dashboardId).catch(
      async (error: unknown) =>
        enrichDashboardError(error, { orgSlug, dashboardId, operation: "view" })
    );
    const widgets = current.widgets ?? [];
    const widgetIndex = resolveWidgetIndex(
      widgets,
      normalizedFlags.index,
      normalizedFlags.title
    );

    const updateBody = prepareDashboardForUpdate(current);
    const existing = updateBody.widgets[widgetIndex] as DashboardWidget;

    // Validate individual layout flag ranges early (catches --col -1, --width 7, etc.)
    validateWidgetLayout(normalizedFlags, existing.layout);

    const replacement = buildReplacement(normalizedFlags, existing);

    // Re-validate the final merged layout when the existing widget had no layout
    // and FALLBACK_LAYOUT was used — the early check couldn't cross-validate
    // because the fallback dimensions weren't known yet.
    if (replacement.layout && !existing.layout) {
      validateWidgetLayout(
        { col: replacement.layout.x, width: replacement.layout.w },
        replacement.layout
      );
    }

    updateBody.widgets[widgetIndex] = replacement;

    const updated = await updateDashboard(
      orgSlug,
      dashboardId,
      updateBody
    ).catch(async (error: unknown) =>
      enrichDashboardError(error, {
        orgSlug,
        dashboardId,
        operation: "update",
      })
    );
    const url = buildDashboardUrl(orgSlug, dashboardId);

    yield new CommandOutput({
      dashboard: updated,
      widget: replacement,
      url,
    } as EditResult);
    return { hint: `Dashboard: ${url}` };
  },
});
