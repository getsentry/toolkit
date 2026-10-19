/**
 * Per-invocation account selection.
 *
 * Commands can resolve which stored account to use from what they target
 * (see `selectAccountForOrg` in `auth.ts`). That choice becomes the
 * invocation's default account: every credential read for the rest of the
 * invocation uses it. It is never persisted — the stored active account
 * (`sentry auth login` / `sentry auth switch`) is untouched, so the next
 * invocation starts from scratch and may pick a different account.
 *
 * Why this is keyed by the environment object instead of being a plain
 * module-level variable:
 *
 * - CLI mode runs one command per process. `getEnv()` always returns
 *   `process.env`, so there is exactly one scope and this behaves like a
 *   module-level variable.
 * - Library mode (`createSentrySDK()`, see `sdk-invoke.ts`) runs many
 *   commands inside the consumer's long-lived process, and they
 *   can overlap: each call builds its own isolated env copy and runs under
 *   `withEnv()` (AsyncLocalStorage), so `getEnv()` returns that copy for
 *   everything the call awaits. A module-level variable would be shared by
 *   all of them — a call targeting org A would select account 1, and a
 *   concurrent (or later) call targeting org B would silently reuse account
 *   1 instead of resolving its own. Keying by the env object gives every
 *   call its own scope with no explicit setup or teardown.
 * - A `WeakMap` lets a finished call's scope be garbage-collected together
 *   with its env copy, so long-running library consumers do not accumulate
 *   one entry per call.
 */

import { getEnv } from "../env.js";

type AccountScope = {
  /** Default account for the rest of this invocation, chosen from its target. */
  accountId?: string;
};

/** One scope per invocation env; see the module comment for why. */
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
