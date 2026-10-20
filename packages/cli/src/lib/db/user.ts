/**
 * User identity of the stored account in effect.
 *
 * Stores user info fetched from Sentry API on the `accounts` row whose
 * credentials the invocation uses (usually the active one; see
 * `getEffectiveAccountRow`), for display and to set Sentry user context.
 */

import { withDbSpan } from "../telemetry.js";
import {
  deleteAccountRows,
  isAccountOnServer,
  listAccountRows,
} from "./accounts.js";
import { getEffectiveAccountRow } from "./auth.js";
import { getDatabase } from "./index.js";

export type UserInfo = {
  userId: string;
  email?: string;
  username?: string;
  /** Display name (different from username) */
  name?: string;
};

/**
 * Get the user info of the account in effect.
 * Returns undefined when no stored account is in use or its user is not known yet.
 */
export function getUserInfo(): UserInfo | undefined {
  const row = getEffectiveAccountRow();
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
 * Record who the in-effect account's credentials belong to.
 *
 * Any other stored account for the same user on the same server is
 * removed: logging in again to an existing account replaces its old
 * credentials instead of adding a duplicate. "Same server" matches `--url`
 * selection, so every `*.sentry.io` region counts as SaaS. No-op when no
 * stored account is in use (for example, when only an env-var token is in
 * use).
 *
 * Leaves `updated_at` alone: it versions the stored credential for refresh
 * compare-and-swap, and identity writes must not invalidate an in-flight
 * refresh.
 */
export function setUserInfo(info: UserInfo): void {
  withDbSpan("setUserInfo", () => {
    const active = getEffectiveAccountRow();
    if (!active) {
      return;
    }
    const duplicates = listAccountRows().filter(
      (row) =>
        row.account_id !== active.account_id &&
        row.user_id === info.userId &&
        isSameAccountServer(row.host, active.host),
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
      "UPDATE accounts SET user_id = ?, email = ?, username = ?, name = ? WHERE account_id = ?",
    ).run(
      info.userId,
      info.email ?? null,
      info.username ?? knownUsername,
      info.name ?? null,
      active.account_id,
    );
    deleteAccountRows(duplicates);
  });
}

/**
 * Forget who the in-effect account's credentials belong to. Used after its
 * credentials were replaced in place without user info for the new ones,
 * so list/switch/status never show the previous user against a new token.
 * Leaves `updated_at` alone (see {@link setUserInfo}).
 */
export function clearUserInfo(): void {
  withDbSpan("clearUserInfo", () => {
    const active = getEffectiveAccountRow();
    if (!active) {
      return;
    }
    getDatabase()
      .query(
        "UPDATE accounts SET user_id = NULL, email = NULL, username = NULL, name = NULL WHERE account_id = ?",
      )
      .run(active.account_id);
  });
}

/** Same server for duplicate folding; a NULL (pre-v16) host only matches NULL. */
function isSameAccountServer(a: string | null, b: string | null): boolean {
  if (!(a && b)) {
    return a === b;
  }
  return isAccountOnServer({ host: a }, b);
}
