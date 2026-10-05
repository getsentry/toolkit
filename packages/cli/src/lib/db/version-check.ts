/**
 * Version check state persistence.
 *
 * Stores the last time we checked for updates and the latest known version
 * in the metadata table for the "new version available" notification.
 */

import { getDatabase } from "./index.js";
import { clearMetadata, getMetadata, setMetadata } from "./utils.js";

const KEY_LAST_CHECKED = "version_check.last_checked";
const KEY_LATEST_VERSION = "version_check.latest_version";
/**
 * Timestamp (ms) when we last printed the "new version available"
 * notification to stderr. Separate from `last_checked` so the cached
 * latest-version can stay hot for faster subsequent checks while the
 * notification itself is rate-limited to once per day.
 */
const KEY_LAST_NOTIFIED = "version_check.last_notified";

const ALL_KEYS = [KEY_LAST_CHECKED, KEY_LATEST_VERSION, KEY_LAST_NOTIFIED];

export type VersionCheckInfo = {
  /** Unix timestamp (ms) of last check, or null if never checked */
  lastChecked: number | null;
  /** Latest version string from GitHub, or null if never fetched */
  latestVersion: string | null;
  /** Unix timestamp (ms) when we last printed the update notification, or null */
  lastNotified: number | null;
};

/**
 * Get the stored version check state.
 */
export function getVersionCheckInfo(): VersionCheckInfo {
  const db = getDatabase();
  const m = getMetadata(db, ALL_KEYS);

  const lastChecked = m.get(KEY_LAST_CHECKED);
  const latestVersion = m.get(KEY_LATEST_VERSION);
  const lastNotified = m.get(KEY_LAST_NOTIFIED);

  return {
    lastChecked: lastChecked ? Number(lastChecked) : null,
    latestVersion: latestVersion ?? null,
    lastNotified: lastNotified ? Number(lastNotified) : null,
  };
}

/**
 * Record that we just displayed the update notification.
 *
 * Called from `getUpdateNotification()` so repeat CLI invocations within
 * the rate-limit window don't keep re-printing the same banner.
 */
export function markUpdateNotified(): void {
  const db = getDatabase();
  setMetadata(db, { [KEY_LAST_NOTIFIED]: String(Date.now()) });
}

/**
 * Clear the cached latest version.
 *
 * Should be called when the release channel changes so that stale version
 * data from the previous channel is not shown in update notifications.
 * The last-checked timestamp is also reset so a fresh check is triggered
 * on the next CLI invocation.
 */
export function clearVersionCheckCache(): void {
  const db = getDatabase();
  clearMetadata(db, ALL_KEYS);
}

/**
 * Store the version check result.
 * Updates both the last checked timestamp and the latest known version.
 */
export function setVersionCheckInfo(latestVersion: string): void {
  const db = getDatabase();
  setMetadata(db, {
    [KEY_LAST_CHECKED]: String(Date.now()),
    [KEY_LATEST_VERSION]: latestVersion,
  });
}
