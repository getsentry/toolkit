/**
 * Dashboard Type & Validation Tests
 *
 * Tests for enum constants, strict input schema, and parseWidgetInput()
 * in src/types/dashboard.ts.
 */

import { safeParse } from "valibot";
import { describe, expect, test } from "vitest";
import { ValidationError } from "../../src/lib/errors.js";
import {
  assignDefaultLayout,
  type DashboardWidget,
  DashboardWidgetInputSchema,
  DEFAULT_WIDGET_TYPE,
  DISPLAY_TYPES,
  type DisplayType,
  ERROR_AGGREGATE_FUNCTIONS,
  ErrorAggregateFunctionSchema,
  EventsStatsDataPointSchema,
  EventsStatsSeriesSchema,
  EventsTableResponseSchema,
  GRID_COLUMNS,
  IS_FILTER_VALUES,
  IsFilterValueSchema,
  mapWidgetTypeToDataset,
  parseAggregate,
  parseSortExpression,
  parseWidgetInput,
  prepareWidgetQueries,
  SPAN_AGGREGATE_FUNCTIONS,
  SpanAggregateFunctionSchema,
  stripWidgetServerFields,
  TABLE_DISPLAY_TYPES,
  type TextResult,
  TIMESERIES_DISPLAY_TYPES,
  validateAggregateNames,
  validateWidgetLayout,
  WIDGET_TYPES,
  type WidgetDataResult,
  type WidgetType,
} from "../../src/types/dashboard.js";

// ---------------------------------------------------------------------------
// Enum constants
// ---------------------------------------------------------------------------

describe("WIDGET_TYPES", () => {
  test("contains spans as default", () => {
    expect(WIDGET_TYPES).toContain("spans");
    expect(DEFAULT_WIDGET_TYPE).toBe("spans");
  });

  test("contains all expected dataset types", () => {
    const expected: WidgetType[] = [
      "issue",
      "error-events",
      "spans",
      "logs",
      "tracemetrics",
      "preprod-app-size",
    ];
    for (const t of expected) {
      expect(WIDGET_TYPES).toContain(t);
    }
  });
});

describe("DISPLAY_TYPES", () => {
  test("contains common visualization types", () => {
    const common: DisplayType[] = [
      "line",
      "area",
      "bar",
      "table",
      "big_number",
    ];
    for (const t of common) {
      expect(DISPLAY_TYPES).toContain(t);
    }
  });

  test("contains all expected display types", () => {
    const expected: DisplayType[] = [
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
    ];
    for (const t of expected) {
      expect(DISPLAY_TYPES).toContain(t);
    }
  });
});

// ---------------------------------------------------------------------------
// SPAN_AGGREGATE_FUNCTIONS / ERROR_AGGREGATE_FUNCTIONS
// ---------------------------------------------------------------------------

describe("SPAN_AGGREGATE_FUNCTIONS", () => {
  test("contains core aggregate functions", () => {
    const core = [
      "count",
      "avg",
      "sum",
      "min",
      "max",
      "p50",
      "p75",
      "p95",
      "p99",
    ];
    for (const fn of core) {
      expect(SPAN_AGGREGATE_FUNCTIONS).toContain(fn);
    }
  });

  test("contains rate functions (canonical only, no aliases)", () => {
    expect(SPAN_AGGREGATE_FUNCTIONS).toContain("eps");
    expect(SPAN_AGGREGATE_FUNCTIONS).toContain("epm");
    // sps/spm are aliases resolved in parseAggregate(), not canonical functions
    expect(SPAN_AGGREGATE_FUNCTIONS).not.toContain("sps");
    expect(SPAN_AGGREGATE_FUNCTIONS).not.toContain("spm");
  });

  test("valibot schema validates known functions", () => {
    expect(safeParse(SpanAggregateFunctionSchema, "count").success).toBe(true);
    expect(safeParse(SpanAggregateFunctionSchema, "p95").success).toBe(true);
  });

  test("valibot schema rejects unknown functions", () => {
    expect(safeParse(SpanAggregateFunctionSchema, "bogus").success).toBe(false);
  });
});

describe("ERROR_AGGREGATE_FUNCTIONS", () => {
  test("is a superset of span functions", () => {
    for (const fn of SPAN_AGGREGATE_FUNCTIONS) {
      expect(ERROR_AGGREGATE_FUNCTIONS).toContain(fn);
    }
  });

  test("contains error-event-specific functions", () => {
    const extras = [
      "count_if",
      "count_at_least",
      "last_seen",
      "latest_event",
      "var",
      "stddev",
      "cov",
      "corr",
    ];
    for (const fn of extras) {
      expect(ERROR_AGGREGATE_FUNCTIONS).toContain(fn);
    }
  });

  test("valibot schema validates error-event functions", () => {
    expect(safeParse(ErrorAggregateFunctionSchema, "count_if").success).toBe(
      true
    );
    expect(safeParse(ErrorAggregateFunctionSchema, "last_seen").success).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// IS_FILTER_VALUES
// ---------------------------------------------------------------------------

describe("IS_FILTER_VALUES", () => {
  test("contains status values", () => {
    const statuses = ["resolved", "unresolved", "ignored", "archived"];
    for (const s of statuses) {
      expect(IS_FILTER_VALUES).toContain(s);
    }
  });

  test("contains substatus values", () => {
    const substatuses = ["escalating", "ongoing", "regressed", "new"];
    for (const s of substatuses) {
      expect(IS_FILTER_VALUES).toContain(s);
    }
  });

  test("contains assignment values", () => {
    const assignments = [
      "assigned",
      "unassigned",
      "for_review",
      "linked",
      "unlinked",
    ];
    for (const s of assignments) {
      expect(IS_FILTER_VALUES).toContain(s);
    }
  });

  test("valibot schema validates known values", () => {
    expect(safeParse(IsFilterValueSchema, "unresolved").success).toBe(true);
    expect(safeParse(IsFilterValueSchema, "escalating").success).toBe(true);
    expect(safeParse(IsFilterValueSchema, "assigned").success).toBe(true);
  });

  test("valibot schema rejects unknown values", () => {
    expect(safeParse(IsFilterValueSchema, "bogus").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DashboardWidgetInputSchema
// ---------------------------------------------------------------------------

describe("DashboardWidgetInputSchema", () => {
  const minimalWidget = {
    title: "My Widget",
    displayType: "line",
  };

  test("accepts minimal widget and defaults widgetType to spans", () => {
    const result = safeParse(DashboardWidgetInputSchema, minimalWidget);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.widgetType).toBe("spans");
    }
  });

  test("accepts explicit widgetType", () => {
    const result = safeParse(DashboardWidgetInputSchema, {
      ...minimalWidget,
      widgetType: "error-events",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.widgetType).toBe("error-events");
    }
  });

  test("accepts all valid widgetType values", () => {
    for (const wt of WIDGET_TYPES) {
      const result = safeParse(DashboardWidgetInputSchema, {
        ...minimalWidget,
        widgetType: wt,
      });
      expect(result.success).toBe(true);
    }
  });

  test("accepts all valid displayType values", () => {
    for (const dt of DISPLAY_TYPES) {
      const result = safeParse(DashboardWidgetInputSchema, {
        title: "Test",
        displayType: dt,
      });
      expect(result.success).toBe(true);
    }
  });

  test("rejects invalid displayType", () => {
    const result = safeParse(DashboardWidgetInputSchema, {
      ...minimalWidget,
      displayType: "chart",
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid widgetType", () => {
    const result = safeParse(DashboardWidgetInputSchema, {
      ...minimalWidget,
      widgetType: "span",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing title", () => {
    const result = safeParse(DashboardWidgetInputSchema, {
      displayType: "line",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing displayType", () => {
    const result = safeParse(DashboardWidgetInputSchema, {
      title: "My Widget",
    });
    expect(result.success).toBe(false);
  });

  test("preserves extra fields via passthrough", () => {
    const result = safeParse(DashboardWidgetInputSchema, {
      ...minimalWidget,
      customField: "hello",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.output as Record<string, unknown>).customField).toBe(
        "hello"
      );
    }
  });

  test("accepts widget with queries", () => {
    const result = safeParse(DashboardWidgetInputSchema, {
      ...minimalWidget,
      queries: [
        {
          conditions: "transaction.op:http",
          aggregates: ["count()"],
          columns: [],
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseWidgetInput
// ---------------------------------------------------------------------------

describe("parseWidgetInput", () => {
  test("returns validated widget with defaults", () => {
    const widget = parseWidgetInput({
      title: "Error Count",
      displayType: "big_number",
    });
    expect(widget.title).toBe("Error Count");
    expect(widget.displayType).toBe("big_number");
    expect(widget.widgetType).toBe("spans");
  });

  test("preserves explicit widgetType", () => {
    const widget = parseWidgetInput({
      title: "Errors",
      displayType: "line",
      widgetType: "error-events",
    });
    expect(widget.widgetType).toBe("error-events");
  });

  test("throws ValidationError for invalid displayType with valid values listed", () => {
    expect(() =>
      parseWidgetInput({
        title: "Bad Widget",
        displayType: "invalid_chart",
      })
    ).toThrow(/Invalid displayType/);
    expect(() =>
      parseWidgetInput({
        title: "Bad Widget",
        displayType: "invalid_chart",
      })
    ).toThrow(/line/);
  });

  test("throws ValidationError for invalid widgetType with valid values listed", () => {
    expect(() =>
      parseWidgetInput({
        title: "Bad Widget",
        displayType: "line",
        widgetType: "span",
      })
    ).toThrow(/Invalid widgetType/);
    expect(() =>
      parseWidgetInput({
        title: "Bad Widget",
        displayType: "line",
        widgetType: "span",
      })
    ).toThrow(/spans/);
  });

  test("throws ValidationError for missing required fields", () => {
    expect(() => parseWidgetInput({})).toThrow(/Invalid widget definition/);
  });

  test("throws ValidationError for non-object input", () => {
    expect(() => parseWidgetInput("not an object")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseAggregate
// ---------------------------------------------------------------------------

describe("parseAggregate", () => {
  test("bare name becomes no-arg function call", () => {
    expect(parseAggregate("count")).toBe("count()");
  });

  test("colon syntax becomes function with arg", () => {
    expect(parseAggregate("p95:span.duration")).toBe("p95(span.duration)");
  });

  test("passthrough when already has parens", () => {
    expect(parseAggregate("count()")).toBe("count()");
  });

  test("passthrough for function with args in parens", () => {
    expect(parseAggregate("avg(span.self_time)")).toBe("avg(span.self_time)");
  });

  test("colon with dotted column name", () => {
    expect(parseAggregate("avg:span.self_time")).toBe("avg(span.self_time)");
  });

  test("single word functions", () => {
    expect(parseAggregate("p50")).toBe("p50()");
    expect(parseAggregate("p75")).toBe("p75()");
    expect(parseAggregate("p99")).toBe("p99()");
  });
});

// ---------------------------------------------------------------------------
// parseSortExpression
// ---------------------------------------------------------------------------

describe("parseSortExpression", () => {
  test("ascending bare name", () => {
    expect(parseSortExpression("count")).toBe("count()");
  });

  test("descending bare name", () => {
    expect(parseSortExpression("-count")).toBe("-count()");
  });

  test("ascending colon syntax", () => {
    expect(parseSortExpression("p95:span.duration")).toBe("p95(span.duration)");
  });

  test("descending colon syntax", () => {
    expect(parseSortExpression("-p95:span.duration")).toBe(
      "-p95(span.duration)"
    );
  });

  test("passthrough with parens", () => {
    expect(parseSortExpression("count()")).toBe("count()");
    expect(parseSortExpression("-count()")).toBe("-count()");
  });
});

// ---------------------------------------------------------------------------
// prepareWidgetQueries
// ---------------------------------------------------------------------------

describe("prepareWidgetQueries", () => {
  test("auto-computes fields from aggregates + columns", () => {
    const widget = prepareWidgetQueries({
      title: "Test",
      displayType: "line",
      queries: [
        {
          aggregates: ["count()"],
          columns: ["browser.name"],
        },
      ],
    });
    expect(widget.queries?.[0]?.fields).toEqual(["browser.name", "count()"]);
  });

  test("does not overwrite existing fields", () => {
    const widget = prepareWidgetQueries({
      title: "Test",
      displayType: "line",
      queries: [
        {
          aggregates: ["count()"],
          columns: ["browser.name"],
          fields: ["custom_field"],
        },
      ],
    });
    expect(widget.queries?.[0]?.fields).toEqual(["custom_field"]);
  });

  test("defaults conditions to empty string when missing", () => {
    const widget = prepareWidgetQueries({
      title: "Test",
      displayType: "line",
      queries: [{ aggregates: ["count()"] }],
    });
    expect(widget.queries?.[0]?.conditions).toBe("");
  });

  test("preserves existing conditions", () => {
    const widget = prepareWidgetQueries({
      title: "Test",
      displayType: "line",
      queries: [
        {
          aggregates: ["count()"],
          conditions: "is:unresolved",
        },
      ],
    });
    expect(widget.queries?.[0]?.conditions).toBe("is:unresolved");
  });

  test("handles widget with no queries", () => {
    const widget = prepareWidgetQueries({
      title: "Test",
      displayType: "big_number",
    });
    expect(widget.queries).toBeUndefined();
  });

  test("handles empty aggregates and columns", () => {
    const widget = prepareWidgetQueries({
      title: "Test",
      displayType: "line",
      queries: [{}],
    });
    expect(widget.queries?.[0]?.fields).toEqual([]);
    expect(widget.queries?.[0]?.conditions).toBe("");
  });

  test("clamps table widget limit to max and warns", () => {
    const widget = prepareWidgetQueries({
      title: "Test",
      displayType: "table",
      limit: 25,
    });
    expect(widget.limit).toBe(10);
    expect(widget.title).toBe("Test");
    expect(widget.displayType).toBe("table");
  });

  test("clamps bar widget limit to max and warns", () => {
    const widget = prepareWidgetQueries({
      title: "Test",
      displayType: "bar",
      limit: 15,
    });
    expect(widget.limit).toBe(10);
    expect(widget.title).toBe("Test");
    expect(widget.displayType).toBe("bar");
  });

  test("accepts table widget with limit within max", () => {
    const widget = prepareWidgetQueries({
      title: "Test",
      displayType: "table",
      limit: 5,
    });
    expect(widget.limit).toBe(5);
  });

  test("accepts line widget with any limit", () => {
    const widget = prepareWidgetQueries({
      title: "Test",
      displayType: "line",
      limit: 100,
    });
    expect(widget.limit).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// assignDefaultLayout
// ---------------------------------------------------------------------------

describe("assignDefaultLayout", () => {
  test("widget with existing layout returns unchanged", () => {
    const widget: DashboardWidget = {
      title: "Test",
      displayType: "line",
      layout: { x: 1, y: 2, w: 3, h: 2 },
    };
    const result = assignDefaultLayout(widget, []);
    expect(result.layout).toEqual({ x: 1, y: 2, w: 3, h: 2 });
  });

  test("widget without layout assigns default size at (0,0)", () => {
    const widget: DashboardWidget = {
      title: "Test",
      displayType: "big_number",
    };
    const result = assignDefaultLayout(widget, []);
    expect(result.layout).toBeDefined();
    expect(result.layout!.x).toBe(0);
    expect(result.layout!.y).toBe(0);
    expect(result.layout!.w).toBe(2);
    expect(result.layout!.h).toBe(1);
  });

  test("places after last widget on same row (default sequential mode)", () => {
    const existing: DashboardWidget[] = [
      {
        title: "Existing",
        displayType: "big_number",
        layout: { x: 0, y: 0, w: 2, h: 1 },
      },
    ];
    const widget: DashboardWidget = {
      title: "New",
      displayType: "big_number",
    };
    const result = assignDefaultLayout(widget, existing);
    expect(result.layout).toBeDefined();
    // Cursor from last widget: (0+2, 0) = (2, 0)
    expect(result.layout!.x).toBe(2);
    expect(result.layout!.y).toBe(0);
  });

  // -- Sequential mode tests -----------------------------------------------

  test("sequential: three same-size widgets fill a row left-to-right", () => {
    const existing: DashboardWidget[] = [
      {
        title: "A",
        displayType: "big_number",
        layout: { x: 0, y: 0, w: 2, h: 1 },
      },
      {
        title: "B",
        displayType: "big_number",
        layout: { x: 2, y: 0, w: 2, h: 1 },
      },
    ];
    const result = assignDefaultLayout(
      { title: "C", displayType: "big_number" },
      existing
    );
    expect(result.layout).toMatchObject({ x: 4, y: 0, w: 2, h: 1 });
  });

  test("sequential: wraps to new row when cursor overflows grid width", () => {
    const existing: DashboardWidget[] = [
      {
        title: "A",
        displayType: "line",
        layout: { x: 0, y: 0, w: 3, h: 2 },
      },
      {
        title: "B",
        displayType: "line",
        layout: { x: 3, y: 0, w: 3, h: 2 },
      },
    ];
    const result = assignDefaultLayout(
      { title: "C", displayType: "line" },
      existing
    );
    // cursor=(6,0) → 6+3=9 > 6, overflow → (0, 2)
    expect(result.layout).toMatchObject({ x: 0, y: 2, w: 3, h: 2 });
  });

  test("sequential: does NOT backfill gap beside taller widget", () => {
    const existing: DashboardWidget[] = [
      {
        title: "Chart",
        displayType: "line",
        layout: { x: 0, y: 0, w: 4, h: 2 },
      },
      {
        title: "KPI-1",
        displayType: "big_number",
        layout: { x: 4, y: 0, w: 2, h: 1 },
      },
    ];
    const result = assignDefaultLayout(
      { title: "KPI-2", displayType: "big_number" },
      existing
    );
    // Old greedy algorithm would place at (4,1) — the gap beside the line chart.
    // Sequential mode wraps to below everything instead.
    expect(result.layout).toMatchObject({ x: 0, y: 2 });
  });

  test("sequential: table (6x2) forces next widget to new row", () => {
    const existing: DashboardWidget[] = [
      {
        title: "Table",
        displayType: "table",
        layout: { x: 0, y: 0, w: 6, h: 2 },
      },
    ];
    const result = assignDefaultLayout(
      { title: "Chart", displayType: "line" },
      existing
    );
    // cursor=(6,0) → 6+3=9 > 6, overflow → (0, 2)
    expect(result.layout).toMatchObject({ x: 0, y: 2, w: 3, h: 2 });
  });

  test("sequential: all existing widgets lack layouts → place at (0, 0)", () => {
    const existing: DashboardWidget[] = [
      { title: "No Layout 1", displayType: "line" },
      { title: "No Layout 2", displayType: "bar" },
    ];
    const result = assignDefaultLayout(
      { title: "New", displayType: "big_number" },
      existing
    );
    expect(result.layout).toMatchObject({ x: 0, y: 0, w: 2, h: 1 });
  });

  test("sequential: uses earlier widget when last has no layout", () => {
    const existing: DashboardWidget[] = [
      {
        title: "Has Layout",
        displayType: "big_number",
        layout: { x: 0, y: 0, w: 2, h: 1 },
      },
      { title: "No Layout", displayType: "line" },
    ];
    const result = assignDefaultLayout(
      { title: "New", displayType: "big_number" },
      existing
    );
    // Last with layout is at (0,0) w=2, cursor=(2,0)
    expect(result.layout).toMatchObject({ x: 2, y: 0, w: 2, h: 1 });
  });

  test("sequential: cursor overlaps manually-placed widget → falls back to below", () => {
    // B at (4,0) was placed before A in the array, simulating manual rearrangement.
    // Last widget with layout = A at (0,0) w=3 → cursor = (3, 0).
    // New big_number (2x1) at (3,0) would need (3,0) and (4,0).
    // (4,0) is occupied by B → regionFits fails → fallback to (0, maxY=2).
    const existing: DashboardWidget[] = [
      {
        title: "B",
        displayType: "big_number",
        layout: { x: 4, y: 0, w: 2, h: 2 },
      },
      {
        title: "A",
        displayType: "line",
        layout: { x: 0, y: 0, w: 3, h: 2 },
      },
    ];
    const result = assignDefaultLayout(
      { title: "New", displayType: "big_number" },
      existing
    );
    expect(result.layout).toMatchObject({ x: 0, y: 2 });
  });

  // -- Dense mode tests ----------------------------------------------------

  test("dense: fills gap beside taller widget", () => {
    const existing: DashboardWidget[] = [
      {
        title: "Chart",
        displayType: "line",
        layout: { x: 0, y: 0, w: 4, h: 2 },
      },
      {
        title: "KPI-1",
        displayType: "big_number",
        layout: { x: 4, y: 0, w: 2, h: 1 },
      },
    ];
    const result = assignDefaultLayout(
      { title: "KPI-2", displayType: "big_number" },
      existing,
      "dense"
    );
    // Dense mode finds the gap at (4,1) beside the line chart
    expect(result.layout).toMatchObject({ x: 4, y: 1, w: 2, h: 1 });
  });

  test("dense: finds first available gap top-to-bottom", () => {
    const existing: DashboardWidget[] = [
      {
        title: "A",
        displayType: "big_number",
        layout: { x: 0, y: 0, w: 2, h: 1 },
      },
    ];
    const result = assignDefaultLayout(
      { title: "B", displayType: "big_number" },
      existing,
      "dense"
    );
    // First gap is at (2,0)
    expect(result.layout).toMatchObject({ x: 2, y: 0 });
  });

  // -- Shared behavior tests -----------------------------------------------

  test("unknown displayType uses fallback size 3x2", () => {
    const result = assignDefaultLayout(
      { title: "Custom", displayType: "some_future_type" } as DashboardWidget,
      []
    );
    expect(result.layout).toMatchObject({ x: 0, y: 0, w: 3, h: 2 });
  });
});

// ---------------------------------------------------------------------------
// stripWidgetServerFields
// ---------------------------------------------------------------------------

describe("stripWidgetServerFields", () => {
  test("strips id, dashboardId, dateCreated from widget", () => {
    const widget: DashboardWidget = {
      id: "100",
      dashboardId: "42",
      dateCreated: "2026-01-01T00:00:00Z",
      title: "Test",
      displayType: "line",
      widgetType: "spans",
    };
    const result = stripWidgetServerFields(widget);
    expect(result).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("dashboardId");
    expect(result).not.toHaveProperty("dateCreated");
    expect(result.title).toBe("Test");
    expect(result.displayType).toBe("line");
    expect(result.widgetType).toBe("spans");
  });

  test("strips server fields from queries", () => {
    const widget: DashboardWidget = {
      title: "Test",
      displayType: "line",
      queries: [
        {
          id: "q1",
          widgetId: "w1",
          dateCreated: "2026-01-01T00:00:00Z",
          aggregates: ["count()"],
          conditions: "",
          name: "Query 1",
        },
      ],
    };
    const result = stripWidgetServerFields(widget);
    const query = result.queries![0]!;
    expect(query).not.toHaveProperty("id");
    expect(query).not.toHaveProperty("widgetId");
    expect(query).not.toHaveProperty("dateCreated");
    expect(query.aggregates).toEqual(["count()"]);
  });

  test("strips isResizable from layout", () => {
    const widget: DashboardWidget = {
      title: "Test",
      displayType: "line",
      layout: { x: 0, y: 0, w: 3, h: 2, isResizable: true },
    };
    const result = stripWidgetServerFields(widget);
    expect(result.layout).not.toHaveProperty("isResizable");
    expect(result.layout!.x).toBe(0);
    expect(result.layout!.w).toBe(3);
  });

  test("preserves widgetType, displayType, and layout", () => {
    const widget: DashboardWidget = {
      id: "100",
      title: "Test",
      displayType: "bar",
      widgetType: "spans",
      layout: { x: 1, y: 2, w: 3, h: 4 },
    };
    const result = stripWidgetServerFields(widget);
    expect(result.displayType).toBe("bar");
    expect(result.widgetType).toBe("spans");
    expect(result.layout).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });
});

// ---------------------------------------------------------------------------
// Widget data query types
// ---------------------------------------------------------------------------

describe("EventsStatsDataPointSchema", () => {
  test("parses valid data point", () => {
    const result = safeParse(EventsStatsDataPointSchema, [
      1_700_000_000,
      [{ count: 42 }],
    ]);
    expect(result.success).toBe(true);
  });

  test("rejects invalid data point", () => {
    const result = safeParse(EventsStatsDataPointSchema, [
      "not-a-number",
      [{ count: 42 }],
    ]);
    expect(result.success).toBe(false);
  });
});

describe("EventsStatsSeriesSchema", () => {
  test("parses simple series", () => {
    const result = safeParse(EventsStatsSeriesSchema, {
      data: [
        [1_700_000_000, [{ count: 10 }]],
        [1_700_003_600, [{ count: 20 }]],
      ],
      start: "2024-01-01T00:00:00Z",
      end: "2024-01-02T00:00:00Z",
      meta: {
        fields: { "count()": "integer" },
        units: { "count()": null },
      },
    });
    expect(result.success).toBe(true);
  });

  test("parses series with optional fields missing", () => {
    const result = safeParse(EventsStatsSeriesSchema, {
      data: [[1_700_000_000, [{ count: 5 }]]],
    });
    expect(result.success).toBe(true);
  });
});

describe("EventsTableResponseSchema", () => {
  test("parses table response", () => {
    const result = safeParse(EventsTableResponseSchema, {
      data: [
        { endpoint: "/api/users", "count()": 100 },
        { endpoint: "/api/orders", "count()": 50 },
      ],
      meta: {
        fields: { endpoint: "string", "count()": "integer" },
        units: { endpoint: null, "count()": null },
      },
    });
    expect(result.success).toBe(true);
  });

  test("parses empty table response", () => {
    const result = safeParse(EventsTableResponseSchema, {
      data: [],
      meta: { fields: {}, units: {} },
    });
    expect(result.success).toBe(true);
  });
});

describe("mapWidgetTypeToDataset", () => {
  test("maps known widget types", () => {
    expect(mapWidgetTypeToDataset("spans")).toBe("spans");
    expect(mapWidgetTypeToDataset("error-events")).toBe("errors");
    expect(mapWidgetTypeToDataset("logs")).toBe("logs");
    expect(mapWidgetTypeToDataset("tracemetrics")).toBe("tracemetrics");
  });

  test("returns null for unsupported widget types", () => {
    expect(mapWidgetTypeToDataset("issue")).toBeNull();
    expect(mapWidgetTypeToDataset("preprod-app-size")).toBeNull();
    expect(mapWidgetTypeToDataset("discover")).toBeNull();
    expect(mapWidgetTypeToDataset("transaction-like")).toBeNull();
  });

  test("returns null for undefined", () => {
    expect(mapWidgetTypeToDataset(undefined)).toBeNull();
  });
});

describe("validateAggregateNames", () => {
  test("accepts comma-separated tracemetrics aggregates", () => {
    expect(() =>
      validateAggregateNames(
        ["p50(value,completion.duration_ms,distribution,none)"],
        "tracemetrics"
      )
    ).not.toThrow();
  });

  test("accepts equation| formula aggregates for tracemetrics", () => {
    expect(() =>
      validateAggregateNames(
        [
          "equation|p50(value,a,distribution,none) / p50(value,b,distribution,none)",
        ],
        "tracemetrics"
      )
    ).not.toThrow();
  });

  test("rejects span-style aggregates for tracemetrics", () => {
    expect(() => validateAggregateNames(["count()"], "tracemetrics")).toThrow(
      ValidationError
    );
  });
});

// ---------------------------------------------------------------------------
// validateWidgetLayout
// ---------------------------------------------------------------------------

describe("validateWidgetLayout", () => {
  test("GRID_COLUMNS is 6", () => {
    expect(GRID_COLUMNS).toBe(6);
  });

  test("accepts valid layout flags", () => {
    expect(() =>
      validateWidgetLayout({ col: 0, row: 0, width: 3, height: 2 })
    ).not.toThrow();
    expect(() =>
      validateWidgetLayout({ col: 5, row: 10, width: 1, height: 1 })
    ).not.toThrow();
  });

  test("accepts partial layout flags", () => {
    expect(() => validateWidgetLayout({ col: 3 })).not.toThrow();
    expect(() => validateWidgetLayout({ width: 6 })).not.toThrow();
    expect(() => validateWidgetLayout({ height: 4 })).not.toThrow();
  });

  test("accepts empty flags (no layout change)", () => {
    expect(() => validateWidgetLayout({})).not.toThrow();
  });

  test("rejects col >= GRID_COLUMNS", () => {
    expect(() => validateWidgetLayout({ col: 6 })).toThrow(ValidationError);
    expect(() => validateWidgetLayout({ col: 100 })).toThrow(ValidationError);
  });

  test("rejects negative col", () => {
    expect(() => validateWidgetLayout({ col: -1 })).toThrow(ValidationError);
  });

  test("rejects negative row", () => {
    expect(() => validateWidgetLayout({ row: -1 })).toThrow(ValidationError);
  });

  test("rejects width < 1", () => {
    expect(() => validateWidgetLayout({ width: 0 })).toThrow(ValidationError);
    expect(() => validateWidgetLayout({ width: -1 })).toThrow(ValidationError);
  });

  test("rejects width > GRID_COLUMNS", () => {
    expect(() => validateWidgetLayout({ width: 7 })).toThrow(ValidationError);
  });

  test("rejects height < 1", () => {
    expect(() => validateWidgetLayout({ height: 0 })).toThrow(ValidationError);
    expect(() => validateWidgetLayout({ height: -1 })).toThrow(ValidationError);
  });

  test("rejects col + width > GRID_COLUMNS", () => {
    expect(() => validateWidgetLayout({ col: 4, width: 4 })).toThrow(
      ValidationError
    );
    expect(() => validateWidgetLayout({ col: 5, width: 2 })).toThrow(
      ValidationError
    );
  });

  test("allows col + width = GRID_COLUMNS (exactly fills)", () => {
    expect(() => validateWidgetLayout({ col: 3, width: 3 })).not.toThrow();
    expect(() => validateWidgetLayout({ col: 0, width: 6 })).not.toThrow();
  });

  test("cross-validates with existing layout", () => {
    const existing = { x: 4, y: 0, w: 2, h: 1 };
    // Changing only col=5 with existing w=2 → 5+2=7 > 6
    expect(() => validateWidgetLayout({ col: 5 }, existing)).toThrow(
      ValidationError
    );
    // Changing only width=3 with existing x=4 → 4+3=7 > 6
    expect(() => validateWidgetLayout({ width: 3 }, existing)).toThrow(
      ValidationError
    );
    // Valid: col=4 with existing w=2 → 4+2=6 ≤ 6
    expect(() => validateWidgetLayout({ col: 4 }, existing)).not.toThrow();
  });
});

describe("display type sets", () => {
  test("TIMESERIES_DISPLAY_TYPES contains chart types", () => {
    expect(TIMESERIES_DISPLAY_TYPES.has("line")).toBe(true);
    expect(TIMESERIES_DISPLAY_TYPES.has("area")).toBe(true);
    expect(TIMESERIES_DISPLAY_TYPES.has("stacked_area")).toBe(true);
    expect(TIMESERIES_DISPLAY_TYPES.has("bar")).toBe(true);
    expect(TIMESERIES_DISPLAY_TYPES.has("categorical_bar")).toBe(true);
    expect(TIMESERIES_DISPLAY_TYPES.has("table")).toBe(false);
    expect(TIMESERIES_DISPLAY_TYPES.has("big_number")).toBe(false);
  });

  test("TABLE_DISPLAY_TYPES contains table types", () => {
    expect(TABLE_DISPLAY_TYPES.has("table")).toBe(true);
    expect(TABLE_DISPLAY_TYPES.has("top_n")).toBe(true);
    expect(TABLE_DISPLAY_TYPES.has("line")).toBe(false);
  });
});

describe("TextResult", () => {
  test("satisfies WidgetDataResult discriminated union", () => {
    const result: WidgetDataResult = {
      type: "text",
      content: "# Hello",
    } satisfies TextResult;
    expect(result.type).toBe("text");
  });

  test("is included in WidgetDataResult union", () => {
    const results: WidgetDataResult[] = [
      { type: "timeseries", series: [] },
      { type: "table", columns: [], rows: [] },
      { type: "scalar", value: 42 },
      { type: "text", content: "some markdown" },
      { type: "unsupported", reason: "not supported" },
      { type: "error", message: "failed" },
    ];
    const textResult = results.find((r) => r.type === "text");
    expect(textResult).toBeDefined();
    if (textResult?.type === "text") {
      expect(textResult.content).toBe("some markdown");
    }
  });
});
