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

/** Default sparkline width when not specified. */
const DEFAULT_WIDTH = 8;

/**
 * Downsample an array of values to a target length by averaging adjacent buckets.
 *
 * Divides the source array into `targetLen` equal-width buckets and returns
 * the mean of each bucket. When `values.length <= targetLen`, returns the
 * original array unchanged.
 *
 * @param values - Source data points
 * @param targetLen - Desired output length (must be >= 1)
 * @returns Downsampled values with length <= targetLen
 */
/** Downsample an array of values to a target length by averaging buckets. */
export function downsample(values: number[], targetLen: number): number[] {
  if (values.length <= targetLen) {
    return values;
  }

  const bucketSize = values.length / targetLen;
  const result: number[] = [];

  for (let i = 0; i < targetLen; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.floor((i + 1) * bucketSize);
    let sum = 0;
    for (let j = start; j < end; j++) {
      sum += values[j] ?? 0;
    }
    result.push(sum / (end - start));
  }

  return result;
}

/**
 * Render a sparkline string from numeric values using Unicode block characters.
 *
 * Zero maps to `⎽` (scan line). Non-zero values map to `▁`–`█` (8 levels)
 * based on proportion of the maximum. When data has more points than `width`,
 * adjacent points are averaged (downsampled). When fewer, the natural
 * length is preserved (no upsampling to avoid visual artifacts).
 *
 * @param values - Numeric data points (e.g., event counts per time bucket)
 * @param width - Maximum sparkline width in characters. Defaults to 8.
 * @returns Sparkline string, or empty string if no data
 *
 * @example
 * sparkline([0, 1, 3, 7, 4, 2, 1, 0])  // "⎽▁▃█▅▂▁⎽"
 * sparkline([0, 0, 0, 0])               // "⎽⎽⎽⎽"
 * sparkline([])                          // ""
 */
export function sparkline(values: number[], width = DEFAULT_WIDTH): string {
  if (values.length === 0) {
    return "";
  }

  const sampled = downsample(values, width);
  const max = Math.max(...sampled);

  // All zeros — flat baseline
  if (max === 0) {
    return ZERO_CHAR.repeat(sampled.length);
  }

  return sampled
    .map((v) => {
      if (v === 0) {
        return ZERO_CHAR;
      }
      const normalized = Math.round((v / max) * 7);
      return BLOCKS[Math.min(7, Math.max(0, normalized))] ?? BLOCKS[0];
    })
    .join("");
}
