/**
 * Release channel persistence.
 *
 * Stores the user's chosen release channel ("stable" or "nightly") in the
 * metadata table. Defaults to "stable" if not set.
 *
 * The channel controls which version stream `upgrade` and `version-check` use:
 * - "stable": tracks the latest GitHub release (default)
 * - "nightly": tracks the rolling nightly prerelease built from main
 */

import { getDatabase } from "./index.js";
import { getMetadata, setMetadata } from "./utils.js";
import { clearVersionCheckCache } from "./version-check.js";

const KEY = "release_channel";

/** The release channel a user tracks for upgrades and version-check notifications. */
export type ReleaseChannel = "stable" | "nightly";

/**
 * Get the persisted release channel.
 *
 * @returns The stored channel, or "stable" if not yet set.
 */
export function getReleaseChannel(): ReleaseChannel {
  const db = getDatabase();
  const m = getMetadata(db, [KEY]);

  if (m.get(KEY) === "nightly") {
    return "nightly";
  }
  return "stable";
}

/**
 * Persist the release channel.
 *
 * If the channel has changed, the cached version-check result is also cleared
 * so the next notification does not display a stale version from the old channel
 * (e.g. a cached stable version labelled as a nightly update after switching).
 *
 * @param channel - Channel to store
 */
export function setReleaseChannel(channel: ReleaseChannel): void {
  const db = getDatabase();
  const current = getReleaseChannel();
  setMetadata(db, { [KEY]: channel });
  if (channel !== current) {
    clearVersionCheckCache();
  }
}

/**
 * Parse and validate a release channel from user input.
 *
 * @param value - Raw string from --channel flag or "nightly"/"stable" positional
 * @returns Validated ReleaseChannel
 * @throws {Error} When the value is not a recognized channel
 */
export function parseReleaseChannel(value: string): ReleaseChannel {
  const normalized = value.toLowerCase();
  if (normalized === "stable" || normalized === "nightly") {
    return normalized;
  }
  throw new Error(`Invalid channel: ${value}. Must be one of: stable, nightly`);
}
