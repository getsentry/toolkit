/**
 * Display helpers for the env token's virtual account.
 *
 * `SENTRY_AUTH_TOKEN`/`SENTRY_TOKEN` with a trusted server acts as one
 * more account next to stored logins (see `getEnvAccount` in `db/auth.ts`).
 * It is never stored, so nothing records whose token it is; commands that
 * list accounts ask the server (`/auth/`) when they show it.
 */

import { getCurrentUser } from "./api-client.js";
import { type AccountSummary, toEnvAccountSummary } from "./db/accounts.js";
import { type EnvAccount, getRawEnvToken, withEnvAccount } from "./db/auth.js";
import { logger } from "./logger.js";
import { classifySentryToken } from "./token-type.js";
import type { SentryUser } from "../types/index.js";

const log = logger.withTag("auth.env-account");

/**
 * The user behind the env token, from `/auth/` on its own server.
 * `undefined` for organization auth tokens (`sntrys_`), which belong to no
 * user, and when the request fails: identifying the token is best-effort.
 */
export async function fetchEnvAccountUser(
  account: EnvAccount,
): Promise<SentryUser | undefined> {
  const token = getRawEnvToken();
  if (!token || classifySentryToken(token) === "org-auth-token") {
    return;
  }
  try {
    return await withEnvAccount(account, () => getCurrentUser());
  } catch (error) {
    log.debug(`Could not identify the ${account.envVar} user`, error);
    return;
  }
}

/** The env token's account summary, with its user when the server says. */
export async function describeEnvAccount(
  account: EnvAccount,
): Promise<AccountSummary> {
  const user = await fetchEnvAccountUser(account);
  return toEnvAccountSummary(account.envVar, account.host, user);
}
