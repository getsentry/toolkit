/**
 * Dashboard types and schemas
 *
 * Valibot schemas and TypeScript types for Sentry Dashboard API responses.
 * Includes utility functions for stripping server-generated fields
 * before PUT requests, and strict input validation for user-authored widgets.
 */

import {
  array,
  boolean,
  getDotPath,
  type InferOutput,
  looseObject,
  nullable,
  nullish,
  number,
  object,
  optional,
  picklist,
  record,
  safeParse,
  string,
  tuple,
  union,
  unknown,
} from "valibot";

import { ValidationError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Widget type and display type enums
//
// Source: sentry/src/sentry/models/dashboard_widget.py
// Also in: @sentry/api types (cli/node_modules/@sentry/api/dist/types.gen.d.ts)
// ---------------------------------------------------------------------------

/**
 * Valid widget types (dataset selectors).
 *
 * Source: sentry/src/sentry/models/dashboard_widget.py DashboardWidgetTypes.TYPES
 */
export const WIDGET_TYPES = [
  "issue",
  "error-events",
  "spans",
  "logs",
  "tracemetrics",
  "preprod-app-size",
] as const;

export type WidgetType = (typeof WIDGET_TYPES)[number];

/** Default widgetType — the modern spans dataset covers most use cases */
export const DEFAULT_WIDGET_TYPE: WidgetType = "spans";

/**
 * Valid widget display types (visualization formats).
 *
 * Source: sentry/src/sentry/models/dashboard_widget.py DashboardWidgetDisplayTypes.TYPES
 */
export const DISPLAY_TYPES = [
  "line",
  "area",
  "stacked_area",
  "bar",
  "table",
  "big_number",
  "top_n",
  "details",
  "categorical_bar",
  "heatmap",
  "wheel",
  "rage_and_dead_clicks",
  "server_tree",
  "text",
  "agents_traces_table",
] as const;

export type DisplayType = (typeof DISPLAY_TYPES)[number];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Schema for a single query within a dashboard widget */
export const DashboardWidgetQuerySchema = looseObject({
  id: optional(string()),
  name: optional(string()),
  conditions: optional(string()),
  columns: optional(array(string())),
  aggregates: optional(array(string())),
  fieldAliases: optional(array(string())),
  orderby: optional(string()),
  fields: optional(array(string())),
  widgetId: optional(string()),
  dateCreated: optional(string()),
});

/** Schema for widget layout position */
export const DashboardWidgetLayoutSchema = looseObject({
  x: number(),
  y: number(),
  w: number(),
  h: number(),
  minH: optional(number()),
  isResizable: optional(boolean()),
});

/** Schema for a single dashboard widget */
export const DashboardWidgetSchema = looseObject({
  id: optional(string()),
  title: string(),
  displayType: string(),
  widgetType: optional(string()),
  interval: optional(string()),
  queries: optional(array(DashboardWidgetQuerySchema)),
  layout: optional(DashboardWidgetLayoutSchema),
  thresholds: optional(unknown()),
  limit: optional(nullable(number())),
  dashboardId: optional(string()),
  dateCreated: optional(string()),
});

/** Schema for dashboard list items (lightweight, from GET /dashboards/) */
export const DashboardListItemSchema = looseObject({
  id: string(),
  title: string(),
  dateCreated: optional(string()),
  createdBy: optional(
    object({
      name: optional(string()),
      email: optional(string()),
    })
  ),
  widgetDisplay: optional(array(string())),
});

/** Schema for full dashboard detail (from GET /dashboards/{id}/) */
export const DashboardDetailSchema = looseObject({
  id: string(),
  title: string(),
  widgets: optional(array(DashboardWidgetSchema)),
  dateCreated: optional(string()),
  createdBy: optional(
    object({
      name: optional(string()),
      email: optional(string()),
    })
  ),
  projects: optional(array(number())),
  environment: optional(array(string())),
  period: optional(nullable(string())),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DashboardWidgetQuery = InferOutput<
  typeof DashboardWidgetQuerySchema
>;
export type DashboardWidgetLayout = InferOutput<
  typeof DashboardWidgetLayoutSchema
>;
export type DashboardWidget = InferOutput<typeof DashboardWidgetSchema>;
export type DashboardListItem = InferOutput<typeof DashboardListItemSchema>;
export type DashboardDetail = InferOutput<typeof DashboardDetailSchema>;

// ---------------------------------------------------------------------------
// Strict input schema for user-authored widgets
// ---------------------------------------------------------------------------

/**
 * Strict schema for user-authored widget JSON (create/add/edit input).
 * Validates displayType and widgetType against known Sentry enums.
 * Defaults widgetType to "spans" when not provided.
 *
 * Use DashboardWidgetSchema (permissive) for parsing server responses.
 */
export const DashboardWidgetInputSchema = looseObject({
  title: string(),
  displayType: picklist(DISPLAY_TYPES),
  widgetType: optional(picklist(WIDGET_TYPES), DEFAULT_WIDGET_TYPE),
  interval: optional(string()),
  queries: optional(array(DashboardWidgetQuerySchema)),
  layout: optional(DashboardWidgetLayoutSchema),
  thresholds: optional(unknown()),
  limit: optional(nullable(number())),
});

/**
 * Parse and validate user-authored widget JSON with strict enum checks.
 * Throws ValidationError with actionable messages listing valid values.
 *
 * @param raw - Raw parsed JSON from user's widget file
 * @returns Validated widget with widgetType defaulted to "spans" if omitted
 */
export function parseWidgetInput(raw: unknown): DashboardWidget {
  const result = safeParse(DashboardWidgetInputSchema, raw);
  if (result.success) {
    return result.output;
  }

  const issues = result.issues.map((issue) => {
    const path = getDotPath(issue) ?? "";
    if (path.includes("displayType")) {
      return `Invalid displayType. Valid values: ${DISPLAY_TYPES.join(", ")}`;
    }
    if (path.includes("widgetType")) {
      return `Invalid widgetType. Valid values: ${WIDGET_TYPES.join(", ")}`;
    }
    return `${path}: ${issue.message}`;
  });
  throw new ValidationError(
    `Invalid widget definition:\n${issues.join("\n")}`,
    "widget-json"
  );
}

// ---------------------------------------------------------------------------
// Aggregate functions & search filter enums
// ---------------------------------------------------------------------------

/**
 * Aggregate function aliases resolved before validation.
 *
 * The Sentry events API silently resolves these, but the dashboard widget UI
 * only understands canonical function names from AggregationKey. Resolving
 * aliases here ensures widgets render correctly in the UI.
 *
 * Source: https://github.com/getsentry/sentry/blob/master/src/sentry/search/events/constants.py
 *   SPAN_FUNCTION_ALIASES: spm→epm, sps→eps
 *   FUNCTION_ALIASES: tpm→epm, tps→eps
 */
export const AGGREGATE_ALIASES: Record<string, string> = {
  spm: "epm",
  sps: "eps",
  tpm: "epm",
  tps: "eps",
};

/**
 * Canonical aggregate functions for the spans dataset (default for dashboard widgets).
 * These are the function names the dashboard UI can render in the "Visualize" dropdown.
 *
 * Source: https://github.com/getsentry/sentry/blob/master/src/sentry/search/events/constants.py
 * Dataset: https://github.com/getsentry/sentry/blob/master/src/sentry/search/events/datasets/spans_indexed.py
 */
export const SPAN_AGGREGATE_FUNCTIONS = [
  "count",
  "count_unique",
  "sum",
  "avg",
  "percentile",
  "p50",
  "p75",
  "p90",
  "p95",
  "p99",
  "p100",
  "eps",
  "epm",
  "any",
  "min",
  "max",
] as const;

export type SpanAggregateFunction = (typeof SPAN_AGGREGATE_FUNCTIONS)[number];

/**
 * Additional aggregate functions for the error-events dataset.
 * Available when widgetType is "error-events".
 *
 * Source: https://github.com/getsentry/sentry/blob/master/src/sentry/search/events/constants.py
 */
export const ERROR_AGGREGATE_FUNCTIONS = [
  ...SPAN_AGGREGATE_FUNCTIONS,
  "count_if",
  "count_at_least",
  "last_seen",
  "latest_event",
  "var",
  "stddev",
  "cov",
  "corr",
] as const;

export type ErrorAggregateFunction = (typeof ERROR_AGGREGATE_FUNCTIONS)[number];

/** Valibot schema for validating a span aggregate function name */
export const SpanAggregateFunctionSchema = picklist(SPAN_AGGREGATE_FUNCTIONS);

/** Valibot schema for validating an error-event aggregate function name */
export const ErrorAggregateFunctionSchema = picklist(ERROR_AGGREGATE_FUNCTIONS);

/**
 * Valid `is:` filter values for issue search conditions (--where flag).
 * Only valid when widgetType is "issue". Other datasets don't support `is:`.
 *
 * Status values from GroupStatus:
 * https://github.com/getsentry/sentry/blob/master/src/sentry/models/group.py#L196-L204
 *
 * Substatus values from SUBSTATUS_UPDATE_CHOICES:
 * https://github.com/getsentry/sentry/blob/master/src/sentry/types/group.py#L33-L41
 *
 * Assignment/link filters from is_filter_translation:
 * https://github.com/getsentry/sentry/blob/master/src/sentry/issues/issue_search.py#L45-L51
 */
export const IS_FILTER_VALUES = [
  // Status (GroupStatus)
  "resolved",
  "unresolved",
  "ignored",
  "archived",
  "muted",
  "reprocessing",
  // Substatus (GroupSubStatus)
  "escalating",
  "ongoing",
  "regressed",
  "new",
  "archived_until_escalating",
  "archived_until_condition_met",
  "archived_forever",
  // Assignment & linking
  "assigned",
  "unassigned",
  "for_review",
  "linked",
  "unlinked",
] as const;

export type IsFilterValue = (typeof IS_FILTER_VALUES)[number];

/** Valibot schema for validating an `is:` filter value */
export const IsFilterValueSchema = picklist(IS_FILTER_VALUES);

// ---------------------------------------------------------------------------
// Aggregate & sort parsing (quote-free CLI shorthand)
// ---------------------------------------------------------------------------

/**
 * Parse a shorthand aggregate expression into Sentry query syntax.
 * Resolves aliases (spm→epm, tpm→epm, etc.) so widgets render in the dashboard UI.
 *
 * Accepts three formats:
 *   "count"              → "count()"
 *   "p95:span.duration"  → "p95(span.duration)"
 *   "count()"            → "count()"  (passthrough if already has parens)
 *   "spm"                → "epm()"    (alias resolved)
 */
export function parseAggregate(input: string): string {
  if (input.includes("(")) {
    // Resolve aliases even in paren form: spm() → epm(), tpm(x) → epm(x)
    const parenIdx = input.indexOf("(");
    const fn = input.slice(0, parenIdx);
    const alias = AGGREGATE_ALIASES[fn];
    return alias ? `${alias}${input.slice(parenIdx)}` : input;
  }
  const colonIdx = input.indexOf(":");
  if (colonIdx > 0) {
    const fn = input.slice(0, colonIdx);
    const resolved = AGGREGATE_ALIASES[fn] ?? fn;
    return `${resolved}(${input.slice(colonIdx + 1)})`;
  }
  const resolved = AGGREGATE_ALIASES[input] ?? input;
  return `${resolved}()`;
}

/**
 * Extract the function name from a parsed aggregate string.
 *   "count()"              → "count"
 *   "p95(span.duration)"   → "p95"
 */
function extractFunctionName(aggregate: string): string {
  const parenIdx = aggregate.indexOf("(");
  return parenIdx > 0 ? aggregate.slice(0, parenIdx) : aggregate;
}

/**
 * Check whether a parsed aggregate uses the tracemetrics comma-separated format.
 * Format: `aggregation(value,metric_name,metric_type,unit)`
 * Example: `p50(value,completion.duration_ms,distribution,none)`
 */
function isTracemetricsAggregate(aggregate: string): boolean {
  // equation| prefix denotes a formula combining multiple tracemetrics aggregates
  if (aggregate.startsWith("equation|")) {
    return true;
  }
  const parenIdx = aggregate.indexOf("(");
  if (parenIdx < 0) {
    return false;
  }
  const inner = aggregate.slice(parenIdx + 1, -1);
  return inner.startsWith("value,") && inner.split(",").length === 4;
}

/**
 * Validate that all aggregate function names in a list are known.
 * Throws a ValidationError listing valid functions if any are invalid.
 *
 * For the `tracemetrics` dataset, aggregates must use the comma-separated
 * format: `aggregation(value,metric_name,metric_type,unit)`. Standard
 * span-style aggregates like `count()` or `p50(span.duration)` are
 * invalid for tracemetrics.
 *
 * @param aggregates - Parsed aggregate strings (e.g. ["count()", "p95(span.duration)"])
 * @param dataset - Widget dataset, determines which function list to validate against
 */
export function validateAggregateNames(
  aggregates: string[],
  dataset?: string
): void {
  // tracemetrics uses a different aggregate format — validate structure, not function names
  if (dataset === "tracemetrics") {
    for (const agg of aggregates) {
      if (!isTracemetricsAggregate(agg)) {
        throw new ValidationError(
          `Invalid tracemetrics aggregate "${agg}".\n\n` +
            "tracemetrics queries must use the format: aggregation(value,metric_name,metric_type,unit)\n" +
            "Example: p50(value,completion.duration_ms,distribution,none)\n\n" +
            "Parameters:\n" +
            "  - aggregation: avg, sum, count, p50, p75, p90, p95, p99, min, max\n" +
            `  - value: literal string "value"\n` +
            "  - metric_name: the name passed to Sentry.metrics.distribution/gauge/count\n" +
            "  - metric_type: distribution, gauge, counter, set\n" +
            "  - unit: none, byte, second, millisecond, etc. (must match SDK emission)",
          "query"
        );
      }
    }
    return;
  }

  const validFunctions: readonly string[] =
    dataset === "error-events"
      ? ERROR_AGGREGATE_FUNCTIONS
      : SPAN_AGGREGATE_FUNCTIONS;

  for (const agg of aggregates) {
    const fn = extractFunctionName(agg);
    if (!validFunctions.includes(fn)) {
      const aliasList = Object.entries(AGGREGATE_ALIASES)
        .map(([from, to]) => `${from}→${to}`)
        .join(", ");
      throw new ValidationError(
        `Unknown aggregate function "${fn}".\n\n` +
          `Valid functions: ${validFunctions.join(", ")}\n` +
          `Aliases (auto-resolved): ${aliasList}`,
        "query"
      );
    }
  }
}

/**
 * Parse a sort expression with optional `-` prefix for descending.
 * Uses the same shorthand as {@link parseAggregate}.
 *   "-count"             → "-count()"
 *   "p95:span.duration"  → "p95(span.duration)"
 *   "-p95:span.duration" → "-p95(span.duration)"
 */
export function parseSortExpression(input: string): string {
  if (input.startsWith("-")) {
    return `-${parseAggregate(input.slice(1))}`;
  }
  return parseAggregate(input);
}

// ---------------------------------------------------------------------------
// Query preparation for Sentry API
// ---------------------------------------------------------------------------

/** Maximum result limits by display type */
const MAX_LIMITS: Partial<Record<string, number>> = {
  table: 10,
  bar: 10,
};

/**
 * Prepare widget queries for the Sentry API.
 * Auto-computes `fields` from columns + aggregates.
 * Defaults `conditions` to "" when missing.
 * Clamps per-display-type limits to their maximums with a warning.
 */
export function prepareWidgetQueries(
  inputWidget: DashboardWidget
): DashboardWidget {
  let widget = inputWidget;
  // Clamp to per-display-type limit maximums
  const maxLimit = MAX_LIMITS[widget.displayType];
  if (
    maxLimit !== undefined &&
    widget.limit !== undefined &&
    widget.limit !== null &&
    widget.limit > maxLimit
  ) {
    logger.warn(
      `${widget.displayType} widgets support a maximum of ${maxLimit} rows. Clamping --limit from ${widget.limit} to ${maxLimit}.`
    );
    widget = { ...widget, limit: maxLimit };
  }

  if (!widget.queries) {
    return widget;
  }
  return {
    ...widget,
    queries: widget.queries.map((q) => ({
      ...q,
      conditions: q.conditions ?? "",
      fields: q.fields?.length
        ? q.fields
        : [...(q.columns ?? []), ...(q.aggregates ?? [])],
    })),
  };
}

// ---------------------------------------------------------------------------
// Auto-layout utilities
// ---------------------------------------------------------------------------

/** Sentry dashboard grid column count */
export const GRID_COLUMNS = 6;

/**
 * Controls how the auto-placer positions new widgets in the grid.
 *
 * - `sequential` — Cursor-based append: place after the last widget,
 *   wrap to a new row on overflow. Never backfills interior gaps.
 * - `dense` — First-fit packing: scan top-to-bottom, left-to-right
 *   and place in the first available gap. Produces compact layouts.
 */
export type WidgetLayoutMode = "sequential" | "dense";

/** Default widget dimensions by displayType */
const DEFAULT_WIDGET_SIZE: Partial<
  Record<DisplayType, { w: number; h: number; minH: number }>
> = {
  big_number: { w: 2, h: 1, minH: 1 },
  line: { w: 3, h: 2, minH: 2 },
  area: { w: 3, h: 2, minH: 2 },
  bar: { w: 3, h: 2, minH: 2 },
  table: { w: 6, h: 2, minH: 2 },
};
const FALLBACK_SIZE = { w: 3, h: 2, minH: 2 };

/**
 * Fallback layout for widgets without an existing layout.
 * Used when merging explicit layout flags over a widget that has no layout set.
 * Position defaults to origin (0,0) with standard 3×2 dimensions.
 */
export const FALLBACK_LAYOUT: DashboardWidgetLayout = {
  x: 0,
  y: 0,
  ...FALLBACK_SIZE,
};

/** Build a set of occupied grid cells and the max bottom edge from existing layouts. */
function buildOccupiedGrid(widgets: DashboardWidget[]): {
  occupied: Set<string>;
  maxY: number;
} {
  const occupied = new Set<string>();
  let maxY = 0;
  for (const w of widgets) {
    if (!w.layout) {
      continue;
    }
    const bottom = w.layout.y + w.layout.h;
    if (bottom > maxY) {
      maxY = bottom;
    }
    for (let y = w.layout.y; y < bottom; y++) {
      for (let x = w.layout.x; x < w.layout.x + w.layout.w; x++) {
        occupied.add(`${x},${y}`);
      }
    }
  }
  return { occupied, maxY };
}

/** Check whether a rectangle fits at a position without overlapping occupied cells. */
function regionFits(
  occupied: Set<string>,
  rect: { px: number; py: number; w: number; h: number }
): boolean {
  for (let dy = 0; dy < rect.h; dy++) {
    for (let dx = 0; dx < rect.w; dx++) {
      if (occupied.has(`${rect.px + dx},${rect.py + dy}`)) {
        return false;
      }
    }
  }
  return true;
}

/** Grid state computed from existing widget layouts */
type OccupiedGrid = { occupied: Set<string>; maxY: number };

/** Widget dimensions resolved from displayType */
type WidgetSize = { w: number; h: number; minH: number };

/**
 * Dense (first-fit) placement: scan the grid top-to-bottom, left-to-right
 * and place the widget in the first gap where it fits.
 */
function assignLayoutDense(
  widget: DashboardWidget,
  size: WidgetSize,
  grid: OccupiedGrid
): DashboardWidget {
  const { w, h, minH } = size;
  for (let y = 0; y <= grid.maxY; y++) {
    for (let x = 0; x <= GRID_COLUMNS - w; x++) {
      if (regionFits(grid.occupied, { px: x, py: y, w, h })) {
        return { ...widget, layout: { x, y, w, h, minH } };
      }
    }
  }
  return { ...widget, layout: { x: 0, y: grid.maxY, w, h, minH } };
}

/**
 * Find the layout of the last widget in the array that has one.
 * Reverse-scans because the API preserves insertion order.
 */
function findLastLayout(
  widgets: DashboardWidget[]
): DashboardWidgetLayout | undefined {
  for (let i = widgets.length - 1; i >= 0; i--) {
    const layout = widgets[i]?.layout;
    if (layout) {
      return layout;
    }
  }
}

/**
 * Sequential (cursor-based) placement: place the widget immediately to the
 * right of the last existing widget on the same row. When the row overflows
 * or the position overlaps a manually-placed widget, wrap to a fresh row
 * below all existing content.
 */
function assignLayoutSequential(
  widget: DashboardWidget,
  existingWidgets: DashboardWidget[],
  size: WidgetSize,
  grid: OccupiedGrid
): DashboardWidget {
  const { w, h, minH } = size;
  const lastLayout = findLastLayout(existingWidgets);

  if (lastLayout) {
    const cursorX = lastLayout.x + lastLayout.w;
    const cursorY = lastLayout.y;

    // Place at cursor if it fits within the grid and doesn't overlap
    if (
      cursorX + w <= GRID_COLUMNS &&
      regionFits(grid.occupied, { px: cursorX, py: cursorY, w, h })
    ) {
      return { ...widget, layout: { x: cursorX, y: cursorY, w, h, minH } };
    }
  }

  // Wrap to a new row below all existing content
  return { ...widget, layout: { x: 0, y: grid.maxY, w, h, minH } };
}

/**
 * Assign a default layout to a widget if it doesn't already have one.
 *
 * Two placement modes are available:
 * - `"sequential"` (default) — Cursor-based append: the widget is placed
 *   immediately after the last existing widget, wrapping to a new row when
 *   the current row overflows. Interior gaps are never backfilled.
 * - `"dense"` — First-fit packing: the widget is placed in the first
 *   available gap, scanning top-to-bottom and left-to-right.
 *
 * @param widget - Widget that may be missing a layout
 * @param existingWidgets - Widgets already in the dashboard (used to compute placement)
 * @param mode - Layout strategy (`"sequential"` or `"dense"`)
 * @returns Widget with layout guaranteed
 */
export function assignDefaultLayout(
  widget: DashboardWidget,
  existingWidgets: DashboardWidget[],
  mode: WidgetLayoutMode = "sequential"
): DashboardWidget {
  if (widget.layout) {
    return widget;
  }

  const size =
    DEFAULT_WIDGET_SIZE[widget.displayType as DisplayType] ?? FALLBACK_SIZE;
  const grid = buildOccupiedGrid(existingWidgets);

  if (mode === "dense") {
    return assignLayoutDense(widget, size, grid);
  }

  return assignLayoutSequential(widget, existingWidgets, size, grid);
}

// ---------------------------------------------------------------------------
// Layout validation
// ---------------------------------------------------------------------------

/** Shared layout flags accepted by widget add and edit commands */
export type WidgetLayoutFlags = {
  readonly col?: number;
  readonly row?: number;
  readonly width?: number;
  readonly height?: number;
};

/** Assert a layout value is a non-negative integer within an optional upper bound */
function assertLayoutInt(
  value: number,
  flag: string,
  min: number,
  max?: number
): void {
  if (!Number.isInteger(value) || value < min) {
    throw new ValidationError(
      `--${flag} must be ${min === 0 ? "a non-negative" : "a positive"} integer (got ${value}).`,
      flag
    );
  }
  if (max !== undefined && value > max) {
    throw new ValidationError(
      `--${flag} must be ${min}–${max} (dashboard grid is ${GRID_COLUMNS} columns wide).`,
      flag
    );
  }
}

/**
 * Validate layout flag values against the 6-column dashboard grid.
 *
 * Checks that position and size values are within the valid range and
 * that the widget fits within the grid columns. Validates each provided
 * flag independently, and cross-validates x + width when both are known.
 *
 * @param flags - Layout flags from the command
 * @param existing - Existing widget layout (used for cross-validation when only one dimension is provided)
 */
export function validateWidgetLayout(
  flags: WidgetLayoutFlags,
  existing?: DashboardWidgetLayout
): void {
  if (flags.col !== undefined) {
    assertLayoutInt(flags.col, "col", 0, GRID_COLUMNS - 1);
  }
  if (flags.row !== undefined) {
    assertLayoutInt(flags.row, "row", 0);
  }
  if (flags.width !== undefined) {
    assertLayoutInt(flags.width, "width", 1, GRID_COLUMNS);
  }
  if (flags.height !== undefined) {
    assertLayoutInt(flags.height, "height", 1);
  }

  // Cross-validate col + width doesn't overflow the grid
  const effectiveX = flags.col ?? existing?.x;
  const effectiveW = flags.width ?? existing?.w;
  if (
    effectiveX !== undefined &&
    effectiveW !== undefined &&
    effectiveX + effectiveW > GRID_COLUMNS
  ) {
    throw new ValidationError(
      `Widget overflows the grid: col(${effectiveX}) + width(${effectiveW}) = ${effectiveX + effectiveW}, but the grid is ${GRID_COLUMNS} columns wide.`,
      "col"
    );
  }
}

// ---------------------------------------------------------------------------
// Server field stripping utilities
//
// The Sentry dashboard API returns many extra fields via GET that should NOT
// be sent back in PUT requests. Using an allowlist approach ensures only
// fields the API accepts are included, avoiding silent rejection of widgets.
// ---------------------------------------------------------------------------

/** Extract only the query fields the PUT API accepts */
function cleanQuery(q: DashboardWidgetQuery): DashboardWidgetQuery {
  return {
    name: q.name ?? "",
    conditions: q.conditions ?? "",
    columns: q.columns ?? [],
    aggregates: q.aggregates ?? [],
    fields: q.fields ?? [],
    ...(q.fieldAliases && { fieldAliases: q.fieldAliases }),
    ...(q.orderby && { orderby: q.orderby }),
  };
}

/**
 * Strip server-generated and passthrough fields from a widget for PUT requests.
 *
 * Uses an allowlist approach: only includes fields the dashboard PUT API
 * accepts. The GET response includes many extra fields (description, thresholds,
 * interval, axisRange, datasetSource, etc.) that cause silent failures if
 * sent back in PUT.
 *
 * @param widget - Widget object from GET response
 * @returns Widget safe for PUT (only API-accepted fields)
 */
export function stripWidgetServerFields(
  widget: DashboardWidget
): DashboardWidget {
  const cleaned: DashboardWidget = {
    title: widget.title,
    displayType: widget.displayType,
    ...(widget.widgetType && { widgetType: widget.widgetType }),
    ...(widget.queries && { queries: widget.queries.map(cleanQuery) }),
    ...(widget.limit !== undefined &&
      widget.limit !== null && { limit: widget.limit }),
  };

  // Preserve layout (x, y, w, h, minH only — not isResizable)
  if (widget.layout) {
    cleaned.layout = {
      x: widget.layout.x,
      y: widget.layout.y,
      w: widget.layout.w,
      h: widget.layout.h,
      ...(widget.layout.minH !== undefined && { minH: widget.layout.minH }),
    };
  }

  return cleaned;
}

/**
 * Prepare a full dashboard for PUT update.
 * Strips server-generated fields from all widgets while preserving
 * widgetType, displayType, and layout.
 *
 * @param dashboard - Dashboard detail from GET response
 * @returns Object with title and cleaned widgets, ready for PUT body
 */
export function prepareDashboardForUpdate(dashboard: DashboardDetail): {
  title: string;
  widgets: DashboardWidget[];
  projects?: number[];
  environment?: string[];
  period?: string | null;
} {
  return {
    title: dashboard.title,
    widgets: (dashboard.widgets ?? []).map(stripWidgetServerFields),
    projects: dashboard.projects,
    environment: dashboard.environment,
    period: dashboard.period,
  };
}

// ---------------------------------------------------------------------------
// Widget data query types
//
// Types for responses from the events-stats and events API endpoints
// used to fetch actual widget data for dashboard rendering.
// ---------------------------------------------------------------------------

/**
 * Single data point from the events-stats API.
 * Format: [timestamp_epoch_seconds, [{count: value}]]
 */
export const EventsStatsDataPointSchema = tuple([
  number(),
  array(object({ count: number() })),
]);

export type EventsStatsDataPoint = InferOutput<
  typeof EventsStatsDataPointSchema
>;

/**
 * A single time-series from events-stats.
 *
 * In simple queries this is the top-level response.
 * In grouped queries (`topEvents > 0`) each group key maps to one of these.
 */
export const EventsStatsSeriesSchema = looseObject({
  data: array(EventsStatsDataPointSchema),
  order: optional(number()),
  start: optional(union([string(), number()])),
  end: optional(union([string(), number()])),
  meta: optional(
    looseObject({
      fields: optional(record(string(), string())),
      units: optional(record(string(), nullable(string()))),
    })
  ),
});

export type EventsStatsSeries = InferOutput<typeof EventsStatsSeriesSchema>;

/**
 * Response from `GET /organizations/{org}/events/` (table format).
 *
 * Used by table, big_number, and top_n widget types.
 */
export const EventsTableResponseSchema = object({
  data: array(record(string(), unknown())),
  meta: optional(
    object({
      fields: optional(record(string(), string())),
      units: optional(record(string(), nullable(string()))),
    })
  ),
});

export type EventsTableResponse = InferOutput<typeof EventsTableResponseSchema>;

// ---------------------------------------------------------------------------
// Widget data result types — discriminated union for all widget outputs
// ---------------------------------------------------------------------------

/** Time-series data for chart widgets (line, area, bar) */
export type TimeseriesResult = {
  type: "timeseries";
  series: {
    label: string;
    values: { timestamp: number; value: number }[];
    unit?: string | null;
  }[];
};

/** Tabular data for table and top_n widgets */
export type TableResult = {
  type: "table";
  columns: { name: string; type?: string; unit?: string | null }[];
  rows: Record<string, unknown>[];
};

/** Single scalar value for big_number widgets */
export type ScalarResult = {
  type: "scalar";
  value: number;
  previousValue?: number;
  unit?: string | null;
};

/** Markdown text content for text widgets (no API query — content from widget.description) */
export type TextResult = {
  type: "text";
  content: string;
};

/** Widget type not supported for data fetching */
export type UnsupportedResult = {
  type: "unsupported";
  reason: string;
};

/** Widget query failed */
export type ErrorResult = {
  type: "error";
  message: string;
};

/**
 * Result of querying a widget's data.
 *
 * Discriminated on `type` to determine how to render:
 * - `timeseries` → sparkline charts
 * - `table` → text table
 * - `scalar` → big number display
 * - `text` → rendered markdown content
 * - `unsupported` → placeholder message
 * - `error` → error message
 */
export type WidgetDataResult =
  | TimeseriesResult
  | TableResult
  | ScalarResult
  | TextResult
  | UnsupportedResult
  | ErrorResult;

// ---------------------------------------------------------------------------
// Dataset mapping
// ---------------------------------------------------------------------------

/**
 * Maps widget types to API dataset parameter values.
 *
 * Widget types that don't map to a dataset (issue, preprod-app-size, etc.)
 * return null and are rendered as "unsupported".
 */
const WIDGET_TYPE_TO_DATASET: Record<string, string> = {
  spans: "spans",
  "error-events": "errors",
  logs: "logs",
  tracemetrics: "tracemetrics",
};

/**
 * Map a widget's `widgetType` to the API `dataset` parameter.
 *
 * @param widgetType - The widget's dataset type (e.g., "spans", "logs")
 * @returns The API dataset string, or null if the type isn't queryable
 */
export function mapWidgetTypeToDataset(
  widgetType: string | undefined
): string | null {
  if (!widgetType) {
    return null;
  }
  return WIDGET_TYPE_TO_DATASET[widgetType] ?? null;
}

/** Display types that use time-series data (events-stats endpoint) */
export const TIMESERIES_DISPLAY_TYPES = new Set([
  "line",
  "area",
  "stacked_area",
  "bar",
  "categorical_bar",
  "heatmap",
]);

/** Display types that use tabular data (events endpoint) */
export const TABLE_DISPLAY_TYPES = new Set(["table", "top_n"]);

// ---------------------------------------------------------------------------
// Dashboard revision types
// ---------------------------------------------------------------------------

/** Schema for the createdBy field in a dashboard revision */
const DashboardRevisionCreatedBySchema = looseObject({
  id: optional(string()),
  name: nullish(string()),
  email: nullish(string()),
  avatarType: nullish(string()),
  avatarUrl: nullish(string()),
});

/** Schema for a dashboard revision (from GET /dashboards/{id}/revisions/) */
export const DashboardRevisionSchema = looseObject({
  id: string(),
  title: string(),
  dateCreated: string(),
  createdBy: nullable(DashboardRevisionCreatedBySchema),
  source: string(),
});

export type DashboardRevision = InferOutput<typeof DashboardRevisionSchema>;
