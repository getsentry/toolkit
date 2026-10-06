/**
 * Sentry data retention constants
 *
 * Two decoupled concepts live here — keep them distinct:
 *
 * - {@link RETENTION_DAYS} — hard product retention cap per entity. After
 *   this many days the entity is gone for good. Used in error messages
 *   when we can speak with certainty (e.g., UUIDv7 timestamps on logs).
 *
 * - {@link SCAN_PERIODS} — how far back fuzzy recovery will scan via the
 *   Events API when a user passes a truncated prefix. Smaller than the
 *   retention cap because the Events API's spans/logs datasets become
 *   sparse (or hit a degraded query path, per `api/logs.ts`) beyond this
 *   window. These are operational tunings, not product facts.
 *
 * Changing `RETENTION_DAYS.log` also updates {@link LOG_RETENTION_PERIOD}
 * (derived). Changing `SCAN_PERIODS.log` is an independent decision about
 * how far to scan — the two constants have different meanings and are
 * intentionally not linked.
 */

import type { HexEntityType } from "./hex-id.js";

/**
 * Hard retention cap, in days, per entity type.
 *
 * - `log`: 90 days — a global Sentry product limit (all plans).
 * - `event` / `trace`: `null` because retention is plan-dependent. The CLI
 *   can't assume a value without querying the org's settings, so callers
 *   that need a precise statement should check `null` and fall back to a
 *   generic retention hint.
 * - `span`: tied to trace retention (spans live within traces).
 */
export const RETENTION_DAYS: Record<HexEntityType, number | null> = {
  log: 90,
  event: null,
  trace: null,
  span: null,
};

/**
 * Default fuzzy-recovery scan window, as an API `statsPeriod` string.
 *
 * Keep this **separate** from {@link RETENTION_DAYS} — scan windows are
 * about query cost and API behavior, not product retention. For logs in
 * particular, the Events API's `dataset=logs` path warns that periods
 * above 30d hit a degraded endpoint with stale/incomplete data — so we
 * cap the scan window at 30d even though the retention window is 90d.
 *
 * The "no-matches" hint in recovery explains this boundary: a log that's
 * within retention but outside the scan window needs to be looked up by
 * its full ID rather than a prefix.
 */
export const SCAN_PERIODS: Record<HexEntityType, string> = {
  event: "90d",
  trace: "30d",
  log: "30d",
  span: "30d",
};

/**
 * Log retention as a Sentry-API `statsPeriod` string (e.g. "90d").
 *
 * Derived from {@link RETENTION_DAYS.log}, which is always a positive
 * number (logs have a guaranteed hard retention cap). If a future
 * refactor ever makes this nullable we want to fail loudly rather than
 * silently substitute a wrong value, so this build-time assertion
 * encodes the invariant.
 */
const LOG_RETENTION_CAP = RETENTION_DAYS.log;
if (LOG_RETENTION_CAP === null || LOG_RETENTION_CAP <= 0) {
  throw new Error(
    `RETENTION_DAYS.log must be a positive number; got ${LOG_RETENTION_CAP}`
  );
}
export const LOG_RETENTION_PERIOD = `${LOG_RETENTION_CAP}d`;
