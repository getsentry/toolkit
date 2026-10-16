/**
 * User identity of the active stored account.
 *
 * Stores user info fetched from Sentry API on the active `accounts` row,
 * used for display and to set Sentry user context.
 */

import { withDbSpan } from "../telemetry.js";
import {
  deleteAccountRows,
  getActiveAccountRow,
  listAccountRows,
} from "./accounts.js";
import { getDatabase } from "./index.js";

export type UserInfo = {
  userId: string;
  email?: string;
  username?: string;
  /** Display name (different from username) */
  name?: string;
};

/**
 * Get the active account's user info.
 * Returns undefined when no account is active or its user is not known yet.
 */
export function getUserInfo(): UserInfo | undefined {
  const row = getActiveAccountRow();
  if (!row?.user_id) {
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
 * Record who the active account's credentials belong to.
 *
 * Any other stored account for the same user on the same host is removed:
 * logging in again to an existing account replaces its old credentials
 * instead of adding a duplicate. No-op when no account is active (for
 * example, when only an env-var token is in use).
 */
export function setUserInfo(info: UserInfo): void {
  withDbSpan("setUserInfo", () => {
    const active = getActiveAccountRow();
    if (!active) {
      return;
    }
    const duplicates = listAccountRows().filter(
      (row) =>
        row.account_id !== active.account_id &&
        row.user_id === info.userId &&
        row.host === active.host,
    );
    // OAuth login responses carry no username. Keep one already known for
    // this user — on this row or on a duplicate about to be folded into it —
    // so `sentry auth switch <username>` keeps working after a re-login.
    const knownUsername =
      (active.user_id === info.userId ? active.username : null) ??
      duplicates.find((row) => row.username)?.username ??
      null;
    const db = getDatabase();
    db.query(
      "UPDATE accounts SET user_id = ?, email = ?, username = ?, name = ?, updated_at = ? WHERE account_id = ?",
    ).run(
      info.userId,
      info.email ?? null,
      info.username ?? knownUsername,
      info.name ?? null,
      Date.now(),
      active.account_id,
    );
    deleteAccountRows(duplicates);
  });
}
