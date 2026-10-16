/**
 * Per-invocation account selection.
 *
 * Commands can resolve which stored account to use from what they target
 * (see `selectAccountForOrg` in `auth.ts`). The choice lives here, keyed by
 * the invocation's environment object: CLI runs share `process.env`, while
 * each library-mode invocation gets its own isolated env and therefore its
 * own selection. It is never persisted — `sentry auth switch` owns the
 * stored active account.
 */

import { getEnv } from "../env.js";

type AccountScope = {
  /** Stored account pinned for the rest of this invocation. */
  accountId?: string;
};

let scopes = new WeakMap<NodeJS.ProcessEnv, AccountScope>();

/** The mutable account selection for the current invocation. */
export function getAccountScope(): AccountScope {
  const env = getEnv();
  let scope = scopes.get(env);
  if (!scope) {
    scope = {};
    scopes.set(env, scope);
  }
  return scope;
}

/** Forget every invocation's account selection. Tests only. */
export function resetAccountScopes(): void {
  scopes = new WeakMap();
}
