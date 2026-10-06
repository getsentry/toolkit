/**
 * ANSI-aware text table renderer with Unicode box-drawing borders.
 *
 * Column fitting algorithms ported from OpenTUI's TextTable.
 * Measures string widths with `string-width` (handles ANSI codes, emoji,
 * CJK characters) and wraps with `wrap-ansi` for correct ANSI sequence
 * continuation across line breaks.
 *
 * @see https://github.com/anomalyco/opentui/blob/main/packages/core/src/renderables/TextTable.ts
 */

import stringWidth from "string-width";

/** Matches one or more trailing ANSI SGR escape sequences at end of string. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape detection requires matching \x1b
const TRAILING_ANSI_RE = /(?:\x1b\[[0-9;]*m)+$/;

/**
 * Compute the visual width of a cell that may contain `\n` line breaks.
 *
 * `string-width` sums character widths across the entire string without
 * splitting on newlines, so `"abc\ndefgh"` returns 8 instead of the
 * correct 5 (the widest line). This helper splits and takes the max.
 */
function cellVisualWidth(text: string): number {
  return Math.max(...text.split("\n").map((line) => stringWidth(line)));
}

import wrapAnsi from "wrap-ansi";
import {
  type BorderCharacters,
  BorderChars,
  type BorderStyle,
} from "./border.js";

/** Column alignment. */
export type Alignment = "left" | "right" | "center";

/** Options for rendering a text table. */
export type TextTableOptions = {
  /** Border style. @default "rounded" */
  borderStyle?: BorderStyle;
  /** Column fitting strategy when table exceeds maxWidth. @default "balanced" */
  columnFitter?: "proportional" | "balanced";
  /** Horizontal cell padding (each side). @default 1 */
  cellPadding?: number;
  /** Maximum table width in columns. @default process.stdout.columns or 80 */
  maxWidth?: number;
  /** Per-column alignment (indexed by column). Defaults to "left". */
  alignments?: Array<Alignment | null>;
  /** Whether to include a separator row after the header. @default true */
  headerSeparator?: boolean;
  /** Per-column minimum content widths. Columns will not shrink below these. */
  minWidths?: number[];
  /** Per-column shrinkable flags. Non-shrinkable columns keep intrinsic width. */
  shrinkable?: boolean[];
  /** Truncate cells to one line with "\u2026" instead of wrapping. @default false */
  truncate?: boolean;
  /**
   * Hide the header row entirely (omit from rendered output).
   *
   * Headers are still used for column width measurement, but the rendered
   * table starts directly with data rows. Useful for key-value tables where
   * the markdown source requires empty header cells (`| | |`) to satisfy
   * table syntax, but the visual output shouldn't show them.
   *
   * When omitted, auto-detects: hides headers when **all** header cells
   * are empty or whitespace-only. Pass `true`/`false` explicitly to override.
   */
  hideHeaders?: boolean;
  /**
   * Show horizontal separator lines between data rows.
   *
   * - `false` (default): no row separators
   * - `true`: row separators in default terminal color
   * - ANSI escape string (e.g., `"\x1b[38;2;137;130;148m"`): all table
   *   borders (horizontal lines, vertical bars, corners) are colored with
   *   the given prefix, making the frame visually subdued relative to content.
   */
  rowSeparator?: boolean | string;
};

/**
 * Render a text table with Unicode box-drawing borders.
 *
 * Cell values may contain ANSI escape codes — widths are computed correctly
 * via `string-width` and word wrapping preserves ANSI sequences via `wrap-ansi`.
 *
 * @param headers - Column header strings
 * @param rows - 2D array of cell values (outer = rows, inner = columns)
 * @param options - Rendering options
 * @returns Rendered table string with box-drawing borders and newline at end
 */
export function renderTextTable(
  headers: string[],
  rows: string[][],
  options: TextTableOptions = {}
): string {
  const {
    borderStyle = "rounded",
    columnFitter = "balanced",
    cellPadding = 1,
    maxWidth = process.stdout.columns || 80,
    alignments = [],
    headerSeparator = true,
    minWidths = [],
    shrinkable = [],
    truncate = false,
    rowSeparator = false,
  } = options;

  // Auto-detect empty headers when not explicitly set by the caller.
  // Extracted from destructuring because `??` preserves explicit `false`.
  const hideHeaders =
    options.hideHeaders ?? headers.every((h) => h.trim() === "");

  const border = BorderChars[borderStyle];
  const colCount = headers.length;
  if (colCount === 0) {
    return "";
  }

  // Measure intrinsic column widths from all content
  const intrinsicWidths = measureIntrinsicWidths(headers, rows, colCount, {
    cellPadding,
    minWidths,
  });

  // Fit columns to available width
  // Border overhead: outerLeft(1) + outerRight(1) + innerSeparators(colCount-1)
  const borderOverhead = 2 + (colCount - 1);
  const maxContentWidth = Math.max(colCount, maxWidth - borderOverhead);
  const columnWidths = fitColumns(intrinsicWidths, maxContentWidth, {
    cellPadding,
    fitter: columnFitter,
    minWidths,
    shrinkable,
  });

  // Build all rows (header + optional separator + data rows)
  const allRows: string[][][] = [];

  // Header row
  allRows.push(wrapRow(headers, columnWidths, cellPadding, false));

  // Data rows
  for (const row of rows) {
    allRows.push(wrapRow(row, columnWidths, cellPadding, truncate));
  }

  // Render the grid
  return renderGrid({
    allRows,
    columnWidths,
    alignments,
    border,
    cellPadding,
    headerSeparator,
    hideHeaders,
    rowSeparator,
  });
}

/**
 * Measure the intrinsic (unconstrained) width of each column.
 * Returns the maximum visual width across all rows for each column,
 * plus horizontal padding.
 */
function measureIntrinsicWidths(
  headers: string[],
  rows: string[][],
  colCount: number,
  ctx: { cellPadding: number; minWidths: number[] }
): number[] {
  const { cellPadding, minWidths } = ctx;
  const pad = cellPadding * 2;
  const widths: number[] = [];

  for (let c = 0; c < colCount; c++) {
    // Start with header width
    let maxW = stringWidth(headers[c] ?? "") + pad;

    // Check all data rows — use cellVisualWidth for multi-line cells
    for (const row of rows) {
      const cellWidth = cellVisualWidth(row[c] ?? "") + pad;
      if (cellWidth > maxW) {
        maxW = cellWidth;
      }
    }

    // Minimum: padding + 1 char, or per-column minWidth + padding
    const colMin = (minWidths[c] ?? 0) + pad;
    widths.push(Math.max(maxW, pad + 1, colMin));
  }

  return widths;
}

/**
 * Fit column widths to the available content width.
 *
 * If columns fit naturally, returns intrinsic widths.
 * If columns exceed the max, shrinks using the selected fitter.
 */
function fitColumns(
  intrinsicWidths: number[],
  maxContentWidth: number,
  ctx: {
    cellPadding: number;
    fitter: "proportional" | "balanced";
    minWidths: number[];
    shrinkable: boolean[];
  }
): number[] {
  const { cellPadding, fitter, minWidths, shrinkable: shrinkFlags } = ctx;
  const totalIntrinsic = intrinsicWidths.reduce((s, w) => s + w, 0);

  if (totalIntrinsic <= maxContentWidth) {
    return intrinsicWidths;
  }

  // Separate fixed (non-shrinkable) and elastic (shrinkable) columns.
  // Fixed columns keep their intrinsic width; elastic ones share the rest.
  const isFixed = intrinsicWidths.map((_, i) => shrinkFlags[i] === false);
  const fixedTotal = intrinsicWidths.reduce(
    (s, w, i) => s + (isFixed[i] ? w : 0),
    0
  );
  const elasticTarget = maxContentWidth - fixedTotal;
  const elasticWidths = intrinsicWidths.filter((_, i) => !isFixed[i]);
  const elasticMins = minWidths.filter((_, i) => !isFixed[i]);

  if (elasticWidths.length === 0 || elasticTarget <= 0) {
    return intrinsicWidths;
  }

  const fitFn = fitter === "balanced" ? fitBalanced : fitProportional;
  const fitted = fitFn(elasticWidths, elasticTarget, cellPadding, elasticMins);

  // Merge fixed and fitted widths back into the original column order
  const result: number[] = [];
  let ei = 0;
  for (let i = 0; i < intrinsicWidths.length; i++) {
    if (isFixed[i]) {
      result.push(intrinsicWidths[i] ?? 0);
    } else {
      result.push(fitted[ei] ?? 0);
      ei += 1;
    }
  }
  return result;
}

/**
 * Proportional column fitting: shrinks each column proportional to its
 * excess over the minimum width.
 *
 * Ported from OpenTUI's fitColumnWidthsProportional.
 */
function fitProportional(
  widths: number[],
  target: number,
  cellPadding: number,
  minWidths: number[] = []
): number[] {
  const globalMin = 1 + cellPadding * 2;
  const colMins = widths.map((_, i) =>
    Math.max(globalMin, (minWidths[i] ?? 0) + cellPadding * 2)
  );
  const baseWidths = widths.map((w, i) =>
    Math.max(colMins[i] ?? globalMin, Math.floor(w))
  );
  const totalBase = baseWidths.reduce((s, w) => s + w, 0);

  if (totalBase <= target) {
    return baseWidths;
  }

  const floorWidths = baseWidths.map((w, i) =>
    Math.min(w, (colMins[i] ?? globalMin) + 1)
  );
  const floorTotal = floorWidths.reduce((s, w) => s + w, 0);
  const clampedTarget = Math.max(floorTotal, target);

  if (totalBase <= clampedTarget) {
    return baseWidths;
  }

  const shrinkable = baseWidths.map((w, i) => w - (floorWidths[i] ?? 0));
  const totalShrinkable = shrinkable.reduce((s, v) => s + v, 0);
  if (totalShrinkable <= 0) {
    return [...floorWidths];
  }

  return allocateShrink({
    baseWidths,
    floorWidths,
    shrinkable,
    targetShrink: totalBase - clampedTarget,
    mode: "linear",
  });
}

/**
 * Balanced column fitting: uses sqrt-weighted shrinking so wide columns
 * don't dominate the shrink allocation.
 *
 * Ported from OpenTUI's fitColumnWidthsBalanced.
 */
function fitBalanced(
  widths: number[],
  target: number,
  cellPadding: number,
  minWidths: number[] = []
): number[] {
  const globalMin = 1 + cellPadding * 2;
  const colMins = widths.map((_, i) =>
    Math.max(globalMin, (minWidths[i] ?? 0) + cellPadding * 2)
  );
  const baseWidths = widths.map((w, i) =>
    Math.max(colMins[i] ?? globalMin, Math.floor(w))
  );
  const totalBase = baseWidths.reduce((s, w) => s + w, 0);

  if (totalBase <= target) {
    return baseWidths;
  }

  const evenShare = Math.max(globalMin, Math.floor(target / baseWidths.length));
  const floorWidths = baseWidths.map((w, i) =>
    Math.min(w, Math.max(evenShare, colMins[i] ?? globalMin))
  );
  const floorTotal = floorWidths.reduce((s, w) => s + w, 0);
  const clampedTarget = Math.max(floorTotal, target);

  if (totalBase <= clampedTarget) {
    return baseWidths;
  }

  const shrinkable = baseWidths.map((w, i) => w - (floorWidths[i] ?? 0));
  const totalShrinkable = shrinkable.reduce((s, v) => s + v, 0);
  if (totalShrinkable <= 0) {
    return [...floorWidths];
  }

  return allocateShrink({
    baseWidths,
    floorWidths,
    shrinkable,
    targetShrink: totalBase - clampedTarget,
    mode: "sqrt",
  });
}

/** Parameters for the shrink allocation algorithm. */
type ShrinkParams = {
  baseWidths: number[];
  floorWidths: number[];
  shrinkable: number[];
  targetShrink: number;
  mode: "linear" | "sqrt";
};

/**
 * Distribute shrink across columns using weighted allocation with
 * fractional remainder distribution for pixel-perfect results.
 *
 * Ported from OpenTUI's allocateShrinkByWeight.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ported algorithm
function allocateShrink(params: ShrinkParams): number[] {
  const { baseWidths, floorWidths, shrinkable, targetShrink, mode } = params;
  const computeWeight = (v: number) => {
    if (v <= 0) {
      return 0;
    }
    return mode === "sqrt" ? Math.sqrt(v) : v;
  };
  const weights = shrinkable.map(computeWeight);
  const totalWeight = weights.reduce((s, v) => s + v, 0);

  if (totalWeight <= 0) {
    return [...floorWidths];
  }

  const shrink = new Array<number>(baseWidths.length).fill(0);
  const fractions = new Array<number>(baseWidths.length).fill(0);
  let usedShrink = 0;

  for (let i = 0; i < baseWidths.length; i++) {
    const s = shrinkable[i] ?? 0;
    const wt = weights[i] ?? 0;
    if (s <= 0 || wt <= 0) {
      continue;
    }
    const exact = (wt / totalWeight) * targetShrink;
    const whole = Math.min(s, Math.floor(exact));
    shrink[i] = whole;
    fractions[i] = exact - whole;
    usedShrink += whole;
  }

  // Distribute fractional remainders to columns with largest fractions
  let remaining = targetShrink - usedShrink;
  while (remaining > 0) {
    let bestIdx = -1;
    let bestFrac = -1;
    for (let i = 0; i < baseWidths.length; i++) {
      const s = shrinkable[i] ?? 0;
      const sh = shrink[i] ?? 0;
      if (s - sh <= 0) {
        continue;
      }
      const f = fractions[i] ?? 0;
      if (
        f > bestFrac ||
        (f === bestFrac && bestIdx >= 0 && s > (shrinkable[bestIdx] ?? 0))
      ) {
        bestFrac = f;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) {
      break;
    }
    shrink[bestIdx] = (shrink[bestIdx] ?? 0) + 1;
    fractions[bestIdx] = 0;
    remaining -= 1;
  }

  return baseWidths.map((w, i) =>
    Math.max(floorWidths[i] ?? 0, w - (shrink[i] ?? 0))
  );
}

/**
 * Truncate a single line to `maxWidth` with an ellipsis.
 *
 * Wraps to `maxWidth - 2` so the "…" + 1 char gap gives consistent right-side
 * padding. Inserts "…" before any trailing ANSI resets so it inherits the
 * text color instead of rendering in the default foreground.
 */
function truncateLine(line: string, maxWidth: number): string {
  const shorter = wrapAnsi(line, Math.max(1, maxWidth - 2), {
    hard: true,
    trim: false,
  });
  const first = shorter.split("\n")[0] ?? "";
  const ansiTail = TRAILING_ANSI_RE.exec(first);
  if (ansiTail) {
    return `${first.slice(0, ansiTail.index)}\u2026${ansiTail[0]}`;
  }
  return `${first}\u2026`;
}

/**
 * Wrap a row's cell values to their allocated column widths.
 * Returns an array of lines per cell (for multi-line rows).
 */
function wrapRow(
  cells: string[],
  columnWidths: number[],
  cellPadding: number,
  truncate: boolean
): string[][] {
  const wrappedCells: string[][] = [];
  for (let c = 0; c < columnWidths.length; c++) {
    const contentWidth = (columnWidths[c] ?? 3) - cellPadding * 2;
    const text = c < cells.length ? (cells[c] ?? "") : "";
    if (contentWidth <= 0) {
      wrappedCells.push([""]);
      continue;
    }

    // Split on explicit newlines first so intentional line breaks are preserved.
    // Each sub-line is then wrapped/truncated independently — a 2-line cell
    // stays 2 lines but long sub-lines won't overflow into a 3rd.
    const inputLines = text.split("\n");
    const outputLines: string[] = [];
    for (const inputLine of inputLines) {
      const wrapped = wrapAnsi(inputLine, contentWidth, {
        hard: true,
        trim: false,
      });
      const subLines = wrapped.split("\n");
      if (truncate && subLines.length > 1) {
        outputLines.push(truncateLine(inputLine, contentWidth));
      } else {
        outputLines.push(...subLines);
      }
    }
    wrappedCells.push(outputLines);
  }
  return wrappedCells;
}

/**
 * Pad a cell value to its column width respecting alignment.
 * Uses string-width for ANSI-aware padding calculation.
 */
function padCell(
  text: string,
  width: number,
  align: Alignment,
  padding: number
): string {
  const contentWidth = width - padding * 2;
  const textWidth = stringWidth(text);
  const pad = Math.max(0, contentWidth - textWidth);
  const leftPad = " ".repeat(padding);
  const rightPad = " ".repeat(padding);

  switch (align) {
    case "right":
      return `${leftPad}${" ".repeat(pad)}${text}${rightPad}`;
    case "center": {
      const left = Math.floor(pad / 2);
      return `${leftPad}${" ".repeat(left)}${text}${" ".repeat(pad - left)}${rightPad}`;
    }
    default:
      return `${leftPad}${text}${" ".repeat(pad)}${rightPad}`;
  }
}

/** Parameters for grid rendering. */
type GridParams = {
  allRows: string[][][];
  columnWidths: number[];
  alignments: Array<Alignment | null>;
  border: BorderCharacters;
  cellPadding: number;
  headerSeparator: boolean;
  /** Skip rendering the header row (allRows[0]) entirely. */
  hideHeaders: boolean;
  /** Draw separator between data rows. `true` for plain, or ANSI color prefix string. */
  rowSeparator: boolean | string;
};

/** Context needed to render a single row's output lines. */
type RowRenderContext = {
  columnWidths: number[];
  alignments: Array<Alignment | null>;
  cellPadding: number;
  vert: string;
};

/**
 * Render a single multi-line row as an array of output lines.
 *
 * Each cell may contain multiple wrapped lines; the row height is the
 * maximum across all cells. Shorter cells are padded with blanks.
 */
function renderRowLines(
  wrappedCells: string[][],
  ctx: RowRenderContext
): string[] {
  const { columnWidths, alignments, cellPadding, vert } = ctx;
  const rowHeight = Math.max(1, ...wrappedCells.map((c) => c.length));
  const out: string[] = [];
  for (let line = 0; line < rowHeight; line++) {
    const cellTexts: string[] = [];
    for (let c = 0; c < columnWidths.length; c++) {
      const cellLines = wrappedCells[c] ?? [""];
      const text = cellLines[line] ?? "";
      const align = alignments[c] ?? "left";
      const colW = columnWidths[c] ?? 3;
      cellTexts.push(padCell(text, colW, align, cellPadding));
    }
    out.push(`${vert}${cellTexts.join(vert)}${vert}`);
  }
  return out;
}

/**
 * Render the complete table grid with borders.
 */
function renderGrid(params: GridParams): string {
  const {
    allRows,
    columnWidths,
    alignments,
    border,
    cellPadding,
    headerSeparator,
    hideHeaders,
    rowSeparator,
  } = params;
  const lines: string[] = [];
  const hz = border.horizontal;

  // When rowSeparator is a color string, wrap all border lines in that color
  const borderColor = typeof rowSeparator === "string" ? rowSeparator : "";
  const borderReset = borderColor ? "\x1b[0m" : "";
  const colorLine = (line: string): string =>
    borderColor ? `${borderColor}${line}${borderReset}` : line;

  const midLine = horizontalLine(columnWidths, {
    left: border.leftT,
    junction: border.cross,
    right: border.rightT,
    horizontal: hz,
  });

  // Row separators reuse the solid midLine — the muted color alone is enough
  // to distinguish them from the header separator and outer borders.
  const rowSepLine = rowSeparator ? colorLine(midLine) : "";

  // Top border
  lines.push(
    colorLine(
      horizontalLine(columnWidths, {
        left: border.topLeft,
        junction: border.topT,
        right: border.topRight,
        horizontal: hz,
      })
    )
  );

  // Colored vertical border for row rendering
  const vert = borderColor
    ? `${borderColor}${border.vertical}${borderReset}`
    : border.vertical;
  const rowCtx: RowRenderContext = {
    columnWidths,
    alignments,
    cellPadding,
    vert,
  };

  // When hideHeaders is set, skip allRows[0] (the header) and its separator.
  // The header is still included in allRows for column width measurement.
  const startRow = hideHeaders ? 1 : 0;

  for (let r = startRow; r < allRows.length; r++) {
    const wrappedCells = allRows[r] ?? [];
    lines.push(...renderRowLines(wrappedCells, rowCtx));

    // Header separator (full weight, same color as other borders)
    if (r === 0 && headerSeparator && allRows.length > 1) {
      lines.push(colorLine(midLine));
    }

    // Row separator between data rows (dashed for lighter appearance)
    if (rowSeparator && r > 0 && r < allRows.length - 1) {
      lines.push(rowSepLine);
    }
  }

  // Bottom border
  lines.push(
    colorLine(
      horizontalLine(columnWidths, {
        left: border.bottomLeft,
        junction: border.bottomT,
        right: border.bottomRight,
        horizontal: hz,
      })
    )
  );

  return `${lines.join("\n")}\n`;
}

/** Build a horizontal border line from column widths and junction characters. */
function horizontalLine(
  columnWidths: number[],
  chars: { left: string; junction: string; right: string; horizontal: string }
): string {
  const segments = columnWidths.map((w) => chars.horizontal.repeat(w));
  return `${chars.left}${segments.join(chars.junction)}${chars.right}`;
}

/** Options for creating a streaming table. */
export type StreamingTableOptions = {
  /** Border style. @default "rounded" */
  borderStyle?: BorderStyle;
  /** Horizontal cell padding (each side). @default 1 */
  cellPadding?: number;
  /** Maximum table width in columns. @default process.stdout.columns or 80 */
  maxWidth?: number;
  /** Per-column alignment (indexed by column). Defaults to "left". */
  alignments?: Array<Alignment | null>;
  /** Per-column minimum content widths. Columns will not shrink below these. */
  minWidths?: number[];
  /** Per-column shrinkable flags. Non-shrinkable columns keep intrinsic width. */
  shrinkable?: boolean[];
  /** Truncate cells to one line with "…" instead of wrapping. @default true */
  truncate?: boolean;
  /**
   * Hint rows used for column width measurement.
   * Pass representative sample data so column widths are computed correctly
   * without needing the full dataset upfront.
   */
  hintRows?: string[][];
};

/**
 * A bordered table that renders incrementally — header first, then one row
 * at a time, then a bottom border at the end. Column widths are fixed at
 * construction time based on headers + optional hint rows.
 *
 * Usage:
 * ```ts
 * const table = new StreamingTable(["Time", "Level", "Message"], opts);
 * writer.write(table.header());
 * writer.write(table.row(["2026-02-28 10:00", "ERROR", "something broke"]));
 * writer.write(table.footer());
 * ```
 *
 * In plain-output mode (non-TTY), emits raw CommonMark markdown table syntax
 * so piped/redirected output remains a valid document.
 */
export class StreamingTable {
  /** @internal */ readonly columnWidths: number[];
  /** @internal */ readonly border: BorderCharacters;
  /** @internal */ readonly cellPadding: number;
  /** @internal */ readonly alignments: Array<Alignment | null>;
  /** @internal */ readonly headers: string[];
  /** @internal */ readonly truncate: boolean;

  constructor(headers: string[], options: StreamingTableOptions = {}) {
    const {
      borderStyle = "rounded",
      cellPadding = 1,
      maxWidth = process.stdout.columns || 80,
      alignments = [],
      minWidths = [],
      shrinkable = [],
      truncate = true,
      hintRows = [],
    } = options;

    this.headers = headers;
    this.border = BorderChars[borderStyle];
    this.cellPadding = cellPadding;
    this.alignments = alignments;
    this.truncate = truncate;

    const colCount = headers.length;
    const intrinsicWidths = measureIntrinsicWidths(
      headers,
      hintRows,
      colCount,
      { cellPadding, minWidths }
    );

    const borderOverhead = 2 + (colCount - 1);
    const maxContentWidth = Math.max(colCount, maxWidth - borderOverhead);
    this.columnWidths = fitColumns(intrinsicWidths, maxContentWidth, {
      cellPadding,
      fitter: "balanced",
      minWidths,
      shrinkable,
    });

    // Expand last column to fill remaining terminal width — hint rows
    // underestimate the true content width, so absorb the slack.
    const totalFitted = this.columnWidths.reduce((s, w) => s + w, 0);
    const lastIdx = this.columnWidths.length - 1;
    if (totalFitted < maxContentWidth && lastIdx >= 0) {
      this.columnWidths[lastIdx] =
        (this.columnWidths[lastIdx] ?? 0) + (maxContentWidth - totalFitted);
    }
  }

  /**
   * Render the top border, header row, and header separator.
   * Call once at the start of streaming.
   */
  header(): string {
    const { border, columnWidths, cellPadding, alignments, headers } = this;
    const hz = border.horizontal;
    const lines: string[] = [];

    // Top border
    lines.push(
      horizontalLine(columnWidths, {
        left: border.topLeft,
        junction: border.topT,
        right: border.topRight,
        horizontal: hz,
      })
    );

    // Header cells
    const wrappedHeader = wrapRow(headers, columnWidths, cellPadding, false);
    const rowHeight = Math.max(1, ...wrappedHeader.map((c) => c.length));
    for (let line = 0; line < rowHeight; line++) {
      const cellTexts: string[] = [];
      for (let c = 0; c < columnWidths.length; c++) {
        const cellLines = wrappedHeader[c] ?? [""];
        const text = cellLines[line] ?? "";
        const align = alignments[c] ?? "left";
        const colW = columnWidths[c] ?? 3;
        cellTexts.push(padCell(text, colW, align, cellPadding));
      }
      lines.push(
        `${border.vertical}${cellTexts.join(border.vertical)}${border.vertical}`
      );
    }

    // Header separator
    lines.push(
      horizontalLine(columnWidths, {
        left: border.leftT,
        junction: border.cross,
        right: border.rightT,
        horizontal: hz,
      })
    );

    return `${lines.join("\n")}\n`;
  }

  /**
   * Render a single data row with side borders.
   * Call once per data item as it arrives.
   */
  row(cells: string[]): string {
    const { border, columnWidths, cellPadding, alignments, truncate } = this;
    const wrappedCells = wrapRow(cells, columnWidths, cellPadding, truncate);
    const rowHeight = Math.max(1, ...wrappedCells.map((c) => c.length));
    const lines: string[] = [];

    for (let line = 0; line < rowHeight; line++) {
      const cellTexts: string[] = [];
      for (let c = 0; c < columnWidths.length; c++) {
        const cellLines = wrappedCells[c] ?? [""];
        const text = cellLines[line] ?? "";
        const align = alignments[c] ?? "left";
        const colW = columnWidths[c] ?? 3;
        cellTexts.push(padCell(text, colW, align, cellPadding));
      }
      lines.push(
        `${border.vertical}${cellTexts.join(border.vertical)}${border.vertical}`
      );
    }

    return `${lines.join("\n")}\n`;
  }

  /**
   * Render the bottom border.
   * Call once when the stream ends.
   */
  footer(): string {
    const { border, columnWidths } = this;
    return `${horizontalLine(columnWidths, {
      left: border.bottomLeft,
      junction: border.bottomT,
      right: border.bottomRight,
      horizontal: border.horizontal,
    })}\n`;
  }
}
