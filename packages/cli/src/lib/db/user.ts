/**
 * User identity storage for telemetry.
 *
 * Stores user info fetched from Sentry API to set Sentry user context.
 */

import { getDatabase } from "./index.js";
import { runUpsert } from "./utils.js";

export type UserInfo = {
  userId: string;
  email?: string;
  username?: string;
  /** Display name (different from username) */
  name?: string;
};

type UserRow = {
  user_id: string;
  email: string | null;
  username: string | null;
  name: string | null;
};

/**
 * Get stored user info.
 * Returns undefined if no user info is stored.
 */
export function getUserInfo(): UserInfo | undefined {
  const db = getDatabase();
  const row = db.query("SELECT * FROM user_info WHERE id = 1").get() as
    | UserRow
    | undefined;

  if (!row) {
    return;
  }

  return {
    userId: row.user_id,
    email: row.email ?? undefined,
    username: row.username ?? undefined,
    name: row.name ?? undefined,
  };
}

/**
 * Store user info.
 * Overwrites any existing user info.
 */
export function setUserInfo(info: UserInfo): void {
  const db = getDatabase();
  const now = Date.now();

  runUpsert(
    db,
    "user_info",
    {
      id: 1,
      user_id: info.userId,
      email: info.email ?? null,
      username: info.username ?? null,
      name: info.name ?? null,
      updated_at: now,
    },
    ["id"]
  );
}
