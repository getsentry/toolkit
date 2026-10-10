/**
 * Human-friendly boolean value parser.
 *
 * Adapted from Sentry JS SDK's `envToBool`. Handles common affirmative/negative
 * representations used in CLI arguments, environment variables, and config files.
 *
 * @see https://github.com/getsentry/sentry-javascript/blob/2af59be7d39d0a72dcde63808453cbf8f4b1d2cd/packages/core/src/utils/envToBool.ts
 */

const TRUTHY_VALUES = new Set(["true", "t", "y", "yes", "on", "1"]);
const FALSY_VALUES = new Set(["false", "f", "n", "no", "off", "0"]);

/**
 * Parse a human-friendly boolean string value.
 *
 * Recognized values (case-insensitive, whitespace-trimmed):
 * - True:  `on`, `yes`, `true`, `1`, `t`, `y`
 * - False: `off`, `no`, `false`, `0`, `f`, `n`
 *
 * @param input - Raw string value
 * @returns `true` or `false` for recognized values, `null` for unrecognized input
 */
export function parseBoolValue(input: string): boolean | null {
  const normalized = input.toLowerCase().trim();

  if (TRUTHY_VALUES.has(normalized)) {
    return true;
  }

  if (FALSY_VALUES.has(normalized)) {
    return false;
  }

  return null;
}
