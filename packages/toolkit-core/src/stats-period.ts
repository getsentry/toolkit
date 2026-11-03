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

/** Parse a stats period string into seconds, or `undefined` if it is not one. */
export function statsPeriodToSeconds(period: string): number | undefined {
  const match = STATS_PERIOD_PATTERN.exec(period);
  const unitSeconds = match?.[2]
    ? STATS_PERIOD_UNIT_SECONDS[match[2]]
    : undefined;
  if (!match || unitSeconds === undefined) {
    return undefined;
  }
  return Number(match[1]) * unitSeconds;
}

/**
 * Standard bucket sizes from one minute to one day, ascending. Each is a whole
 * number of minutes that divides one day, which is what Sentry's outcomes and
 * sessions stats endpoints require (`sessions_v2.get_constrained_date_range`).
 */
export const MINUTE_STATS_INTERVALS = [
  "1m",
  "5m",
  "10m",
  "15m",
  "30m",
  "1h",
  "2h",
  "3h",
  "4h",
  "6h",
  "12h",
  "1d",
] as const;
