/**
 * Sentry stats period and interval strings, such as `24h` or `7d`, shared by
 * the CLI and the MCP server.
 */

/** Seconds per unit in a stats period string. */
export const STATS_PERIOD_UNIT_SECONDS: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
  w: 604_800,
};

export const ONE_DAY_SECONDS = 86_400;

const STATS_PERIOD_PATTERN = /^(\d+)([smhdw])$/;
const STATS_INTERVAL_PATTERN = /^(\d+)([smhdw]?)$/;

/** Parse a stats period string into seconds, or `undefined` if it is not one. */
export function statsPeriodToSeconds(period: string): number | undefined {
  return parseSeconds(STATS_PERIOD_PATTERN, period);
}

/**
 * Parse a stats `interval` the way Sentry does (`^(\d+)([hdmsw]?)$`): a bare
 * number is seconds. Returns `undefined` if it is not an interval.
 */
export function statsIntervalToSeconds(interval: string): number | undefined {
  return parseSeconds(STATS_INTERVAL_PATTERN, interval);
}

function parseSeconds(pattern: RegExp, value: string): number | undefined {
  const match = pattern.exec(value);
  const unitSeconds = match
    ? STATS_PERIOD_UNIT_SECONDS[match[2] || "s"]
    : undefined;
  if (!match || unitSeconds === undefined) {
    return undefined;
  }
  return Number(match[1]) * unitSeconds;
}
