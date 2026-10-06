/**
 * Generic table-rendering helpers driven by Sentry Events API
 * `meta.fields` / `meta.units` metadata.
 *
 * Used by `sentry explore` (and any future command rendering dynamic
 * Discover/Events results) to format cell values according to the
 * field's declared type and unit, and to build right-aligned columns
 * for numeric fields.
 */

import { escapeMarkdownCell } from "./markdown.js";
import { appendUnitSuffix, formatNumber } from "./numbers.js";
import type { Column } from "./table.js";

/** Sentry field types that render as right-aligned numeric columns. */
export const NUMERIC_FIELD_TYPES = new Set([
  "integer",
  "number",
  "duration",
  "percentage",
  "size",
]);

/**
 * Format a single cell value according to its `meta.fields` type.
 *
 * - `null` / `undefined` → `"—"`
 * - `duration` / `size` → `formatNumber` + unit suffix (`"1,234ms"`, `"5MB"`)
 * - `percentage` → multiplied by 100 and suffixed with `%`
 * - other numbers → `formatNumber` (locale grouping, K/M/B above 1M)
 * - non-numeric → `String(value)` with markdown-cell escaping
 */
export function formatCellValue(
  value: unknown,
  fieldType?: string,
  unit?: string | null
): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "number") {
    if (fieldType === "duration" || fieldType === "size") {
      return appendUnitSuffix(formatNumber(value), unit);
    }
    if (fieldType === "percentage") {
      return `${formatNumber(value * 100)}%`;
    }
    return formatNumber(value);
  }
  return escapeMarkdownCell(String(value));
}

/**
 * Build dynamic table columns from API response field metadata.
 *
 * Each field name becomes a column. Numeric fields (per
 * {@link NUMERIC_FIELD_TYPES}) are right-aligned and not truncated.
 *
 * Cell values are extracted from `row[name]` and formatted via
 * {@link formatCellValue}.
 *
 * @param fieldNames - Column order (typically the user's `--field` order)
 * @param fieldTypes - Optional `meta.fields` map: field name → Sentry type
 * @param fieldUnits - Optional `meta.units` map: field name → unit string
 */
export function buildMetaColumns(
  fieldNames: string[],
  fieldTypes?: Record<string, string>,
  fieldUnits?: Record<string, string | null>
): Column<Record<string, unknown>>[] {
  return fieldNames.map((name) => {
    const fieldType = fieldTypes?.[name];
    const unit = fieldUnits?.[name];
    const isNumeric = fieldType ? NUMERIC_FIELD_TYPES.has(fieldType) : false;

    return {
      header: name.toUpperCase(),
      value: (row) => formatCellValue(row[name], fieldType, unit),
      align: isNumeric ? ("right" as const) : ("left" as const),
      truncate: !isNumeric,
    };
  });
}
