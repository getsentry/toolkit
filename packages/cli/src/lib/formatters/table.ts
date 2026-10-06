/**
 * Generic column-based table renderer.
 *
 * - {@link formatTable} returns a table string (for return-based commands)
 * - {@link writeTable} writes the table directly to a stream (legacy path)
 * - {@link buildMarkdownTable} returns raw CommonMark syntax
 *
 * ANSI escape codes in cell values are preserved — `string-width` correctly
 * treats them as zero-width for column sizing.
 */

import type { Writer } from "../../types/index.js";
import {
  escapeMarkdownCell,
  isPlainOutput,
  renderInlineMarkdown,
  stripColorTags,
} from "./markdown.js";
import { type Alignment, renderTextTable } from "./text-table.js";

/**
 * Describes a single column in a table.
 *
 * @template T - Row data type
 */
export type Column<T> = {
  /** Column header label (e.g., "ORG", "SLUG") */
  header: string;
  /** Extract the display value from a row */
  value: (item: T) => string;
  /** Column alignment. Defaults to "left". */
  align?: "left" | "right";
  /** Minimum content width. Column will not shrink below this. */
  minWidth?: number;
  /** Whether this column can be shrunk when the table exceeds terminal width. @default true */
  shrinkable?: boolean;
  /** Truncate long values with "\u2026" instead of wrapping. @default false */
  truncate?: boolean;
};

/**
 * Build a raw CommonMark table string from items and column definitions.
 *
 * Column value functions should call {@link escapeMarkdownCell} on user data so pipe and
 * backslash characters in API-supplied strings don't break the table.
 *
 * Used for plain/non-TTY output mode.
 */
export function buildMarkdownTable<T>(
  items: T[],
  columns: Column<T>[]
): string {
  const header = `| ${columns.map((c) => c.header).join(" | ")} |`;
  const separator = `| ${columns.map((c) => (c.align === "right" ? "---:" : "---")).join(" | ")} |`;
  const rows = items
    .map(
      (item) =>
        `| ${columns.map((c) => stripColorTags(c.value(item))).join(" | ")} |`
    )
    .join("\n");
  return `${header}\n${separator}\n${rows}`;
}

/**
 * Render items as a formatted table.
 *
 * Cell values are markdown strings — in TTY mode they are rendered through
 * \ before column sizing, so \,
 * \code\, and \ in cell values render as styled/clickable text.
 * Pre-existing ANSI codes (e.g. chalk colors) pass through the markdown
 * parser untouched.
 *
 * In plain mode: emits raw CommonMark table syntax.
 *
 * @param stdout - Output writer
 * @param items - Row data
 * @param columns - Column definitions (ordering determines display order)
 */
/** Options for writeTable. */
export type WriteTableOptions = {
  /**
   * Maximum table width in columns. Defaults to the terminal width (or 80).
   * Pass a larger value when a column must stay intact, such as a full
   * event ID, so the fitter does not wrap that row's neighbors into it.
   */
  maxWidth?: number;
  /** Truncate cells to one line with "\u2026" instead of wrapping. @default false */
  truncate?: boolean;
  /**
   * Draw separator lines between data rows.
   * - `false`: no separators
   * - `true`: dashed separators in default color
   * - ANSI escape string: dashed separators in the given color
   */
  rowSeparator?: boolean | string;
};

/**
 * Format items as a table string.
 *
 * Returns the rendered table instead of writing to a stream.
 * Cell values are markdown strings rendered through {@link renderInlineMarkdown},
 * which produces ANSI-styled text in TTY mode and clean plain text when piped.
 * In plain mode, row separator ANSI coloring is stripped to `true` (plain borders).
 */
export function formatTable<T>(
  items: T[],
  columns: Column<T>[],
  options?: WriteTableOptions
): string {
  const headers = columns.map((c) => c.header);
  const alignments: Alignment[] = columns.map((c) => c.align ?? "left");
  const minWidths = columns.map((c) => c.minWidth ?? 0);
  const shrinkable = columns.map((c) => c.shrinkable ?? true);

  const rows = items.map((item) =>
    columns.map((c) => renderInlineMarkdown(c.value(item)))
  );

  return renderTextTable(headers, rows, {
    alignments,
    minWidths,
    shrinkable,
    maxWidth: options?.maxWidth,
    truncate: options?.truncate,
    // Strip ANSI color from row separators in plain mode
    rowSeparator: isPlainOutput()
      ? Boolean(options?.rowSeparator)
      : options?.rowSeparator,
  });
}

/**
 * Render items as a formatted table, writing directly to a stream.
 *
 * Delegates to {@link formatTable} and writes the result. Prefer
 * `formatTable` in return-based command output pipelines.
 */
export function writeTable<T>(
  stdout: Writer,
  items: T[],
  columns: Column<T>[],
  options?: WriteTableOptions
): void {
  stdout.write(formatTable(items, columns, options));
}
