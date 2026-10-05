/**
 * Installation info persistence.
 *
 * Stores how the CLI was installed (method, path, version) in the metadata table.
 * This is used by the upgrade command to determine the appropriate upgrade method
 * without re-detecting every time.
 */

import type { InstallationMethod } from "../binary.js";
import { getDatabase } from "./index.js";
import { clearMetadata, getMetadata, setMetadata } from "./utils.js";

const KEY_METHOD = "install.method";
const KEY_PATH = "install.path";
const KEY_VERSION = "install.version";
const KEY_RECORDED_AT = "install.recorded_at";

const ALL_KEYS = [KEY_METHOD, KEY_PATH, KEY_VERSION, KEY_RECORDED_AT];

export type StoredInstallInfo = {
  /** How the CLI was installed */
  method: InstallationMethod;
  /** Absolute path to the binary */
  path: string;
  /** Version when installed or last upgraded */
  version: string;
  /** Unix timestamp (ms) when this info was recorded */
  recordedAt: number;
};

/**
 * Get the stored installation info.
 *
 * @returns Installation info if recorded, null otherwise
 */
export function getInstallInfo(): StoredInstallInfo | null {
  const db = getDatabase();
  const m = getMetadata(db, ALL_KEYS);

  const method = m.get(KEY_METHOD);
  if (!method) {
    return null;
  }

  return {
    method: method as InstallationMethod,
    path: m.get(KEY_PATH) ?? "",
    version: m.get(KEY_VERSION) ?? "",
    recordedAt: m.has(KEY_RECORDED_AT) ? Number(m.get(KEY_RECORDED_AT)) : 0,
  };
}

/**
 * Store installation info.
 *
 * @param info - Installation info to store (recordedAt is auto-set to now)
 */
export function setInstallInfo(
  info: Omit<StoredInstallInfo, "recordedAt">
): void {
  const db = getDatabase();
  setMetadata(db, {
    [KEY_METHOD]: info.method,
    [KEY_PATH]: info.path,
    [KEY_VERSION]: info.version,
    [KEY_RECORDED_AT]: String(Date.now()),
  });
}

/**
 * Clear stored installation info.
 * Useful for testing or when user wants to re-detect.
 */
export function clearInstallInfo(): void {
  const db = getDatabase();
  clearMetadata(db, ALL_KEYS);
}
