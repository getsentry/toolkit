/**
 * Dashboard widget renderers
 *
 * Renders actual widget data (time-series, tables, big numbers) for the
 * `dashboard view` command. Uses a framebuffer approach: each widget is
 * rendered into its grid-allocated region of a virtual screen buffer,
 * then the buffer is printed as a single string. This enables correct
 * overlapping layouts where tall widgets span multiple rows.
 */

import chalk from "chalk";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

import type {
  DashboardWidgetQuery,
  ScalarResult,
  TableResult,
  TimeseriesResult,
  WidgetDataResult,
} from "../../types/dashboard.js";
import { encodeImageToKitty } from "../kitty-image.js";
import { logger } from "../logger.js";
import {
  detectSixelCaps,
  type GraphicsFormat,
  type GraphicsRendererPreference,
  graphicsCellSize,
  selectGraphicsFormat,
  terminalPixelWidth,
} from "../sixel.js";
import { SERIES_PALETTE } from "./chart-core.js";
import { COLORS, muted, terminalLink } from "./colors.js";
import { renderMarkdown } from "./markdown.js";
import type { HumanRenderer } from "./output.js";
import { isPlainOutput } from "./plain-detect.js";
import { renderDashboardAsSixel } from "./sixel-dashboard.js";
import { downsample, sparkline } from "./sparkline.js";

// ---------------------------------------------------------------------------
// Data type yielded by dashboard view command
// ---------------------------------------------------------------------------

/** Full dashboard state with resolved widget data, yielded as CommandOutput. */
export type DashboardViewData = {
  id: string;
  title: string;
  period: string;
  fetchedAt: string;
  url: string;
  dateCreated?: string;
  environment?: string[];
  /** Renderer selected by --renderer; omitted for API/JSON output. */
  rendererPreference?: GraphicsRendererPreference;
  /** Whether the default high-DPI graphics width cap should apply. */
  graphicsCap?: boolean;
  widgets: DashboardViewWidget[];
};

/** A widget with its resolved data result */
export type DashboardViewWidget = {
  title: string;
  displayType: string;
  widgetType?: string;
  /** Markdown content for text widgets (from API passthrough field) */
  description?: string;
  layout?: { x: number; y: number; w: number; h: number };
  queries?: DashboardWidgetQuery[];
  data: WidgetDataResult;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sentry dashboard grid columns */
const GRID_COLS = 6;

/** Terminal lines per grid height unit */
const LINES_PER_UNIT = 6;

/** Minimum terminal width — floor for very narrow terminals or piped output */
const MIN_TERM_WIDTH = 80;

/** Fallback terminal width when stdout is not a TTY */
const DEFAULT_TERM_WIDTH = 100;

/** Default graphics canvas cap for high-DPI terminals. */
const MAX_GRAPHICS_WIDTH = 2560;

/**
 * Get the effective terminal width.
 *
 * Uses the actual terminal column count when available (TTY),
 * falls back to DEFAULT_TERM_WIDTH for piped/redirected output.
 * Clamped to MIN_TERM_WIDTH to prevent broken layouts.
 */
function getTermWidth(): number {
  const cols = process.stdout.columns;
  if (cols && cols > 0) {
    return Math.max(MIN_TERM_WIDTH, cols);
  }
  return DEFAULT_TERM_WIDTH;
}

/** Actual terminal width for pixel-exact sixel output, without ASCII's floor. */
function getSixelTermWidth(): number | undefined {
  const columns = process.stdout.columns;
  return columns && columns > 0 ? columns : undefined;
}

// ---------------------------------------------------------------------------
// Big number ASCII art font
// ---------------------------------------------------------------------------

/** Small font: 3 lines tall, 3 chars wide per glyph. */
const DIGIT_FONT_SM: Record<string, string[]> = {
  "0": ["█▀█", "█ █", "▀▀▀"],
  "1": [" ▄█", "  █", "  ▀"],
  "2": ["▀▀█", "▄▀▀", "▀▀▀"],
  "3": ["▀▀█", " ▀█", "▀▀▀"],
  "4": ["█ █", "▀▀█", "  ▀"],
  "5": ["█▀▀", "▀▀█", "▀▀▀"],
  "6": ["█▀▀", "█▀█", "▀▀▀"],
  "7": ["▀▀█", "  █", "  ▀"],
  "8": ["█▀█", "█▀█", "▀▀▀"],
  "9": ["█▀█", "▀▀█", "▀▀▀"],
  ".": ["   ", "   ", " ▀ "],
  "-": ["   ", "▀▀▀", "   "],
  K: ["█ █", "██ ", "█ █"],
  M: ["█▄█", "█ █", "█ █"],
  B: ["██ ", "██▄", "▀▀▀"],
  T: ["▀█▀", " █ ", " ▀ "],
};

/** Medium font: 5 lines tall, 5 chars wide per glyph. */
const DIGIT_FONT_MD: Record<string, string[]> = {
  "0": ["█████", "██ ██", "██ ██", "██ ██", "█████"],
  "1": [" ▄███", "   ██", "   ██", "   ██", "   ██"],
  "2": ["█████", "   ██", "█████", "██   ", "█████"],
  "3": ["█████", "   ██", " ████", "   ██", "█████"],
  "4": ["██ ██", "██ ██", "█████", "   ██", "   ██"],
  "5": ["█████", "██   ", "█████", "   ██", "█████"],
  "6": ["█████", "██   ", "█████", "██ ██", "█████"],
  "7": ["█████", "   ██", "   ██", "  ██ ", "  ██ "],
  "8": ["█████", "██ ██", "█████", "██ ██", "█████"],
  "9": ["█████", "██ ██", "█████", "   ██", "█████"],
  ".": ["     ", "     ", "     ", "     ", " ██  "],
  "-": ["     ", "     ", "█████", "     ", "     "],
  K: ["██ ██", "████ ", "███  ", "████ ", "██ ██"],
  M: ["██ ██", "█████", "█████", "██▀██", "██ ██"],
  B: ["████ ", "██ ██", "████ ", "██ ██", "████ "],
  T: ["█████", "  ██ ", "  ██ ", "  ██ ", "  ██ "],
};

/** Large font: 7 lines tall, 7 chars wide per glyph. */
const DIGIT_FONT_LG: Record<string, string[]> = {
  "0": [
    "███████",
    "██   ██",
    "██   ██",
    "██   ██",
    "██   ██",
    "██   ██",
    "███████",
  ],
  "1": [
    "  ▄████",
    "     ██",
    "     ██",
    "     ██",
    "     ██",
    "     ██",
    "     ██",
  ],
  "2": [
    "███████",
    "     ██",
    "     ██",
    "███████",
    "██     ",
    "██     ",
    "███████",
  ],
  "3": [
    "███████",
    "     ██",
    "     ██",
    " ██████",
    "     ██",
    "     ██",
    "███████",
  ],
  "4": [
    "██   ██",
    "██   ██",
    "██   ██",
    "███████",
    "     ██",
    "     ██",
    "     ██",
  ],
  "5": [
    "███████",
    "██     ",
    "██     ",
    "███████",
    "     ██",
    "     ██",
    "███████",
  ],
  "6": [
    "███████",
    "██     ",
    "██     ",
    "███████",
    "██   ██",
    "██   ██",
    "███████",
  ],
  "7": [
    "███████",
    "     ██",
    "     ██",
    "    ██ ",
    "   ██  ",
    "   ██  ",
    "   ██  ",
  ],
  "8": [
    "███████",
    "██   ██",
    "██   ██",
    "███████",
    "██   ██",
    "██   ██",
    "███████",
  ],
  "9": [
    "███████",
    "██   ██",
    "██   ██",
    "███████",
    "     ██",
    "     ██",
    "███████",
  ],
  K: [
    "██   ██",
    "██  ██ ",
    "█████  ",
    "████   ",
    "█████  ",
    "██  ██ ",
    "██   ██",
  ],
  M: [
    "██   ██",
    "███ ███",
    "███████",
    "███████",
    "██ █ ██",
    "██   ██",
    "██   ██",
  ],
  ".": [
    "       ",
    "       ",
    "       ",
    "       ",
    "       ",
    "  ███  ",
    "  ███  ",
  ],
  "-": [
    "       ",
    "       ",
    "       ",
    "███████",
    "       ",
    "       ",
    "       ",
  ],
  B: [
    "██████ ",
    "██   ██",
    "██   ██",
    "██████ ",
    "██   ██",
    "██   ██",
    "██████ ",
  ],
  T: [
    "███████",
    "  ███  ",
    "  ███  ",
    "  ███  ",
    "  ███  ",
    "  ███  ",
    "  ███  ",
  ],
};

/** Build glyph row arrays from a formatted string and font. */
function buildGlyphRows(
  formatted: string,
  font: Record<string, string[]>
): string[][] {
  const sampleGlyph = font["0"];
  const numRows = sampleGlyph?.length ?? 3;
  const glyphW = sampleGlyph?.[0]?.length ?? 3;
  const blank = " ".repeat(glyphW);

  const rows: string[][] = Array.from({ length: numRows }, () => []);
  for (const ch of formatted) {
    const glyph = font[ch];
    for (let r = 0; r < numRows; r += 1) {
      rows[r]?.push(glyph?.[r] ?? blank);
    }
  }
  return rows;
}

/**
 * Render a formatted number using a glyph font, centered horizontally.
 */
function renderBigNumber(opts: {
  formatted: string;
  font: Record<string, string[]>;
  innerWidth: number;
}): string[] {
  const { formatted, font, innerWidth } = opts;
  if (isPlainOutput()) {
    return [formatted];
  }

  const sampleGlyph = font["0"];
  const glyphW = sampleGlyph?.[0]?.length ?? 3;
  const rows = buildGlyphRows(formatted, font);

  const color = chalk.hex(COLORS.green);
  const rawWidth = formatted.length * (glyphW + 1) - 1;
  const leftPad = Math.max(0, Math.floor((innerWidth - rawWidth) / 2));
  const pad = " ".repeat(leftPad);
  return rows.map((row) => `${pad}${color(row.join(" "))}`);
}

/**
 * Calculate the visual width of a rendered number for a given font.
 * Each glyph is `glyphWidth` chars wide + 1 space between glyphs.
 */
function calcGlyphWidth(formatted: string, glyphW: number): number {
  return formatted.length * (glyphW + 1) - 1;
}

// ---------------------------------------------------------------------------
// Number formatting — shared helpers live in numbers.ts, dashboard-only
// helpers remain here.
// ---------------------------------------------------------------------------

import {
  compactFormatter,
  formatCompactWithUnit,
  formatWithUnit,
} from "./numbers.js";

/**
 * Format a value as a short Y-axis tick label (max ~4 chars).
 *
 * Always uses compact notation: 0 → "0", 500 → "500", 1234 → "1.2K",
 * 23454 → "23K", 321305 → "321K", 1500000 → "1.5M".
 * Rounds the input to avoid fractional mid-point ticks.
 */
function formatTickLabel(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) {
    return "0";
  }
  return compactFormatter.format(rounded);
}

/**
 * Format a big number value with clean integer display.
 * Uses compact notation (K, M, B, T) only for values >= 10,000.
 * Below that threshold, shows the raw integer without commas.
 */
function formatBigNumberValue(value: number): string {
  if (Math.abs(value) >= 10_000) {
    return compactFormatter.format(value);
  }
  return Math.round(value).toString();
}

// ---------------------------------------------------------------------------
// Sort helper: descending by value, "Other" always last
// ---------------------------------------------------------------------------

type BarItem = { label: string; total: number; unit?: string | null };

/** Sort items by value descending, "Other" pinned to end. */
function sortBarItems(items: BarItem[]): BarItem[] {
  return [...items].sort((a, b) => {
    if (a.label === "Other") {
      return 1;
    }
    if (b.label === "Other") {
      return -1;
    }
    return b.total - a.total;
  });
}

// ---------------------------------------------------------------------------
// Border wrapping
// ---------------------------------------------------------------------------

/** Border characters for rounded box-drawing. */
const BORDER = {
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  h: "─",
  v: "│",
} as const;

/**
 * Apply muted color to border characters in rendered mode.
 * In plain mode, return the text unchanged.
 */
function borderColor(text: string): string {
  return isPlainOutput() ? text : muted(text);
}

/**
 * Build the top border line with an embedded title.
 *
 * Format: `╭─ Title ─────────╮`
 * The title is bold in rendered mode, plain otherwise.
 */
function buildTopBorder(title: string, width: number): string {
  const plain = isPlainOutput();
  const titleText = plain ? title : chalk.bold(title);
  // Build left part: ╭─ Title ─
  const leftRaw = `${BORDER.tl}${BORDER.h} `;
  const left = `${borderColor(leftRaw)}${titleText} `;
  // Measure visual width so far, fill remaining space with ─, then ╮
  const leftWidth = stringWidth(left);
  const fillLen = Math.max(0, width - leftWidth - 1); // -1 for closing ╮
  return left + borderColor(`${BORDER.h.repeat(fillLen)}${BORDER.tr}`);
}

/** Build the bottom border line: `╰──────────╯` */
function buildBottomBorder(width: number): string {
  return borderColor(
    `${BORDER.bl}${BORDER.h.repeat(Math.max(0, width - 2))}${BORDER.br}`
  );
}

/** Wrap a content line with left/right borders: `│ content  │` */
function buildBorderedLine(content: string, innerWidth: number): string {
  const padded = fitToWidth(content, innerWidth);
  return `${borderColor(BORDER.v)} ${padded} ${borderColor(BORDER.v)}`;
}

/**
 * Wrap content lines inside a bordered box with a title.
 *
 * The output has exactly `totalHeight` lines:
 * - 1 top border (with embedded title)
 * - totalHeight - 2 content lines (padded or truncated)
 * - 1 bottom border
 */
function wrapInBorder(opts: {
  title: string;
  contentLines: string[];
  width: number;
  totalHeight: number;
}): string[] {
  const { title, contentLines, width, totalHeight } = opts;
  const innerWidth = Math.max(0, width - 4);
  const contentSlots = Math.max(0, totalHeight - 2);

  const lines: string[] = [buildTopBorder(title, width)];

  for (let i = 0; i < contentSlots; i += 1) {
    const content =
      (i < contentLines.length ? contentLines[i] : undefined) ?? "";
    lines.push(buildBorderedLine(content, innerWidth));
  }

  lines.push(buildBottomBorder(width));
  return lines;
}

// ---------------------------------------------------------------------------
// Per-widget renderers — return string[] (content lines, no title/border)
// ---------------------------------------------------------------------------

/** Placeholder for empty data. */
function noDataLine(): string {
  return isPlainOutput() ? "(no data)" : muted("(no data)");
}

/**
 * Render timeseries content as sparklines (no title/border).
 * Labels and sparklines are constrained to fit within the inner width.
 */
function renderTimeseriesContent(
  data: TimeseriesResult,
  innerWidth: number
): string[] {
  if (data.series.length === 0) {
    return [noDataLine()];
  }

  const lines: string[] = [];
  const maxValueLen = 10;
  const sparkWidth = Math.max(8, Math.min(innerWidth - 16, 40));
  const maxLabelLen = Math.max(4, innerWidth - sparkWidth - maxValueLen - 4);

  for (const s of data.series) {
    const values = s.values.map((v) => v.value);
    const graph = sparkline(values, sparkWidth);
    const latest = values.length > 0 ? (values.at(-1) ?? 0) : 0;
    const formatted = formatWithUnit(latest, s.unit);
    const label =
      s.label.length > maxLabelLen
        ? `${s.label.slice(0, maxLabelLen - 1)}…`
        : s.label.padEnd(maxLabelLen);

    if (isPlainOutput()) {
      lines.push(`${label} ${graph} ${formatted}`);
    } else {
      lines.push(
        `${chalk.hex(COLORS.cyan)(label)} ${chalk.hex(COLORS.magenta)(graph)} ${chalk.bold(formatted)}`
      );
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Y-axis helpers
// ---------------------------------------------------------------------------

/**
 * Calculate Y-axis gutter width based on the widest tick label.
 *
 * Checks all three tick positions (max, mid, 0) because the mid-point
 * can produce a wider label than the max (e.g., 7K vs 3.5K).
 * Returns the width needed for "3.5K ┤" including the tick char and space.
 */
function yAxisGutterWidth(maxVal: number): number {
  const labels = [
    formatTickLabel(maxVal),
    formatTickLabel(maxVal / 2),
    formatTickLabel(0),
  ];
  const widest = Math.max(...labels.map((l) => l.length));
  return widest + 2; // value + " " + "┤"/"│"
}

/**
 * Build a Y-axis segment for a given row.
 *
 * Shows tick labels at top, middle, and bottom positions.
 * Other rows show a plain axis line.
 *
 * @param row - Current row (1 = bottom, maxHeight = top)
 * @param maxHeight - Total bar height in rows
 * @param maxVal - Maximum data value (for tick labels)
 * @param gutterWidth - Width of the gutter (from yAxisGutterWidth)
 */
function buildYAxisSegment(opts: {
  row: number;
  maxHeight: number;
  maxVal: number;
  gutterWidth: number;
}): string {
  const { row, maxHeight, maxVal, gutterWidth } = opts;
  const plain = isPlainOutput();
  const midRow = Math.round(maxHeight / 2);
  const labelWidth = gutterWidth - 2; // space for " ┤" or " │"

  let label = "";
  let isTick = false;

  if (row === maxHeight) {
    label = formatTickLabel(maxVal);
    isTick = true;
  } else if (row === 1) {
    // Check bottom before mid — when maxHeight=2, midRow is also 1
    label = "0";
    isTick = true;
  } else if (row === midRow) {
    label = formatTickLabel(maxVal / 2);
    isTick = true;
  }

  if (isTick) {
    const padded = label.padStart(labelWidth);
    const tick = `${padded} ┤`;
    return plain ? tick : muted(tick);
  }

  const padded = " ".repeat(labelWidth);
  const axis = `${padded} │`;
  return plain ? axis : muted(axis);
}

// ---------------------------------------------------------------------------
// Vertical bar chart helpers
// ---------------------------------------------------------------------------

/**
 * Render categorical_bar content with vertical bars (no title/border).
 *
 * Labels use two modes:
 * - **Direct**: When labels fit within barWidth (e.g., "US", "bun"),
 *   they appear directly below the bars — clean and readable.
 * - **Legend**: When labels are too long (e.g., "sentry.issue.view"),
 *   letter keys (A, B, C...) appear below bars with a compact legend
 *   line at the bottom: "A:sentry.issue.view B:sentry.api …"
 */
function renderVerticalBarsContent(
  data: TimeseriesResult,
  opts: { innerWidth: number; contentHeight: number }
): string[] {
  const { innerWidth, contentHeight } = opts;
  if (data.series.length === 0) {
    return [noDataLine()];
  }

  let items: BarItem[] = data.series.map((s) => ({
    label: s.label,
    total: s.values.reduce((sum, v) => sum + v.value, 0),
    unit: s.unit,
  }));
  items = sortBarItems(items);

  // Exclude "Other" from scale normalization — it often dominates and
  // makes all real bars invisible. Cap Other's bar at max height.
  const nonOther = items.filter((i) => i.label !== "Other");
  const maxVal = Math.max(
    ...nonOther.map((i) => i.total),
    ...(nonOther.length === 0 ? items.map((i) => i.total) : []),
    1
  );
  // Y-axis gutter
  const gutterW = yAxisGutterWidth(maxVal);
  const chartWidth = innerWidth - gutterW;

  const gap = 1;
  const numItems = items.length;
  const barWidth = Math.max(
    1,
    Math.floor((chartWidth - (numItems - 1) * gap) / numItems)
  );

  // Check if non-Other labels fit directly below bars
  const nonOtherLabels = nonOther.length > 0 ? nonOther : items;
  const maxLabelLen = Math.max(...nonOtherLabels.map((i) => i.label.length));
  const labelsDirectlyFit = maxLabelLen <= barWidth;

  // Reserve lines: 1 axis + 1 label/legend
  const footerLines = 2;
  const maxBarHeight = Math.max(1, contentHeight - footerLines);

  const lines: string[] = [];
  const plain = isPlainOutput();

  // Render bar rows with Y-axis ticks
  for (let row = maxBarHeight; row >= 1; row -= 1) {
    const yAxis = buildYAxisSegment({
      row,
      maxHeight: maxBarHeight,
      maxVal,
      gutterWidth: gutterW,
    });
    const barLine = renderVBarRow(items, {
      row,
      maxVal,
      barWidth,
      gap,
      maxBarHeight,
    });
    lines.push(`${yAxis}${barLine}`);
  }

  // Bottom axis line
  const axisLine = `${" ".repeat(gutterW - 1)}└${"─".repeat(chartWidth)}`;
  lines.push(plain ? axisLine : muted(axisLine));

  // Labels below axis
  const gutterPad = " ".repeat(gutterW);
  if (labelsDirectlyFit) {
    const labelParts = items.map((item) => {
      let text = item.label;
      if (text === "Other" && text.length > barWidth) {
        text = "Oth";
      }
      const lbl = text.padEnd(barWidth);
      return plain ? lbl : muted(lbl);
    });
    lines.push(`${gutterPad}${labelParts.join(" ".repeat(gap))}`);
  } else {
    // Color/fill-keyed legend line
    const entries = items.map((item, i) => ({ label: item.label, index: i }));
    lines.push(`${gutterPad}${buildColorLegend(entries, chartWidth)}`);
  }

  return lines;
}

/** Render one row of the vertical bar chart with per-bar colors. */
function renderVBarRow(
  items: BarItem[],
  opts: {
    row: number;
    maxVal: number;
    barWidth: number;
    gap: number;
    maxBarHeight: number;
  }
): string {
  const plain = isPlainOutput();
  const parts: string[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item) {
      continue;
    }
    const barHeight = Math.round(
      (item.total / opts.maxVal) * opts.maxBarHeight
    );
    if (barHeight >= opts.row) {
      const fill = plain ? seriesFill(item.label, i) : "█";
      const bar = fill.repeat(opts.barWidth);
      parts.push(plain ? bar : chalk.hex(seriesColor(item.label, i))(bar));
    } else {
      parts.push(" ".repeat(opts.barWidth));
    }
  }
  return parts.join(" ".repeat(opts.gap));
}

/**
 * Build a compact color/fill-keyed legend line.
 *
 * Color mode: `■ label1  ■ label2  ■ lab…` (each ■ matches series color)
 * Plain mode: `█ label1  ▓ label2  ░ lab…` (fill chars match bars)
 *
 * Truncated to fit within maxWidth.
 */
function buildColorLegend(
  entries: { label: string; index: number }[],
  maxWidth: number
): string {
  const plain = isPlainOutput();
  const parts: string[] = [];
  let totalLen = 0;

  for (const { label: rawLabel, index } of entries) {
    const label = rawLabel.length > 18 ? `${rawLabel.slice(0, 16)}…` : rawLabel;
    const fill = seriesFill(rawLabel, index);
    const entry = plain
      ? `${fill} ${label}`
      : `${chalk.hex(seriesColor(rawLabel, index))("■")} ${label}`;
    const entryLen = 2 + label.length;
    const addedLen = totalLen > 0 ? entryLen + 2 : entryLen;

    if (totalLen + addedLen > maxWidth) {
      break;
    }
    parts.push(entry);
    totalLen += addedLen;
  }

  return parts.join("  ");
}

/** Gap (in columns) between table columns. */
const TABLE_COL_GAP = 2;

/** Measure the max visual width of each column across headers and rows. */
function measureTableColWidths(
  headers: string[],
  cellRows: string[][]
): number[] {
  return headers.map((h, i) => {
    let maxW = stringWidth(h);
    for (const row of cellRows) {
      maxW = Math.max(maxW, stringWidth(row[i] ?? ""));
    }
    return maxW;
  });
}

/**
 * Rewrite numeric cells in-place using compact notation (10,000 → 10K).
 * Only touches columns whose raw value is a number.
 */
function compactifyTableNumbers(cellRows: string[][], data: TableResult): void {
  for (let ri = 0; ri < data.rows.length; ri++) {
    const row = cellRows[ri];
    if (!row) {
      continue;
    }
    for (let ci = 0; ci < data.columns.length; ci++) {
      const col = data.columns[ci];
      if (!col) {
        continue;
      }
      const val = data.rows[ri]?.[col.name];
      if (typeof val === "number") {
        row[ci] = formatCompactWithUnit(val, col.unit);
      }
    }
  }
}

/** Fit a cell to its column width, padding or truncating with "\u2026". */
function fitTableCell(text: string, width: number, right: boolean): string {
  const w = stringWidth(text);
  if (w <= width) {
    const pad = " ".repeat(width - w);
    return right ? pad + text : text + pad;
  }
  // Truncate: walk chars to fit width - 1, then append "\u2026"
  let result = "";
  let used = 0;
  for (const ch of text) {
    const cw = stringWidth(ch);
    if (used + cw + 1 > width) {
      break;
    }
    result += ch;
    used += cw;
  }
  result += "\u2026";
  used = stringWidth(result);
  const remaining = Math.max(0, width - used);
  return right
    ? " ".repeat(remaining) + result
    : result + " ".repeat(remaining);
}

/**
 * Render table content as aligned text columns (no title/border).
 *
 * Produces one line per header/separator/row. Column widths are sized to
 * fit content, compacted and shrunk if they exceed `innerWidth`, then
 * expanded to fill remaining space. Numeric columns are right-aligned.
 */
function renderTableContent(data: TableResult, innerWidth: number): string[] {
  if (data.rows.length === 0) {
    return [noDataLine()];
  }

  const plain = isPlainOutput();
  const headers = data.columns.map((c) => c.name.toUpperCase());

  // Build plain text cell values
  const cellRows: string[][] = data.rows.map((row) =>
    data.columns.map((col) => {
      const val = row[col.name];
      if (val === null || val === undefined) {
        return "";
      }
      if (typeof val === "number") {
        return formatWithUnit(val, col.unit);
      }
      return String(val);
    })
  );

  // Detect right-aligned (numeric) columns
  const rightAlign = data.columns.map(
    (col, ci) =>
      cellRows.length > 0 &&
      cellRows.every((_, ri) => {
        const v = cellRows[ri]?.[ci] ?? "";
        return v === "" || typeof data.rows[ri]?.[col.name] === "number";
      })
  );

  const colWidths = measureTableColWidths(headers, cellRows);
  const totalGap = TABLE_COL_GAP * Math.max(0, colWidths.length - 1);

  // When columns overflow, try compact number formatting before shrinking
  if (colWidths.reduce((s, w) => s + w, 0) + totalGap > innerWidth) {
    compactifyTableNumbers(cellRows, data);
    const remeasured = measureTableColWidths(headers, cellRows);
    for (let i = 0; i < colWidths.length; i++) {
      colWidths[i] = remeasured[i] ?? 0;
    }
  }

  // Shrink columns proportionally if still exceeds innerWidth
  const totalNatural = colWidths.reduce((s, w) => s + w, 0) + totalGap;
  if (totalNatural > innerWidth && colWidths.length > 0) {
    const available = Math.max(colWidths.length * 3, innerWidth - totalGap);
    const scale = available / colWidths.reduce((s, w) => s + w, 0);
    for (let i = 0; i < colWidths.length; i++) {
      colWidths[i] = Math.max(3, Math.floor((colWidths[i] ?? 0) * scale));
    }
  }

  // Expand last column to fill remaining widget width
  const totalUsed = colWidths.reduce((s, w) => s + w, 0) + totalGap;
  if (totalUsed < innerWidth && colWidths.length > 0) {
    const lastIdx = colWidths.length - 1;
    colWidths[lastIdx] = (colWidths[lastIdx] ?? 0) + (innerWidth - totalUsed);
  }

  const gap = " ".repeat(TABLE_COL_GAP);

  const headerLine = headers
    .map((h, i) => fitTableCell(h, colWidths[i] ?? 3, rightAlign[i] ?? false))
    .join(gap);

  const sepLine = colWidths.map((w) => "\u2500".repeat(w)).join(gap);

  const dataLines = cellRows.map((row) =>
    row
      .map((cell, i) =>
        fitTableCell(cell, colWidths[i] ?? 3, rightAlign[i] ?? false)
      )
      .join(gap)
  );

  return [
    plain ? headerLine : chalk.bold(headerLine),
    plain ? sepLine : muted(sepLine),
    ...dataLines,
  ];
}

/** Center lines vertically, returning a padded array. */
function centerVertically(lines: string[], contentHeight: number): string[] {
  // Use ceil to bias slightly downward — looks better below the title border
  const topPad = Math.max(0, Math.ceil((contentHeight - lines.length) / 2));
  const result: string[] = [];
  for (let i = 0; i < topPad; i += 1) {
    result.push("");
  }
  result.push(...lines);
  return result;
}

/**
 * Render big_number content with auto-scaling font (no title/border).
 *
 * Tries fonts: large (7×7) → medium (5×5) → small (3×3) → single-line.
 * Each font is used only if it fits both width and height.
 * Content is centered both horizontally and vertically.
 */
function renderBigNumberContent(
  data: ScalarResult,
  opts: { innerWidth: number; contentHeight: number }
): string[] {
  const { innerWidth, contentHeight } = opts;
  const formatted = formatBigNumberValue(data.value);

  if (!isPlainOutput()) {
    const result = tryBigNumberFonts(formatted, innerWidth, contentHeight);
    if (result) {
      return result;
    }
  }

  // Single-line fallback — center both ways
  const withUnit = formatWithUnit(data.value, data.unit);
  const display = isPlainOutput() ? withUnit : chalk.bold(withUnit);
  const displayWidth = stringWidth(display);
  const leftPad = Math.max(0, Math.floor((innerWidth - displayWidth) / 2));
  return centerVertically([" ".repeat(leftPad) + display], contentHeight);
}

/**
 * Try rendering a big number with progressively smaller fonts.
 *
 * Tiers: large (7-line) → medium (5-line) → small (3-line).
 * Each font is used only if it fits the available width and height.
 */
function tryBigNumberFonts(
  formatted: string,
  innerWidth: number,
  contentHeight: number
): string[] | undefined {
  // Font tiers: [font, glyphWidth, minContentHeight]
  const tiers: [Record<string, string[]>, number, number][] = [
    [DIGIT_FONT_LG, 7, 9], // 7-line font needs ≥9 for centering
    [DIGIT_FONT_MD, 5, 7], // 5-line font needs ≥7
    [DIGIT_FONT_SM, 3, 3], // 3-line font works in tight spaces
  ];

  for (const [font, glyphW, minHeight] of tiers) {
    const width = calcGlyphWidth(formatted, glyphW);
    if (width <= innerWidth && contentHeight >= minHeight) {
      const bigLines = renderBigNumber({ formatted, font, innerWidth });
      return centerVertically(bigLines, contentHeight);
    }
  }

  return;
}

/**
 * Render a timeseries as a vertical bar chart filling the available height.
 * Used when contentHeight >= 8 (enough room for meaningful bars).
 * Each time bucket gets a column; shows series label + max value at top.
 */
function renderTimeseriesBarsContent(
  data: TimeseriesResult,
  opts: { innerWidth: number; contentHeight: number }
): string[] {
  const { innerWidth, contentHeight } = opts;
  if (data.series.length === 0) {
    return [noDataLine()];
  }

  const isMulti = data.series.length > 1;

  // Aggregate for totals and timestamps
  const aggregated = aggregateTimeseriesValues(data);
  if (aggregated.values.length === 0) {
    return [noDataLine()];
  }

  const { values, timestamps, label, unit, latest, maxVal } = aggregated;

  // Header: series label + latest value
  const headerLabel = label.length > 20 ? `${label.slice(0, 18)}…` : label;
  const valStr = formatWithUnit(latest, unit);
  const headerLine = isPlainOutput()
    ? `${headerLabel}  ${valStr}`
    : `${chalk.hex(COLORS.cyan)(headerLabel)}  ${chalk.bold(valStr)}`;

  const lines: string[] = [headerLine];

  // Y-axis gutter
  const gutterW = yAxisGutterWidth(maxVal);
  const chartWidth = innerWidth - gutterW;

  // Reserve: 1 header + 2 axis/time labels + 1 legend (multi-series only)
  const reservedLines = isMulti ? 4 : 3;
  const barHeight = Math.max(3, contentHeight - reservedLines);
  const maxBars = Math.max(1, chartWidth);
  const sampledTs = downsampleTimestamps(timestamps, maxBars);

  if (isMulti) {
    // Stacked multi-color bars: downsample each series independently
    const stackedSeries = data.series.map((s) => ({
      label: s.label,
      values: downsample(
        s.values.map((v) => v.value),
        maxBars
      ),
    }));
    lines.push(
      ...renderStackedTimeBarRows(stackedSeries, {
        maxVal,
        barHeight,
        gutterWidth: gutterW,
        chartWidth,
      })
    );
  } else {
    const sampled = downsample(values, maxBars);
    lines.push(
      ...renderTimeBarRows(sampled, {
        maxVal,
        barHeight,
        gutterWidth: gutterW,
        chartWidth,
      })
    );
  }

  // Bottom axis with tick marks + time labels
  lines.push(
    ...buildTimeAxis({
      timestamps: sampledTs,
      chartWidth,
      gutterWidth: gutterW,
    })
  );

  // Color legend for multi-series (below time labels)
  if (isMulti) {
    const entries = data.series.map((s, i) => ({ label: s.label, index: i }));
    const legend = buildColorLegend(entries, chartWidth);
    lines.push(`${" ".repeat(gutterW)}${legend}`);
  }

  return lines;
}

/**
 * Aggregate all timeseries into a single values array.
 *
 * For multi-series data (e.g., Errors grouped by title), sums all series
 * per time bucket. Returns the aggregate values, label, and stats.
 */
/** Aggregated timeseries result with timestamps preserved. */
type AggregatedTimeseries = {
  values: number[];
  timestamps: number[];
  label: string;
  unit?: string | null;
  latest: number;
  maxVal: number;
};

function aggregateTimeseriesValues(
  data: TimeseriesResult
): AggregatedTimeseries {
  const first = data.series[0];
  if (!first || first.values.length === 0) {
    return { values: [], timestamps: [], label: "", latest: 0, maxVal: 1 };
  }

  const timestamps = first.values.map((v) => v.timestamp);

  // Single series — use directly
  if (data.series.length === 1) {
    const values = first.values.map((v) => v.value);
    return {
      values,
      timestamps,
      label: first.label,
      unit: first.unit,
      latest: values.at(-1) ?? 0,
      maxVal: Math.max(...values, 1),
    };
  }

  // Multiple series — sum per time bucket
  const bucketCount = first.values.length;
  const summed = new Array<number>(bucketCount).fill(0);
  for (const s of data.series) {
    for (let i = 0; i < s.values.length; i += 1) {
      const point = s.values[i];
      if (point) {
        summed[i] = (summed[i] ?? 0) + point.value;
      }
    }
  }
  const label = `${data.series.length} series`;
  return {
    values: summed,
    timestamps,
    label,
    unit: first.unit,
    latest: summed.at(-1) ?? 0,
    maxVal: Math.max(...summed, 1),
  };
}

/**
 * Fractional block characters for smooth bar tops.
 * Index 0 = empty, 8 = full block. Indices 1-7 are increasing fill.
 */
const FRAC_BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * Build a single column character for a time-series bar at a given row.
 * Uses fractional blocks for the top-of-bar row to create smooth edges.
 *
 * @param fractionalHeight - The bar's height in fractional rows (0-barHeight)
 * @param row - The current row being rendered (1 = bottom, barHeight = top)
 */
function buildTimeseriesBarColumn(
  fractionalHeight: number,
  row: number
): string {
  if (fractionalHeight >= row) {
    return "█";
  }
  // Fractional top: this row is partially filled
  const fraction = fractionalHeight - (row - 1);
  if (fraction > 0) {
    const idx = Math.round(fraction * 8);
    return FRAC_BLOCKS[Math.min(idx, 8)] ?? " ";
  }
  return " ";
}

/** Render time-series bar rows with smooth fractional block tops and Y-axis. */
function renderTimeBarRows(
  sampled: number[],
  opts: {
    maxVal: number;
    barHeight: number;
    gutterWidth: number;
    chartWidth: number;
  }
): string[] {
  const { maxVal, barHeight, gutterWidth, chartWidth } = opts;
  const plain = isPlainOutput();
  const colorFn = plain
    ? (s: string) => s
    : (s: string) => chalk.hex(COLORS.magenta)(s);
  const rows: string[] = [];

  // Scale bar width so bars fill the full chart area.
  // Distribute the floor-division remainder across the first N bars
  // so the total rendered width exactly equals chartWidth.
  const barWidth = Math.max(
    1,
    Math.floor(chartWidth / Math.max(1, sampled.length))
  );
  const barRemainder = chartWidth - barWidth * sampled.length;

  // Pre-compute fractional heights for each column
  const heights = sampled.map((v) => (v / maxVal) * barHeight);

  for (let row = barHeight; row >= 1; row -= 1) {
    const yAxis = buildYAxisSegment({
      row,
      maxHeight: barHeight,
      maxVal,
      gutterWidth,
    });
    const parts = heights.map((h, col) => {
      const w = barWidth + (col < barRemainder ? 1 : 0);
      return colorFn(buildTimeseriesBarColumn(h, row).repeat(w));
    });
    rows.push(`${yAxis}${parts.join("")}`);
  }

  return rows;
}

/**
 * Fill characters for plain/no-color mode.
 *
 * Descending density so the most prominent series gets the densest fill.
 * "Other" always gets the lightest fill (░).
 */
const PLAIN_FILLS = ["█", "▓", "▒", "#", "=", "*", "+", "~", ":", "."] as const;

/**
 * Get the color for a series by index. "Other" gets muted gray.
 *
 * Shares {@link SERIES_PALETTE} with the pixel chart core so the ASCII and
 * sixel renderers use identical hues; only the "Other" bucket differs (ANSI
 * muted vs the core's hex gray).
 */
function seriesColor(label: string, index: number): string {
  if (label === "Other") {
    return COLORS.muted;
  }
  return SERIES_PALETTE[index % SERIES_PALETTE.length] ?? COLORS.magenta;
}

/** Get the fill character for a series in plain mode. "Other" gets ░. */
function seriesFill(label: string, index: number): string {
  if (label === "Other") {
    return "░";
  }
  return PLAIN_FILLS[index % PLAIN_FILLS.length] ?? "█";
}

/**
 * Render stacked multi-color time-series bar rows.
 *
 * Each column shows stacked segments from each series, bottom to top.
 * The first series is at the bottom, "Other" at the top.
 * Each series gets a distinct color from SERIES_PALETTE.
 */
function renderStackedTimeBarRows(
  stackedSeries: { label: string; values: number[] }[],
  opts: {
    maxVal: number;
    barHeight: number;
    gutterWidth: number;
    chartWidth: number;
  }
): string[] {
  const { maxVal, barHeight, gutterWidth, chartWidth } = opts;
  const plain = isPlainOutput();
  const numBuckets = stackedSeries[0]?.values.length ?? 0;

  // Scale bar width so bars fill the full chart area.
  // Distribute the floor-division remainder across the first N bars.
  const barWidth = Math.max(
    1,
    Math.floor(chartWidth / Math.max(1, numBuckets))
  );
  const barRemainder = chartWidth - barWidth * numBuckets;

  // Pre-compute cumulative heights per column, bottom-up
  const stackedHeights: {
    bottom: number;
    top: number;
    label: string;
    seriesIdx: number;
  }[][] = Array.from({ length: numBuckets }, () => []);

  for (let col = 0; col < numBuckets; col += 1) {
    let cumulative = 0;
    for (let s = 0; s < stackedSeries.length; s += 1) {
      const series = stackedSeries[s];
      const val = series?.values[col] ?? 0;
      const bottom = cumulative;
      cumulative += val;
      stackedHeights[col]?.push({
        bottom: (bottom / maxVal) * barHeight,
        top: (cumulative / maxVal) * barHeight,
        label: series?.label ?? "",
        seriesIdx: s,
      });
    }
  }

  const rows: string[] = [];
  for (let row = barHeight; row >= 1; row -= 1) {
    const yAxis = buildYAxisSegment({
      row,
      maxHeight: barHeight,
      maxVal,
      gutterWidth,
    });
    const parts: string[] = [];
    for (let col = 0; col < numBuckets; col += 1) {
      const w = barWidth + (col < barRemainder ? 1 : 0);
      const ch = buildStackedColumn(stackedHeights[col] ?? [], row, plain, w);
      parts.push(ch);
    }
    rows.push(`${yAxis}${parts.join("")}`);
  }
  return rows;
}

/**
 * Build characters for a stacked bar column at a given row.
 *
 * Returns `barWidth` characters (possibly wrapped in a single ANSI color
 * escape) so that each data bucket fills its proportional share of the
 * chart width.
 */
function buildStackedColumn(
  segments: { bottom: number; top: number; label: string; seriesIdx: number }[],
  row: number,
  plain: boolean,
  barWidth: number
): string {
  // Walk segments top-down to find which series fills this row
  for (let s = segments.length - 1; s >= 0; s -= 1) {
    const seg = segments[s];
    if (!seg || seg.top <= row - 1) {
      continue;
    }
    if (seg.bottom >= row) {
      continue;
    }
    // This segment contributes to this row
    const ch = buildTimeseriesBarColumn(seg.top - seg.bottom, row - seg.bottom);
    if (ch === " ") {
      continue;
    }
    if (plain) {
      // In plain mode, use the series fill character for full blocks
      // but keep fractional blocks as-is for smooth tops
      const fill = ch === "█" ? seriesFill(seg.label, seg.seriesIdx) : ch;
      return fill.repeat(barWidth);
    }
    return chalk.hex(seriesColor(seg.label, seg.seriesIdx))(
      ch.repeat(barWidth)
    );
  }
  return " ".repeat(barWidth);
}

/**
 * Pick representative timestamps for each downsampled bucket.
 * Uses the midpoint timestamp of each bucket.
 */
function downsampleTimestamps(
  timestamps: number[],
  targetLen: number
): number[] {
  if (timestamps.length <= targetLen) {
    return timestamps;
  }
  const bucketSize = timestamps.length / targetLen;
  const result: number[] = [];
  for (let i = 0; i < targetLen; i += 1) {
    const mid = Math.floor(i * bucketSize + bucketSize / 2);
    result.push(timestamps[Math.min(mid, timestamps.length - 1)] ?? 0);
  }
  return result;
}

/**
 * Format a Unix timestamp for a time-axis label.
 *
 * Adapts to the time span:
 * - < 2 days: "HH:MM"
 * - 2-30 days: "MM/DD"
 * - > 30 days: "Mon DD"
 */
function formatTimestamp(ts: number, spanDays: number): string {
  const d = new Date(ts * 1000);
  if (spanDays < 2) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  if (spanDays <= 30) {
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${mm}/${dd}`;
  }
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[d.getMonth()] ?? "???"} ${d.getDate()}`;
}

/**
 * Build the bottom axis line (with ┬ tick marks) and time label line.
 *
 * Returns 2 lines:
 * 1. `└──┬─────┬─────┬──` (axis with ticks at label positions)
 * 2. `  03/17  03/19 03/21` (labels centered on tick positions)
 */
/** Place labels onto a character array, centered on their positions. */
function placeLabelsOnLine(
  labels: { pos: number; text: string }[],
  width: number
): string {
  const line = new Array(width).fill(" ");
  for (const { pos, text } of labels) {
    const start = Math.min(
      width - text.length,
      Math.max(0, pos - Math.floor(text.length / 2))
    );
    for (let c = 0; c < text.length; c += 1) {
      const target = start + c;
      if (target < width) {
        line[target] = text[c] ?? " ";
      }
    }
  }
  return line.join("").trimEnd();
}

/**
 * Build the bottom axis line (with ┬ tick marks) and time label line.
 *
 * Returns 2 lines:
 * 1. `└──┬─────┬─────┬──` (axis with ticks at label positions)
 * 2. `  03/17  03/19 03/21` (labels centered on tick positions)
 */
function buildTimeAxis(opts: {
  timestamps: number[];
  chartWidth: number;
  gutterWidth: number;
}): string[] {
  const { timestamps, chartWidth, gutterWidth } = opts;
  const plain = isPlainOutput();

  if (timestamps.length < 2) {
    const axis = `${" ".repeat(gutterWidth - 1)}└${"─".repeat(chartWidth)}`;
    return [plain ? axis : muted(axis)];
  }

  const firstTs = timestamps[0] ?? 0;
  const lastTs = timestamps.at(-1) ?? 0;
  const spanDays = (lastTs - firstTs) / 86_400;

  // Determine how many labels fit (each label ~5 chars + spacing)
  const maxLabels = Math.max(2, Math.floor(chartWidth / 7));
  const labelCount = Math.min(maxLabels, timestamps.length);

  // Compute label positions and text
  const labels: { pos: number; text: string }[] = [];
  for (let i = 0; i < labelCount; i += 1) {
    const idx = Math.round((i / (labelCount - 1)) * (timestamps.length - 1));
    const ts = timestamps[idx] ?? 0;
    labels.push({
      pos: Math.round((idx / (timestamps.length - 1)) * (chartWidth - 1)),
      text: formatTimestamp(ts, spanDays),
    });
  }

  // Build axis line with ┬ at tick positions
  const tickPositions = new Set(labels.map((l) => l.pos));
  const axisChars = new Array(chartWidth).fill("─");
  for (const pos of tickPositions) {
    if (pos >= 0 && pos < chartWidth) {
      axisChars[pos] = "┬";
    }
  }
  const axisStr = `${" ".repeat(gutterWidth - 1)}└${axisChars.join("")}`;
  const labelStr = `${" ".repeat(gutterWidth)}${placeLabelsOnLine(labels, chartWidth)}`;

  return [plain ? axisStr : muted(axisStr), plain ? labelStr : muted(labelStr)];
}

/**
 * Render text widget markdown content as terminal lines.
 *
 * Pipeline: markdown → renderMarkdown() (ANSI-styled) → wrap-ansi
 * (width-constrained) → split into lines. Empty/missing content renders
 * as a muted placeholder.
 */
function renderTextContent(content: string, innerWidth: number): string[] {
  if (!content.trim()) {
    return [isPlainOutput() ? "(empty)" : muted("(empty)")];
  }

  const rendered = renderMarkdown(content);
  const wrapped = wrapAnsi(rendered, innerWidth, {
    hard: true,
    trim: false,
  });
  return wrapped.split("\n");
}

/** Render placeholder content for unsupported/error widgets (no title/border). */
function renderPlaceholderContent(message: string): string[] {
  return [isPlainOutput() ? `(${message})` : muted(`(${message})`)];
}

// ---------------------------------------------------------------------------
// Heatmap renderer
// ---------------------------------------------------------------------------

/**
 * Intensity ramp for heatmap cells.
 *
 * Index 0 is empty (zero value); 1-4 map increasing intensity to shade
 * blocks in plain mode and to a blue→red heat gradient in color mode.
 */
const HEATMAP_SHADES = [" ", "░", "▒", "▓", "█"] as const;
const HEATMAP_COLORS = [
  "#79B8FF", // low  — cyan/blue
  "#FDB81B", // yellow
  "#FF9838", // orange
  "#fe4144", // high — red
] as const;

/** Map a normalized intensity (0-1) to a ramp bucket index (0-4). */
function heatmapBucket(normalized: number): number {
  if (normalized <= 0) {
    return 0;
  }
  return Math.min(4, Math.max(1, Math.ceil(normalized * 4)));
}

/** Render a single heatmap cell for a normalized intensity. */
function heatmapCell(normalized: number, plain: boolean): string {
  const bucket = heatmapBucket(normalized);
  if (plain) {
    return HEATMAP_SHADES[bucket] ?? " ";
  }
  if (bucket === 0) {
    return " ";
  }
  const color = HEATMAP_COLORS[bucket - 1] ?? COLORS.magenta;
  return chalk.hex(color)("█");
}

/**
 * Render heatmap content: one row per series (category), columns over time.
 *
 * Cell intensity encodes the value relative to the global maximum across all
 * cells, so hot spots stand out. Falls back to a "no data" line when there
 * are no series or values.
 */
function renderHeatmapContent(
  data: TimeseriesResult,
  opts: { innerWidth: number; contentHeight: number }
): string[] {
  const { innerWidth, contentHeight } = opts;
  if (data.series.length === 0) {
    return [noDataLine()];
  }

  const plain = isPlainOutput();

  // Reserve rows for the bottom time axis (2 lines) and a legend (1 line).
  const axisLines = 3;
  const maxRows = Math.max(1, contentHeight - axisLines);
  const series = data.series.slice(0, maxRows);

  const maxLabelLen = Math.min(
    20,
    Math.max(4, ...series.map((s) => s.label.length))
  );
  const gutterW = maxLabelLen + 1; // label + space
  const chartWidth = Math.max(1, innerWidth - gutterW);

  // Determine the actual number of time buckets from the longest series.
  const maxLen = Math.max(0, ...series.map((s) => s.values.length));
  const bucketCount = Math.min(chartWidth, maxLen || chartWidth);

  // Downsample every series to that bucket count; pad shorter series so every
  // row has exactly `bucketCount` cells (downsample returns early for short input).
  const rows = series.map((s) => {
    const ds = downsample(
      s.values.map((v) => v.value),
      bucketCount
    );
    return ds.length < bucketCount
      ? [...ds, ...new Array(bucketCount - ds.length).fill(0)]
      : ds;
  });
  const globalMax = Math.max(1, ...rows.flat());

  const lines: string[] = [];
  for (let i = 0; i < series.length; i += 1) {
    const s = series[i];
    const values = rows[i] ?? [];
    if (!s) {
      continue;
    }
    const label =
      s.label.length > maxLabelLen
        ? `${s.label.slice(0, maxLabelLen - 1)}…`
        : s.label.padEnd(maxLabelLen);
    const cells = values.map((v) => heatmapCell(v / globalMax, plain)).join("");
    const labelStr = plain ? label : chalk.hex(COLORS.cyan)(label);
    lines.push(`${labelStr} ${cells}`);
  }

  // Bottom time axis, aligned to the chart area.
  // Find the longest series so its timestamps match the bucketCount.
  const longest = series.reduce(
    (a, b) => (b.values.length > a.values.length ? b : a),
    series[0] ?? { values: [] }
  );
  const axisTs = longest.values.map((v) => v.timestamp);
  if (axisTs.length > 0) {
    const dsTs = downsampleTimestamps(axisTs, bucketCount);
    lines.push(
      ...buildTimeAxis({
        timestamps: dsTs,
        chartWidth: bucketCount,
        gutterWidth: gutterW,
      })
    );
  }

  // Intensity legend: low → high.
  const gutter = " ".repeat(gutterW);
  if (plain) {
    lines.push(`${gutter}low ${HEATMAP_SHADES.slice(1).join("")} high`);
  } else {
    const ramp = HEATMAP_COLORS.map((c) => chalk.hex(c)("█")).join("");
    lines.push(`${gutter}${muted("low")} ${ramp} ${muted("high")}`);
  }

  return lines;
}

/**
 * Dispatch to the appropriate content renderer based on data type.
 *
 * Returns raw content lines (no title, no border). The caller handles
 * border wrapping and height enforcement.
 */
type ContentWidget = Pick<DashboardViewWidget, "displayType" | "data">;

function renderContentLines(opts: {
  widget: ContentWidget;
  innerWidth: number;
  contentHeight: number;
}): string[] {
  const { widget, innerWidth, contentHeight } = opts;
  const { data } = widget;

  switch (data.type) {
    case "timeseries": {
      if (widget.displayType === "heatmap") {
        return renderHeatmapContent(data, { innerWidth, contentHeight });
      }
      if (widget.displayType === "categorical_bar") {
        return renderVerticalBarsContent(data, { innerWidth, contentHeight });
      }
      // Use vertical bars when there's enough height, sparklines otherwise
      if (contentHeight >= 8) {
        return renderTimeseriesBarsContent(data, { innerWidth, contentHeight });
      }
      return renderTimeseriesContent(data, innerWidth);
    }

    case "table":
      return renderTableContent(data, innerWidth);

    case "scalar":
      return renderBigNumberContent(data, { innerWidth, contentHeight });

    case "text":
      return renderTextContent(data.content, innerWidth);

    case "unsupported":
      return renderPlaceholderContent(data.reason);

    case "error":
      return renderPlaceholderContent(`query failed: ${data.message}`);

    default:
      return renderPlaceholderContent("unknown widget data type");
  }
}

/**
 * Render a widget into terminal lines with a bordered box.
 *
 * Returns exactly `layout.h * LINES_PER_UNIT` lines so the framebuffer
 * grid composes correctly. The widget content is wrapped in a rounded
 * Unicode border with the title embedded in the top border line.
 */
function renderWidgetLines(
  widget: DashboardViewWidget,
  width: number
): string[] {
  const layout = widget.layout;
  const totalHeight = layout ? layout.h * LINES_PER_UNIT : LINES_PER_UNIT;
  const innerWidth = Math.max(0, width - 4);
  const contentHeight = Math.max(0, totalHeight - 2);

  const contentLines = renderContentLines({
    widget,
    innerWidth,
    contentHeight,
  });

  return wrapInBorder({
    title: widget.title,
    contentLines,
    width,
    totalHeight,
  });
}

// ---------------------------------------------------------------------------
// Framebuffer grid renderer
// ---------------------------------------------------------------------------

/**
 * Clip a string to a visual width, accounting for ANSI escape codes.
 * If the string is shorter, it is padded with spaces.
 * If longer, it is truncated (ANSI-aware via character iteration).
 */
/** ANSI escape sequence type for the truncation state machine. */
type EscapeType = "none" | "start" | "csi" | "osc" | "dcs";

/** Check if a character is an ASCII letter (CSI sequence terminator). */
function isAsciiLetter(ch: string): boolean {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z");
}

/**
 * Advance the ANSI escape state machine by one character.
 *
 * Returns `true` if the character is part of an escape sequence (should
 * be appended to the output but NOT counted as visible width).
 * Handles CSI (`\x1b[...letter`) and OSC (`\x1b]...BEL` or `\x1b]...\x1b\\`).
 */
function advanceEscape(
  state: { type: EscapeType },
  ch: string,
  buffer: string
): boolean {
  return advanceEscapeInner(state, ch, buffer.at(-1));
}

function advanceEscapeInner(
  state: { type: EscapeType },
  ch: string,
  prev: string | undefined
): boolean {
  const stTerminator = ch === "\\" && prev === "\x1b";
  switch (state.type) {
    case "none":
      if (ch === "\x1b") {
        state.type = "start";
        return true;
      }
      return false;
    case "start":
      if (ch === "[") {
        state.type = "csi";
      } else if (ch === "]") {
        state.type = "osc";
      } else if (ch === "P") {
        state.type = "dcs";
      } else {
        state.type = "none";
      }
      return true;
    case "csi":
      if (isAsciiLetter(ch)) {
        state.type = "none";
      }
      return true;
    case "osc":
      // OSC ends at BEL (\x07) or ST (\x1b\\)
      if (ch === "\x07" || stTerminator) {
        state.type = "none";
      }
      return true;
    case "dcs":
      // DCS ends at ST (\x1b\\)
      if (stTerminator) {
        state.type = "none";
      }
      return true;
    default:
      return false;
  }
}

function fitToWidth(line: string, targetWidth: number): string {
  const visibleWidth = stringWidth(line);
  if (visibleWidth <= targetWidth) {
    return line + " ".repeat(targetWidth - visibleWidth);
  }
  // Truncate: walk characters, tracking visible width
  let result = "";
  let width = 0;
  const esc: { type: EscapeType } = { type: "none" };
  for (const ch of line) {
    if (advanceEscape(esc, ch, result)) {
      result += ch;
      continue;
    }
    const charWidth = stringWidth(ch);
    if (width + charWidth > targetWidth) {
      break;
    }
    result += ch;
    width += charWidth;
  }
  // Pad remainder
  if (width < targetWidth) {
    result += " ".repeat(targetWidth - width);
  }
  return result;
}

/**
 * Compose a single terminal row from active widgets.
 * Each widget's content is clipped to its column width.
 */
function composeTermRow(
  active: DashboardViewWidget[],
  termRow: number,
  termWidth: number,
  rendered: Map<DashboardViewWidget, string[]>
): string {
  let line = "";
  let currentCol = 0;

  for (const w of active) {
    const layout = w.layout;
    if (!layout) {
      continue;
    }
    const startCol = Math.floor((layout.x / GRID_COLS) * termWidth);
    const colWidth = Math.floor((layout.w / GRID_COLS) * termWidth);
    const widgetStartRow = layout.y * LINES_PER_UNIT;
    const lineIdx = termRow - widgetStartRow;

    if (startCol > currentCol) {
      line += " ".repeat(startCol - currentCol);
      currentCol = startCol;
    }

    const widgetLines = rendered.get(w) ?? [];
    const content = widgetLines[lineIdx] ?? "";
    line += fitToWidth(content, colWidth);
    currentCol = startCol + colWidth;
  }

  return line;
}

/**
 * Render the dashboard as a framebuffer.
 *
 * Each widget is drawn at its grid-allocated position. Tall widgets
 * correctly span multiple rows. For each terminal row, all active
 * widgets are composed side-by-side at their column positions, clipped
 * to prevent overflow.
 */
function renderGrid(
  widgets: DashboardViewWidget[],
  termWidth: number
): string[] {
  let maxGridBottom = 0;
  for (const w of widgets) {
    if (w.layout) {
      const bottom = w.layout.y + w.layout.h;
      if (bottom > maxGridBottom) {
        maxGridBottom = bottom;
      }
    }
  }

  const totalTermRows = maxGridBottom * LINES_PER_UNIT;

  const rendered = new Map<DashboardViewWidget, string[]>();
  for (const w of widgets) {
    if (!w.layout) {
      continue;
    }
    const colWidth = Math.floor((w.layout.w / GRID_COLS) * termWidth);
    rendered.set(w, renderWidgetLines(w, colWidth));
  }

  const output: string[] = [];

  for (let termRow = 0; termRow < totalTermRows; termRow++) {
    const active = widgets
      .filter((ww) => {
        if (!ww.layout) {
          return false;
        }
        const startRow = ww.layout.y * LINES_PER_UNIT;
        const endRow = (ww.layout.y + ww.layout.h) * LINES_PER_UNIT;
        return termRow >= startRow && termRow < endRow;
      })
      .sort((a, b) => (a.layout?.x ?? 0) - (b.layout?.x ?? 0));

    if (active.length === 0) {
      output.push("");
    } else {
      output.push(composeTermRow(active, termRow, termWidth, rendered));
    }
  }

  const noLayout = widgets.filter((item) => !item.layout);
  for (const w of noLayout) {
    output.push("", ...renderWidgetLines(w, termWidth));
  }

  return output;
}

// ---------------------------------------------------------------------------
// Dashboard header
// ---------------------------------------------------------------------------

/** Render the compact dashboard header with linkified title, badges, and underline. */
function renderHeader(data: DashboardViewData, termWidth: number): string[] {
  const lines: string[] = [];
  const plain = isPlainOutput();

  if (plain) {
    lines.push(data.title);
    let meta = `Period: ${data.period}`;
    if (data.environment?.length) {
      meta += `  Env: ${data.environment.join(", ")}`;
    }
    lines.push(meta);
    lines.push(data.url);
    lines.push("─".repeat(Math.min(data.url.length, termWidth)));
  } else {
    const title = terminalLink(chalk.bold(data.title), data.url);
    const period = chalk.cyan(`[${data.period}]`);
    const env = data.environment?.length
      ? chalk.green(`env: ${data.environment.join(", ")}`)
      : "";
    lines.push(`${title}  ${period}${env ? `  ${env}` : ""}`);
    lines.push(muted("─".repeat(termWidth)));
  }

  lines.push("");
  return lines;
}

// ---------------------------------------------------------------------------
// Full dashboard renderer
// ---------------------------------------------------------------------------

/**
 * Format a complete dashboard with resolved widget data.
 *
 * Renders a compact header, then lays out widgets using the framebuffer
 * grid engine that respects the Sentry 6-column dashboard layout.
 */
export function formatDashboardWithData(data: DashboardViewData): string {
  const termWidth = getTermWidth();
  const lines: string[] = [];
  lines.push(...renderHeader(data, termWidth));

  const graphics = renderCompleteDashboardAsGraphics(data, getSixelTermWidth());
  logDashboardGraphicsRenderer(graphics);
  if (graphics.output) {
    lines.push(graphics.output);
  } else {
    lines.push(...renderGrid(data.widgets, termWidth));
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Render the complete dashboard as one graphics canvas, selecting the most
 * capable terminal format available (kitty over sixel over ASCII). When the
 * terminal advertises graphics but doesn't report its cell geometry — common
 * for kitty terminals, which frequently answer the graphics query but never
 * send `CSI 16 t` — default cell dimensions are used so the dashboard still
 * renders as graphics rather than silently dropping to ASCII. Never partially
 * replaces the framebuffer: when no graphics format is available it records
 * the fallback reason so the caller can render the complete character view and
 * emit a useful debug log.
 */
type DashboardGraphicsRender = {
  renderer: GraphicsFormat | "ascii";
  rendererPreference: GraphicsRendererPreference;
  output?: string;
  reason?: string;
  termWidth?: number;
  cell?: { cellWidth: number; cellHeight: number };
  nativePixelWidth?: number;
  pixelWidth?: number;
  graphicsCapApplied?: boolean;
};

/** Log the terminal graphics decision without including dashboard data. */
function logDashboardGraphicsRenderer(render: DashboardGraphicsRender): void {
  const caps = detectSixelCaps();
  const details = [
    `requested=${render.rendererPreference}`,
    `capabilities: kitty=${caps.kitty === true ? "yes" : "no"}, sixel=${caps.supported ? "yes" : "no"}`,
    `terminal: stdout TTY=${process.stdout.isTTY ? "yes" : "no"}, stdin TTY=${process.stdin.isTTY ? "yes" : "no"}`,
    `plain output=${isPlainOutput() ? "yes" : "no"}`,
    `columns=${render.termWidth ?? "unavailable"}`,
  ];
  if (render.cell) {
    details.push(`cell=${render.cell.cellWidth}x${render.cell.cellHeight}`);
  }
  if (render.nativePixelWidth) {
    details.push(`native pixel width=${render.nativePixelWidth}`);
  }
  if (render.pixelWidth) {
    details.push(`effective pixel width=${render.pixelWidth}`);
  }
  details.push(
    `graphics cap=${render.graphicsCapApplied ? "applied" : "not applied"}`
  );
  const reason = render.reason ? ` (reason: ${render.reason})` : "";
  logger.debug(
    `Dashboard graphics renderer: ${render.renderer}${reason}; ${details.join("; ")}`
  );
}

function renderCompleteDashboardAsGraphics(
  data: DashboardViewData,
  termWidth: number | undefined
): DashboardGraphicsRender {
  const rendererPreference = data.rendererPreference ?? "auto";
  const format = selectGraphicsFormat(rendererPreference);
  if (!termWidth) {
    return {
      renderer: "ascii",
      rendererPreference,
      reason: "terminal width unavailable",
    };
  }
  if (isPlainOutput()) {
    return {
      renderer: "ascii",
      rendererPreference,
      reason: "plain output requested",
      termWidth,
    };
  }
  if (!format) {
    return {
      renderer: "ascii",
      rendererPreference,
      reason: "no compatible graphics protocol detected",
      termWidth,
    };
  }
  const cell = graphicsCellSize(rendererPreference);
  if (!cell) {
    return {
      renderer: "ascii",
      rendererPreference,
      reason: "graphics cell size unavailable",
      termWidth,
    };
  }
  // Preserve the terminal's reported pixel width when known; otherwise derive it
  // from the (possibly defaulted) cell width so the canvas still matches the
  // column count exactly.
  const nativePixelWidth =
    terminalPixelWidth(termWidth) ?? termWidth * cell.cellWidth;
  const cellWidth = Math.floor(nativePixelWidth / termWidth);
  if (cellWidth < 1) {
    return {
      renderer: "ascii",
      rendererPreference,
      reason: "calculated graphics cell width is invalid",
      termWidth,
      cell,
      nativePixelWidth,
    };
  }
  const graphicsCap = data.graphicsCap !== false;
  const graphicsCapApplied =
    graphicsCap && nativePixelWidth > MAX_GRAPHICS_WIDTH;
  const graphicsColumns = graphicsCapApplied
    ? Math.min(termWidth, Math.floor(MAX_GRAPHICS_WIDTH / cellWidth))
    : termWidth;
  if (graphicsColumns < 1) {
    return {
      renderer: "ascii",
      rendererPreference,
      reason: "graphics cap is smaller than one terminal cell",
      termWidth,
      cell,
      nativePixelWidth,
    };
  }
  const pixelWidth = graphicsCapApplied
    ? graphicsColumns * cellWidth
    : nativePixelWidth;
  const graphics = renderDashboardAsSixel(data, {
    pixelWidth,
    cellWidth,
    cellHeight: cell.cellHeight,
    renderTextContent(widget, innerWidth, contentHeight) {
      return renderContentLines({
        widget,
        innerWidth,
        contentHeight,
      });
    },
    encodeImage:
      format === "kitty"
        ? (image) => encodeImageToKitty(image, image.width, true)
        : undefined,
  });
  if (!("output" in graphics)) {
    return {
      renderer: "ascii",
      rendererPreference,
      reason: graphics.reason,
      termWidth,
      cell,
      nativePixelWidth,
      pixelWidth,
      graphicsCapApplied,
    };
  }
  return {
    renderer: format,
    rendererPreference,
    output: graphics.output,
    termWidth,
    cell,
    nativePixelWidth,
    pixelWidth,
    graphicsCapApplied,
  };
}

// ---------------------------------------------------------------------------
// HumanRenderer factory (supports --refresh mode)
// ---------------------------------------------------------------------------

export function createDashboardViewRenderer(): HumanRenderer<DashboardViewData> {
  return {
    render(data: DashboardViewData): string {
      return formatDashboardWithData(data);
    },

    finalize(hint?: string): string {
      if (!hint) {
        return "";
      }
      return isPlainOutput() ? `\n${hint}\n` : "";
    },
  };
}

// ---------------------------------------------------------------------------
// JSON transform
