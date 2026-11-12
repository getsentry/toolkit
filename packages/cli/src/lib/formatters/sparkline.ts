/**
 * Unicode block-character sparkline renderer.
 *
 * Maps numeric data points to Unicode block characters (▁▂▃▄▅▆▇█)
 * for compact inline trend visualization in terminal tables.
 *
 * Zero values use `⎽` (U+23BD scan line 9) as a thin baseline marker.
 * Non-zero values map to `▁`–`█` (8 levels), so even the smallest
 * positive value is visibly taller than zero.
 *
 * Each block character is exactly 1 terminal column wide (verified by
 * `string-width`), making sparklines safe for column-aligned table output.
 */

/** 8 block characters for non-zero values, ordered by height (1/8 to 8/8). */
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * Scan-line character used to represent zero-value data points.
 *
 * U+23BD HORIZONTAL SCAN LINE-9 — a thin horizontal line at the very bottom
 * of the character cell. Visually thinner than `▁` (lower 1/8 block) while
 * staying vertically aligned with block-drawing characters, unlike text-metric
 * characters (`_`, underlined space) which sit at the text descender.
 */
const ZERO_CHAR = "⎽";

/** Character for a data point with no measurement: a blank gap. */
const GAP_CHAR = " ";

/** Default sparkline width when not specified. */
const DEFAULT_WIDTH = 8;

/**
 * Downsample an array of values to a target length by averaging buckets.
 *
 * Divides the source array into `targetLen` equal-width buckets and returns
 * the mean of each bucket's measured (non-null) values. A bucket with no
 * measured value stays null, so a gap is never averaged into a zero. When
 * `values.length <= targetLen`, returns the original array unchanged.
 *
 * @param values - Source data points; null marks a point with no measurement
 * @param targetLen - Desired output length (must be >= 1)
 * @returns Downsampled values with length <= targetLen
 */
export function downsample<T extends number | null>(
  values: T[],
  targetLen: number,
): T[] {
  if (values.length <= targetLen) {
    return values;
  }

  const bucketSize = values.length / targetLen;
  const result: (number | null)[] = [];

  for (let i = 0; i < targetLen; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.floor((i + 1) * bucketSize);
    let sum = 0;
    let measured = 0;
    for (let j = start; j < end; j++) {
      const value = values[j];
      if (value !== null && value !== undefined) {
        sum += value;
        measured += 1;
      }
    }
    result.push(measured > 0 ? sum / measured : null);
  }

  // Only all-null source buckets produce null, so number input stays number.
  return result as T[];
}

/**
 * Render a sparkline string from numeric values using Unicode block characters.
 *
 * Zero maps to `⎽` (scan line). Non-zero values map to `▁`–`█` (8 levels)
 * based on proportion of the maximum. Null (no measurement) maps to a blank
 * gap so it never looks like zero. When data has more points than `width`,
 * adjacent points are averaged (downsampled). When fewer, the natural
 * length is preserved (no upsampling to avoid visual artifacts).
 *
 * @param values - Data points (e.g., event counts per time bucket); null marks
 *   a point with no measurement
 * @param width - Maximum sparkline width in characters. Defaults to 8.
 * @returns Sparkline string, or empty string if no data
 *
 * @example
 * sparkline([0, 1, 3, 7, 4, 2, 1, 0])  // "⎽▁▃█▅▂▁⎽"
 * sparkline([0, 0, 0, 0])               // "⎽⎽⎽⎽"
 * sparkline([4, null, 8])                // "▄ █"
 * sparkline([])                          // ""
 */
export function sparkline(
  values: (number | null)[],
  width = DEFAULT_WIDTH,
): string {
  if (values.length === 0) {
    return "";
  }

  const sampled = downsample(values, width);
  // -Infinity when nothing was measured, but then every point is a gap.
  const max = Math.max(...sampled.filter((v) => v !== null));

  return sampled
    .map((v) => {
      if (v === null) {
        return GAP_CHAR;
      }
      // Zero, or every measured value is zero: flat baseline
      if (v === 0 || max === 0) {
        return ZERO_CHAR;
      }
      const normalized = Math.round((v / max) * 7);
      return BLOCKS[Math.min(7, Math.max(0, normalized))] ?? BLOCKS[0];
    })
    .join("");
}
