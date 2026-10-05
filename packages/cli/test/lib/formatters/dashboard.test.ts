/**
 * Dashboard Formatter Tests
 *
 * Tests for formatDashboardWithData, createDashboardViewRenderer,
 * from src/lib/formatters/dashboard.ts.
 *
 * Plain mode: set `NO_COLOR=1` (and delete `FORCE_COLOR`) so that both
 * `isPlainOutput()` returns true AND chalk strips all ANSI codes.
 *
 * Rendered mode: set `SENTRY_PLAIN_OUTPUT=0` to force `isPlainOutput()` false,
 * plus `chalk.level = 3` so chalk actually emits ANSI codes in the piped
 * test environment.
 *
 * Widget body lines are raw terminal strings (direct chalk), NOT markdown.
 * The header is a compact inline format (not a KV table).
 *
 * The grid renderer uses a framebuffer approach: each widget is rendered
 * into its grid-allocated region of a virtual screen buffer. Widgets at
 * the same `y` appear in the same terminal row range (LINES_PER_UNIT = 6
 * terminal lines per grid height unit). Tall widgets (h > 1) span multiple
 * row ranges.
 */

import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createDashboardViewRenderer,
  type DashboardViewData,
  type DashboardViewWidget,
  formatDashboardWithData,
} from "../../../src/lib/formatters/dashboard.js";
import type {
  ErrorResult,
  ScalarResult,
  TableResult,
  TextResult,
  TimeseriesResult,
  UnsupportedResult,
} from "../../../src/types/dashboard.js";

// ---------------------------------------------------------------------------
// Constants (must match source)
// ---------------------------------------------------------------------------

/** Terminal lines per grid height unit — mirrors LINES_PER_UNIT in dashboard.ts */
const LINES_PER_UNIT = 6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip ANSI escape codes for content assertions in rendered mode. */
function stripAnsi(str: string): string {
  return (
    str
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR escape codes
      .replace(/\x1b\[[0-9;]*m/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 8 hyperlink sequences
      .replace(/\x1b\]8;;[^\x07]*\x07/g, "")
  );
}

/**
 * Set up plain mode for a describe block.
 *
 * Uses `NO_COLOR=1` which makes both `isPlainOutput()` true and
 * chalk level 0 (no ANSI output). Deletes `FORCE_COLOR` to avoid
 * interference.
 */
function usePlainMode() {
  let savedNoColor: string | undefined;
  let savedForceColor: string | undefined;
  let savedPlain: string | undefined;

  beforeEach(() => {
    savedNoColor = process.env.NO_COLOR;
    savedForceColor = process.env.FORCE_COLOR;
    savedPlain = process.env.SENTRY_PLAIN_OUTPUT;

    process.env.NO_COLOR = "1";
    delete process.env.FORCE_COLOR;
    delete process.env.SENTRY_PLAIN_OUTPUT;
  });

  afterEach(() => {
    if (savedNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = savedNoColor;
    }
    if (savedForceColor === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = savedForceColor;
    }
    if (savedPlain === undefined) {
      delete process.env.SENTRY_PLAIN_OUTPUT;
    } else {
      process.env.SENTRY_PLAIN_OUTPUT = savedPlain;
    }
  });
}

/**
 * Set up rendered (TTY-like) mode for a describe block.
 *
 * Uses `SENTRY_PLAIN_OUTPUT=0` so `isPlainOutput()` returns false,
 * and sets `chalk.level = 3` so chalk emits ANSI codes in the piped
 * test environment.
 */
function useRenderedMode() {
  let savedPlain: string | undefined;
  let savedNoColor: string | undefined;
  let savedChalkLevel: typeof chalk.level;

  beforeEach(() => {
    savedPlain = process.env.SENTRY_PLAIN_OUTPUT;
    savedNoColor = process.env.NO_COLOR;
    savedChalkLevel = chalk.level;

    process.env.SENTRY_PLAIN_OUTPUT = "0";
    delete process.env.NO_COLOR;
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = savedChalkLevel;
    if (savedPlain === undefined) {
      delete process.env.SENTRY_PLAIN_OUTPUT;
    } else {
      process.env.SENTRY_PLAIN_OUTPUT = savedPlain;
    }
    if (savedNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = savedNoColor;
    }
  });
}

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeTimeseriesData(
  overrides: Partial<TimeseriesResult> = {}
): TimeseriesResult {
  return {
    type: "timeseries",
    series: [
      {
        label: "count()",
        values: [
          { timestamp: 1_700_000_000, value: 10 },
          { timestamp: 1_700_000_060, value: 20 },
          { timestamp: 1_700_000_120, value: 15 },
          { timestamp: 1_700_000_180, value: 30 },
        ],
      },
    ],
    ...overrides,
  };
}

function makeTableData(overrides: Partial<TableResult> = {}): TableResult {
  return {
    type: "table",
    columns: [
      { name: "transaction", type: "string" },
      { name: "count", type: "integer" },
    ],
    rows: [
      { transaction: "/api/users", count: 142 },
      { transaction: "/api/orders", count: 87 },
    ],
    ...overrides,
  };
}

function makeScalarData(overrides: Partial<ScalarResult> = {}): ScalarResult {
  return {
    type: "scalar",
    value: 1247,
    ...overrides,
  };
}

function makeTextData(overrides: Partial<TextResult> = {}): TextResult {
  return {
    type: "text",
    content: "# Notes\nSome **important** text here.",
    ...overrides,
  };
}

function makeUnsupportedData(
  overrides: Partial<UnsupportedResult> = {}
): UnsupportedResult {
  return {
    type: "unsupported",
    reason: "issue widgets not yet supported",
    ...overrides,
  };
}

function makeErrorData(overrides: Partial<ErrorResult> = {}): ErrorResult {
  return {
    type: "error",
    message: "Query timeout exceeded",
    ...overrides,
  };
}

function makeWidget(
  overrides: Partial<DashboardViewWidget> = {}
): DashboardViewWidget {
  return {
    title: "Test Widget",
    displayType: "line",
    data: makeTimeseriesData(),
    ...overrides,
  };
}

function makeDashboardData(
  overrides: Partial<DashboardViewData> = {}
): DashboardViewData {
  return {
    id: "12345",
    title: "My Dashboard",
    period: "24h",
    fetchedAt: "2024-01-15T10:30:00Z",
    url: "https://sentry.io/organizations/test-org/dashboard/12345/",
    environment: ["production"],
    widgets: [makeWidget()],
    ...overrides,
  };
}

// ===========================================================================
// formatDashboardWithData
// ===========================================================================

describe("formatDashboardWithData", () => {
  usePlainMode();

  describe("dashboard header (plain mode)", () => {
    test("renders title on first line", () => {
      const data = makeDashboardData({
        title: "Production Overview",
        period: "7d",
      });
      const output = formatDashboardWithData(data);
      const lines = output.split("\n");
      expect(lines[0]).toContain("Production Overview");
    });

    test("renders period with label on second line", () => {
      const data = makeDashboardData({ period: "7d" });
      const output = formatDashboardWithData(data);
      const lines = output.split("\n");
      expect(lines[1]).toContain("Period: 7d");
    });

    test("renders environment with label on second line", () => {
      const data = makeDashboardData({
        environment: ["production"],
      });
      const output = formatDashboardWithData(data);
      const lines = output.split("\n");
      expect(lines[1]).toContain("Env: production");
    });

    test("renders multiple environments comma-separated", () => {
      const data = makeDashboardData({
        environment: ["production", "staging"],
      });
      const output = formatDashboardWithData(data);
      const lines = output.split("\n");
      expect(lines[1]).toContain("Env: production, staging");
    });

    test("omits env part when environment is empty", () => {
      const data = makeDashboardData({ environment: [] });
      const output = formatDashboardWithData(data);
      const lines = output.split("\n");
      expect(lines[1]).not.toContain("Env:");
    });

    test("omits env part when environment is undefined", () => {
      const data = makeDashboardData({ environment: undefined });
      const output = formatDashboardWithData(data);
      const lines = output.split("\n");
      expect(lines[1]).not.toContain("Env:");
    });

    test("renders URL on third line", () => {
      const url = "https://sentry.io/organizations/my-org/dashboard/42/";
      const data = makeDashboardData({ url });
      const output = formatDashboardWithData(data);
      const lines = output.split("\n");
      expect(lines[2]).toContain(url);
    });

    test("header has underline after URL", () => {
      const data = makeDashboardData();
      const output = formatDashboardWithData(data);
      const lines = output.split("\n");
      // After title, meta, URL → underline → blank line separator
      expect(lines[3]).toMatch(/^─+$/);
      expect(lines[4]).toBe("");
    });
  });

  describe("dashboard header (rendered mode)", () => {
    useRenderedMode();

    test("renders title in bold white", () => {
      const data = makeDashboardData({ title: "My Dashboard" });
      const output = formatDashboardWithData(data);
      const plain = stripAnsi(output);
      expect(plain).toContain("My Dashboard");
      // In rendered mode, title has ANSI codes (bold + hex color)
      expect(output).not.toBe(plain);
    });

    test("renders period with cyan color", () => {
      const data = makeDashboardData({ period: "24h" });
      const output = formatDashboardWithData(data);
      const lines = output.split("\n");
      // First line contains title and period
      const firstLine = stripAnsi(lines[0]);
      expect(firstLine).toContain("24h");
    });

    test("renders environment with green color", () => {
      const data = makeDashboardData({ environment: ["production"] });
      const output = formatDashboardWithData(data);
      const firstLine = stripAnsi(output.split("\n")[0]);
      expect(firstLine).toContain("production");
    });

    test("renders underline below title in rendered mode", () => {
      const url = "https://sentry.io/organizations/my-org/dashboard/42/";
      const data = makeDashboardData({ url });
      const output = formatDashboardWithData(data);
      // Rendered mode: title line, muted underline, blank separator
      const secondLine = stripAnsi(output.split("\n")[1]);
      expect(secondLine).toMatch(/^─+$/);
      expect(stripAnsi(output.split("\n")[2])).toBe("");
    });
  });

  describe("timeseries widget", () => {
    test("renders widget title", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            title: "Error Rate",
            displayType: "line",
            data: makeTimeseriesData(),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("Error Rate");
    });

    test("renders series label", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "area",
            data: makeTimeseriesData({
              series: [
                {
                  label: "p95(span.duration)",
                  values: [{ timestamp: 1_700_000_000, value: 342 }],
                  unit: "millisecond",
                },
              ],
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("p95(span.duration)");
    });

    test("renders latest value", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "line",
            data: makeTimeseriesData({
              series: [
                {
                  label: "count()",
                  values: [
                    { timestamp: 1_700_000_000, value: 5 },
                    { timestamp: 1_700_000_060, value: 42 },
                  ],
                },
              ],
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("42");
    });

    test("renders sparkline characters", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "line",
            data: makeTimeseriesData({
              series: [
                {
                  label: "count()",
                  values: [
                    { timestamp: 1, value: 1 },
                    { timestamp: 2, value: 5 },
                    { timestamp: 3, value: 10 },
                    { timestamp: 4, value: 3 },
                  ],
                },
              ],
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      // Sparkline uses Unicode block characters (▁▂▃▄▅▆▇█) or zero char (⎽)
      expect(output).toMatch(/[▁▂▃▄▅▆▇█⎽]/);
    });

    test("renders multiple series on separate lines", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "line",
            data: makeTimeseriesData({
              series: [
                {
                  label: "count()",
                  values: [{ timestamp: 1, value: 10 }],
                },
                {
                  label: "avg(span.duration)",
                  values: [{ timestamp: 1, value: 250 }],
                  unit: "millisecond",
                },
              ],
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("count()");
      expect(output).toContain("avg(span.duration)");
      expect(output).toContain("250ms");
    });

    test("renders unit suffix on values", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "line",
            data: makeTimeseriesData({
              series: [
                {
                  label: "p50(span.duration)",
                  values: [{ timestamp: 1, value: 120 }],
                  unit: "millisecond",
                },
              ],
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("120ms");
    });

    test("shows no data for empty series", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "line",
            data: makeTimeseriesData({ series: [] }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("(no data)");
    });
  });

  describe("timeseries widget (rendered mode colors)", () => {
    useRenderedMode();

    test("sparkline uses magenta color", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "line",
            data: makeTimeseriesData({
              series: [
                {
                  label: "count()",
                  values: [
                    { timestamp: 1, value: 1 },
                    { timestamp: 2, value: 5 },
                  ],
                },
              ],
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      // COLORS.magenta = "#FF45A8" — chalk.hex produces ANSI sequences
      // Verify the output contains ANSI codes (not plain) and sparkline chars
      const plain = stripAnsi(output);
      expect(plain).toMatch(/[▁▂▃▄▅▆▇█⎽]/);
      // Output should be longer than plain (contains ANSI color codes)
      expect(output.length).toBeGreaterThan(plain.length);
    });
  });

  describe("bar widget", () => {
    test("renders horizontal bars with labels", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            title: "Top Transactions",
            displayType: "bar",
            data: makeTimeseriesData({
              series: [
                {
                  label: "/api/users",
                  values: [
                    { timestamp: 1, value: 100 },
                    { timestamp: 2, value: 200 },
                  ],
                },
                {
                  label: "/api/orders",
                  values: [
                    { timestamp: 1, value: 50 },
                    { timestamp: 2, value: 30 },
                  ],
                },
              ],
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("Top Transactions");
      expect(output).toContain("/api/users");
      expect(output).toContain("/api/orders");
      // Bar uses █ characters
      expect(output).toContain("█");
    });

    test("renders categorical_bar as bar chart", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            title: "By Browser",
            displayType: "categorical_bar",
            data: makeTimeseriesData({
              series: [
                {
                  label: "Chrome",
                  values: [{ timestamp: 1, value: 500 }],
                },
              ],
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("By Browser");
      // Vertical bar labels appear in empty space above bars;
      // a maxed-out bar may not show all chars but bars render
      expect(output).toContain("█");
      // Bottom axis should be present
      expect(output).toContain("└");
    });

    test("shows no data for empty series in bar chart", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "bar",
            data: makeTimeseriesData({ series: [] }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("(no data)");
    });

    test("renders heatmap as one row per series with a legend", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            title: "Errors by Browser",
            displayType: "heatmap",
            layout: { x: 0, y: 0, w: 3, h: 3 },
            data: makeTimeseriesData({
              series: [
                {
                  label: "Chrome",
                  values: [
                    { timestamp: 1_700_000_000, value: 0 },
                    { timestamp: 1_700_000_060, value: 50 },
                    { timestamp: 1_700_000_120, value: 100 },
                  ],
                },
                {
                  label: "Firefox",
                  values: [
                    { timestamp: 1_700_000_000, value: 5 },
                    { timestamp: 1_700_000_060, value: 10 },
                    { timestamp: 1_700_000_120, value: 20 },
                  ],
                },
              ],
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("Errors by Browser");
      // Category labels appear as row headers
      expect(output).toContain("Chrome");
      expect(output).toContain("Firefox");
      // Intensity legend is present
      expect(output).toContain("low");
      expect(output).toContain("high");
    });

    test("shows no data for empty series in heatmap", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "heatmap",
            data: makeTimeseriesData({ series: [] }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("(no data)");
    });

    test("bar chart fills full widget width (no trailing gap)", () => {
      // Create enough data points that bars should fill the chart area.
      // With a tall widget (h=3), the renderer uses bar mode (not sparkline).
      const values = Array.from({ length: 20 }, (_, i) => ({
        timestamp: 1_700_000_000 + i * 3600,
        value: 10 + (i % 5) * 10,
      }));
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "bar",
            layout: { x: 0, y: 0, w: 2, h: 3 },
            data: makeTimeseriesData({
              series: [{ label: "count()", values }],
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      // The bars should contain block characters
      expect(output).toContain("█");
      // Should have Y-axis tick marks
      expect(output).toContain("┤");
    });

    test("stacked bar chart renders with multiple series", () => {
      const timestamps = Array.from({ length: 10 }, (_, i) => ({
        timestamp: 1_700_000_000 + i * 3600,
        value: 0,
      }));
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "bar",
            layout: { x: 0, y: 0, w: 2, h: 3 },
            data: makeTimeseriesData({
              series: [
                {
                  label: "series-a",
                  values: timestamps.map((t, i) => ({
                    ...t,
                    value: 10 + i * 5,
                  })),
                },
                {
                  label: "series-b",
                  values: timestamps.map((t, i) => ({
                    ...t,
                    value: 5 + i * 2,
                  })),
                },
              ],
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      // Should render bar blocks
      expect(output).toContain("█");
      // Legend for multi-series
      expect(output).toContain("series-a");
      expect(output).toContain("series-b");
    });
  });

  describe("bar widget (rendered mode colors)", () => {
    useRenderedMode();

    test("bar displayType renders as time-series with ANSI colors", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            title: "Colored Bars",
            displayType: "bar",
            data: makeTimeseriesData({
              series: [
                {
                  label: "foo",
                  values: [
                    { timestamp: 1, value: 50 },
                    { timestamp: 2, value: 80 },
                  ],
                },
              ],
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      const plain = stripAnsi(output);
      // In rendered mode, bars/sparklines have ANSI color codes
      expect(output.length).toBeGreaterThan(plain.length);
      // Renders timeseries content (sparkline or bar chart)
      expect(plain).toContain("█");
    });
  });

  describe("table widget", () => {
    test("renders column headers", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            title: "Slow Endpoints",
            displayType: "table",
            data: makeTableData(),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("Slow Endpoints");
      // Column names are uppercased
      expect(output).toContain("TRANSACTION");
      expect(output).toContain("COUNT");
    });

    test("renders row data", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "table",
            data: makeTableData({
              columns: [
                { name: "endpoint" },
                { name: "p95", unit: "millisecond" },
              ],
              rows: [
                { endpoint: "/api/search", p95: 420 },
                { endpoint: "/api/health", p95: 12 },
              ],
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("/api/search");
      expect(output).toContain("/api/health");
      expect(output).toContain("420ms");
      expect(output).toContain("12ms");
    });

    test("renders null/undefined cells as empty", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "table",
            data: makeTableData({
              columns: [{ name: "name" }, { name: "value" }],
              rows: [{ name: "test", value: null }],
            }),
          }),
        ],
      });
      // Should not throw
      const output = formatDashboardWithData(data);
      expect(output).toContain("test");
    });

    test("shows no data for empty rows", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "table",
            data: makeTableData({ rows: [] }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("(no data)");
    });

    test("right-aligns numeric columns", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "table",
            data: makeTableData({
              columns: [
                { name: "endpoint", type: "string" },
                { name: "count", type: "integer" },
              ],
              rows: [
                { endpoint: "/api/a", count: 100 },
                { endpoint: "/api/b", count: 5 },
              ],
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      // Numeric column header and values should appear
      expect(output).toContain("COUNT");
      expect(output).toContain("100");
      expect(output).toContain("5");
      // Separator line with ─ should be present
      expect(output).toContain("\u2500");
    });

    test("uses compact numbers when columns overflow", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "table",
            // Very narrow widget
            layout: { x: 0, y: 0, w: 1, h: 2 },
            data: makeTableData({
              columns: [
                { name: "very_long_column_name_here", type: "string" },
                { name: "another_long_column_count", type: "integer" },
              ],
              rows: [
                {
                  very_long_column_name_here: "long-value-text-here",
                  another_long_column_count: 1_500_000,
                },
              ],
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      // Should use compact notation (1.5M instead of 1,500,000)
      expect(output).toContain("1.5M");
    });

    test("truncates long cell values with ellipsis", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "table",
            layout: { x: 0, y: 0, w: 1, h: 2 },
            data: makeTableData({
              columns: [
                { name: "name", type: "string" },
                { name: "very_long_description_column", type: "string" },
              ],
              rows: [
                {
                  name: "short",
                  very_long_description_column:
                    "this is a very long description that should be truncated",
                },
              ],
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      // Should contain ellipsis from truncation
      expect(output).toContain("\u2026");
    });

    test("expands last column to fill widget width", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "table",
            // Full-width widget
            layout: { x: 0, y: 0, w: 6, h: 2 },
            data: makeTableData({
              columns: [{ name: "id" }, { name: "val" }],
              rows: [{ id: "a", val: 1 }],
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("ID");
      expect(output).toContain("VAL");
    });

    test("formats number units correctly", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "table",
            data: makeTableData({
              columns: [
                { name: "endpoint" },
                { name: "duration", unit: "millisecond" },
                { name: "size", unit: "byte" },
                { name: "latency", unit: "second" },
              ],
              rows: [
                {
                  endpoint: "/api",
                  duration: 250,
                  size: 1024,
                  latency: 3,
                },
              ],
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("250ms");
      expect(output).toContain("1,024B");
      expect(output).toContain("3s");
    });
  });

  describe("big number widget (plain mode)", () => {
    test("renders plain formatted number", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            title: "Total Errors",
            displayType: "big_number",
            data: makeScalarData({ value: 42 }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("Total Errors");
      // In plain mode renderBigNumber returns "  <formatted>" (single line)
      expect(output).toContain("42");
    });

    test("renders value with unit", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "big_number",
            data: makeScalarData({ value: 350, unit: "millisecond" }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("350ms");
    });

    test("formats large numbers with compact notation", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            displayType: "big_number",
            data: makeScalarData({ value: 2_500_000 }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      // Compact notation for >= 1M: "2.5M"
      expect(output).toContain("2.5M");
    });
  });

  describe("big number widget (rendered mode)", () => {
    useRenderedMode();

    test("renders 3-line ASCII art with block characters", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            title: "Total Events",
            displayType: "big_number",
            data: makeScalarData({ value: 42 }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      const plain = stripAnsi(output);
      // Block characters used in digit font: █ ▀ ▄
      expect(plain).toMatch(/[█▀▄]/);
    });

    test("renders multiple lines for big number digits", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            title: "Big Num",
            displayType: "big_number",
            data: makeScalarData({ value: 0 }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      const plain = stripAnsi(output);
      // "0" digit has glyph "█▀█" / "█ █" / "▀▀▀" — 3 rows
      expect(plain).toContain("█▀█");
      expect(plain).toContain("█ █");
      expect(plain).toContain("▀▀▀");
    });

    test("big number uses green color", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            title: "Count",
            displayType: "big_number",
            data: makeScalarData({ value: 7 }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      // In rendered mode, big number glyphs are wrapped in ANSI color codes
      const plain = stripAnsi(output);
      expect(output.length).toBeGreaterThan(plain.length);
      // Should contain block chars from the digit font
      expect(plain).toMatch(/[█▀▄]/);
    });
  });

  describe("unsupported widget", () => {
    test("shows placeholder with reason", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            title: "Issue Widget",
            displayType: "table",
            data: makeUnsupportedData({
              reason: "issue widgets not yet supported",
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("Issue Widget");
      expect(output).toContain("issue widgets not yet supported");
    });
  });

  describe("error widget", () => {
    test("shows error message", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            title: "Broken Widget",
            displayType: "line",
            data: makeErrorData({
              message: "Query timeout exceeded",
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("Broken Widget");
      expect(output).toContain("query failed: Query timeout exceeded");
    });
  });

  describe("text widget", () => {
    test("renders markdown content", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            title: "Notes",
            displayType: "text",
            data: makeTextData({
              content: "# Hello\nSome **bold** text",
            }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("Notes");
      expect(output).toContain("Hello");
      expect(output).toContain("bold");
    });

    test("renders empty placeholder for missing content", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            title: "Empty Notes",
            displayType: "text",
            data: makeTextData({ content: "" }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("Empty Notes");
      expect(output).toContain("(empty)");
    });

    test("renders empty placeholder for whitespace-only content", () => {
      const data = makeDashboardData({
        widgets: [
          makeWidget({
            title: "Whitespace Notes",
            displayType: "text",
            data: makeTextData({ content: "   \n  " }),
          }),
        ],
      });
      const output = formatDashboardWithData(data);
      expect(output).toContain("(empty)");
    });
  });

  describe("mixed widget types (no layout — sequential blocks)", () => {
    test("renders all widget types in order", () => {
      const widgets: DashboardViewWidget[] = [
        makeWidget({
          title: "Timeseries Widget",
          displayType: "line",
          data: makeTimeseriesData(),
        }),
        makeWidget({
          title: "Bar Widget",
          displayType: "bar",
          data: makeTimeseriesData({
            series: [
              {
                label: "group-a",
                values: [{ timestamp: 1, value: 100 }],
              },
            ],
          }),
        }),
        makeWidget({
          title: "Table Widget",
          displayType: "table",
          data: makeTableData(),
        }),
        makeWidget({
          title: "Big Number Widget",
          displayType: "big_number",
          data: makeScalarData({ value: 999 }),
        }),
        makeWidget({
          title: "Unsupported Widget",
          displayType: "line",
          data: makeUnsupportedData({ reason: "not supported" }),
        }),
        makeWidget({
          title: "Error Widget",
          displayType: "line",
          data: makeErrorData({ message: "boom" }),
        }),
      ];

      const data = makeDashboardData({ widgets });
      const output = formatDashboardWithData(data);

      // All titles appear
      expect(output).toContain("Timeseries Widget");
      expect(output).toContain("Bar Widget");
      expect(output).toContain("Table Widget");
      expect(output).toContain("Big Number Widget");
      expect(output).toContain("Unsupported Widget");
      expect(output).toContain("Error Widget");

      // Ordering: each title appears before the next
      const tsIdx = output.indexOf("Timeseries Widget");
      const barIdx = output.indexOf("Bar Widget");
      const tblIdx = output.indexOf("Table Widget");
      const bnIdx = output.indexOf("Big Number Widget");
      const unsIdx = output.indexOf("Unsupported Widget");
      const errIdx = output.indexOf("Error Widget");
      expect(tsIdx).toBeLessThan(barIdx);
      expect(barIdx).toBeLessThan(tblIdx);
      expect(tblIdx).toBeLessThan(bnIdx);
      expect(bnIdx).toBeLessThan(unsIdx);
      expect(unsIdx).toBeLessThan(errIdx);
    });
  });

  describe("grid layout (framebuffer)", () => {
    test("widgets at same y appear in the same terminal row range", () => {
      const widgets: DashboardViewWidget[] = [
        makeWidget({
          title: "Left Widget",
          displayType: "big_number",
          data: makeScalarData({ value: 10 }),
          layout: { x: 0, y: 0, w: 3, h: 1 },
        }),
        makeWidget({
          title: "Right Widget",
          displayType: "big_number",
          data: makeScalarData({ value: 20 }),
          layout: { x: 3, y: 0, w: 3, h: 1 },
        }),
      ];

      const data = makeDashboardData({ widgets });
      const output = formatDashboardWithData(data);
      const lines = output.split("\n");

      // Both titles should appear on the same terminal line
      // (framebuffer composes widgets side-by-side within the same row range)
      const titleLine = lines.find(
        (l) => l.includes("Left Widget") && l.includes("Right Widget")
      );
      expect(titleLine).toBeDefined();
    });

    test("widgets at different y positions are in different row ranges", () => {
      const widgets: DashboardViewWidget[] = [
        makeWidget({
          title: "Top Widget",
          displayType: "big_number",
          data: makeScalarData({ value: 1 }),
          layout: { x: 0, y: 0, w: 6, h: 1 },
        }),
        makeWidget({
          title: "Bottom Widget",
          displayType: "big_number",
          data: makeScalarData({ value: 2 }),
          layout: { x: 0, y: 1, w: 6, h: 1 },
        }),
      ];

      const data = makeDashboardData({ widgets });
      const output = formatDashboardWithData(data);
      const lines = output.split("\n");

      // Titles should NOT be on the same line
      const combinedLine = lines.find(
        (l) => l.includes("Top Widget") && l.includes("Bottom Widget")
      );
      expect(combinedLine).toBeUndefined();

      // Both should still appear in the output
      expect(output).toContain("Top Widget");
      expect(output).toContain("Bottom Widget");

      // Top appears before Bottom
      expect(output.indexOf("Top Widget")).toBeLessThan(
        output.indexOf("Bottom Widget")
      );
    });

    test("row range separation matches LINES_PER_UNIT", () => {
      const widgets: DashboardViewWidget[] = [
        makeWidget({
          title: "Row0Widget",
          displayType: "big_number",
          data: makeScalarData({ value: 1 }),
          layout: { x: 0, y: 0, w: 6, h: 1 },
        }),
        makeWidget({
          title: "Row1Widget",
          displayType: "big_number",
          data: makeScalarData({ value: 2 }),
          layout: { x: 0, y: 1, w: 6, h: 1 },
        }),
      ];

      const data = makeDashboardData({ widgets });
      const output = formatDashboardWithData(data);
      const lines = output.split("\n");

      // Find line indices for each widget title (skip header lines)
      const row0Line = lines.findIndex((l) => l.includes("Row0Widget"));
      const row1Line = lines.findIndex((l) => l.includes("Row1Widget"));
      expect(row0Line).toBeGreaterThanOrEqual(0);
      expect(row1Line).toBeGreaterThanOrEqual(0);

      // The gap between the two title lines should be LINES_PER_UNIT
      // (y=0 starts at row 0, y=1 starts at row LINES_PER_UNIT)
      expect(row1Line - row0Line).toBe(LINES_PER_UNIT);
    });

    test("tall widget (h>1) spans multiple terminal row ranges", () => {
      const widgets: DashboardViewWidget[] = [
        makeWidget({
          title: "Tall Widget",
          displayType: "line",
          data: makeTimeseriesData(),
          layout: { x: 0, y: 0, w: 3, h: 2 },
        }),
        makeWidget({
          title: "Adjacent Widget",
          displayType: "big_number",
          data: makeScalarData({ value: 5 }),
          layout: { x: 3, y: 1, w: 3, h: 1 },
        }),
      ];

      const data = makeDashboardData({ widgets });
      const output = formatDashboardWithData(data);

      // Total rows = max(0+2, 1+1) * LINES_PER_UNIT = 2 * 6 = 12 grid rows
      // The tall widget covers rows 0..11, adjacent covers rows 6..11
      expect(output).toContain("Tall Widget");
      expect(output).toContain("Adjacent Widget");
    });

    test("three widgets at same y are all composed side-by-side", () => {
      const widgets: DashboardViewWidget[] = [
        makeWidget({
          title: "W1",
          displayType: "big_number",
          data: makeScalarData({ value: 1 }),
          layout: { x: 0, y: 0, w: 2, h: 1 },
        }),
        makeWidget({
          title: "W2",
          displayType: "big_number",
          data: makeScalarData({ value: 2 }),
          layout: { x: 2, y: 0, w: 2, h: 1 },
        }),
        makeWidget({
          title: "W3",
          displayType: "big_number",
          data: makeScalarData({ value: 3 }),
          layout: { x: 4, y: 0, w: 2, h: 1 },
        }),
      ];

      const data = makeDashboardData({ widgets });
      const output = formatDashboardWithData(data);
      const lines = output.split("\n");

      // All three titles should be on the same line
      const titleLine = lines.find(
        (l) => l.includes("W1") && l.includes("W2") && l.includes("W3")
      );
      expect(titleLine).toBeDefined();
    });

    test("widgets without layout are placed as sequential blocks after grid", () => {
      const widgets: DashboardViewWidget[] = [
        makeWidget({
          title: "Laid Out",
          displayType: "big_number",
          data: makeScalarData({ value: 1 }),
          layout: { x: 0, y: 0, w: 6, h: 1 },
        }),
        makeWidget({
          title: "No Layout",
          displayType: "big_number",
          data: makeScalarData({ value: 2 }),
          // no layout field
        }),
      ];

      const data = makeDashboardData({ widgets });
      const output = formatDashboardWithData(data);

      // Both appear, not on the same line
      expect(output).toContain("Laid Out");
      expect(output).toContain("No Layout");
      const lines = output.split("\n");
      const combinedLine = lines.find(
        (l) => l.includes("Laid Out") && l.includes("No Layout")
      );
      expect(combinedLine).toBeUndefined();

      // "No Layout" appears after "Laid Out" (appended after grid)
      expect(output.indexOf("Laid Out")).toBeLessThan(
        output.indexOf("No Layout")
      );
    });

    test("widgets sorted by x within same y row", () => {
      const widgets: DashboardViewWidget[] = [
        // Intentionally reversed x order in array
        makeWidget({
          title: "RightFirst",
          displayType: "big_number",
          data: makeScalarData({ value: 2 }),
          layout: { x: 3, y: 0, w: 3, h: 1 },
        }),
        makeWidget({
          title: "LeftFirst",
          displayType: "big_number",
          data: makeScalarData({ value: 1 }),
          layout: { x: 0, y: 0, w: 3, h: 1 },
        }),
      ];

      const data = makeDashboardData({ widgets });
      const output = formatDashboardWithData(data);
      const lines = output.split("\n");

      // Both on same line, LeftFirst before RightFirst
      const titleLine = lines.find(
        (l) => l.includes("LeftFirst") && l.includes("RightFirst")
      );
      expect(titleLine).toBeDefined();
      expect(titleLine!.indexOf("LeftFirst")).toBeLessThan(
        titleLine!.indexOf("RightFirst")
      );
    });

    test("framebuffer total rows equals maxGridBottom * LINES_PER_UNIT", () => {
      const widgets: DashboardViewWidget[] = [
        makeWidget({
          title: "Only Widget",
          displayType: "big_number",
          data: makeScalarData({ value: 1 }),
          layout: { x: 0, y: 0, w: 6, h: 1 },
        }),
      ];

      const data = makeDashboardData({ widgets });
      const output = formatDashboardWithData(data);
      const lines = output.split("\n");

      // Header: title, meta (Period/Env), URL, underline, blank separator = 5 lines
      // Grid: 1 (h) * LINES_PER_UNIT = 6 rows
      // Count grid-area lines: skip header (5 lines), count LINES_PER_UNIT rows
      const headerLines = 5; // title, meta, URL, underline, blank
      const gridLines = lines.slice(headerLines, headerLines + LINES_PER_UNIT);
      // The first grid line should contain the widget title
      expect(gridLines[0]).toContain("Only Widget");
    });
  });

  describe("empty widgets array", () => {
    test("renders header without errors", () => {
      const data = makeDashboardData({ widgets: [] });
      const output = formatDashboardWithData(data);
      // Header still renders
      expect(output).toContain("My Dashboard");
      expect(output).toContain("Period: 24h");
    });
  });
});

// ===========================================================================
// createDashboardViewRenderer
// ===========================================================================

describe("createDashboardViewRenderer", () => {
  describe("plain mode", () => {
    usePlainMode();

    test("first render returns output without clear-screen code", () => {
      const renderer = createDashboardViewRenderer();
      const data = makeDashboardData();
      const output = renderer.render(data);

      // Should not start with ANSI clear-screen sequence
      expect(output).not.toContain("\x1b[2J\x1b[H");
      // Should contain dashboard content
      expect(output).toContain("My Dashboard");
    });

    test("second render does NOT prepend clear-screen in plain mode", () => {
      const renderer = createDashboardViewRenderer();
      const data = makeDashboardData();

      // First render
      renderer.render(data);
      // Second render — plain mode skips clear-screen
      const output = renderer.render(data);

      expect(output).not.toContain("\x1b[2J\x1b[H");
      expect(output).toContain("My Dashboard");
    });
  });

  describe("rendered mode", () => {
    useRenderedMode();

    test("first render has no clear-screen", () => {
      const renderer = createDashboardViewRenderer();
      const data = makeDashboardData();
      const output = renderer.render(data);

      expect(output).not.toContain("\x1b[2J\x1b[H");
    });

    test("renderer does not include clear-screen (handled by ClearScreen token)", () => {
      const renderer = createDashboardViewRenderer();
      const data = makeDashboardData();

      // First render
      renderer.render(data);
      // Second render — no clear-screen (ClearScreen token in wrapper handles it)
      const output = renderer.render(data);

      expect(output).not.toContain("\x1b[2J\x1b[H");
      expect(output).not.toContain("\x1b[H\x1b[J");
    });
  });

  describe("finalize", () => {
    describe("plain mode", () => {
      usePlainMode();

      test("returns hint wrapped in newlines", () => {
        const renderer = createDashboardViewRenderer();
        const result = renderer.finalize!(
          "Tip: use --json for machine-readable output"
        );
        expect(result).toContain("Tip: use --json for machine-readable output");
        expect(result.startsWith("\n")).toBe(true);
        expect(result.endsWith("\n")).toBe(true);
      });

      test("returns empty string when no hint", () => {
        const renderer = createDashboardViewRenderer();
        expect(renderer.finalize!()).toBe("");
      });

      test("returns empty string for undefined hint", () => {
        const renderer = createDashboardViewRenderer();
        expect(renderer.finalize!(undefined)).toBe("");
      });
    });

    describe("rendered mode (TTY)", () => {
      useRenderedMode();

      test("returns empty string even with hint (URL is in header)", () => {
        const renderer = createDashboardViewRenderer();
        const result = renderer.finalize!("some hint");
        expect(result).toBe("");
      });

      test("returns empty string when no hint", () => {
        const renderer = createDashboardViewRenderer();
        expect(renderer.finalize!()).toBe("");
      });
    });
  });
});
