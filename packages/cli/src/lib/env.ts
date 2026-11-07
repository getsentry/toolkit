/**
 * Environment variable registry for CLI/library isolation.
 *
 * CLI mode never calls `setEnv()`, so `getEnv()` returns `process.env`.
 * Library mode calls `setEnv()` with a merged env copy — the consumer's
 * `process.env` is never mutated.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const invocationEnvironments = new AsyncLocalStorage<NodeJS.ProcessEnv>();
const envState: { defaultEnv: NodeJS.ProcessEnv } = { defaultEnv: process.env };

/** Get the active environment. Library mode overrides this; CLI uses process.env. */
export function getEnv(): NodeJS.ProcessEnv {
  return invocationEnvironments.getStore() ?? envState.defaultEnv;
}

/** Set the active environment for this invocation. */
export function setEnv(env: NodeJS.ProcessEnv): void {
  envState.defaultEnv = env;
}

/** Isolate overlapping SDK invocations without changing the process environment. */
export function withEnv<T>(env: NodeJS.ProcessEnv, callback: () => T): T {
  return invocationEnvironments.run(env, callback);
}

// ---------------------------------------------------------------------------
// Per-invocation module state
// ---------------------------------------------------------------------------
//
// CLI mode runs one command per process, so module state lasts exactly as
// long as the command. Library mode (`sdk-invoke.ts`) runs many commands in
// one long-lived process, and they can overlap. State such as `--fresh`
// cache bypasses, once-per-command warnings, and the login trust anchor must
// not carry from one call into another. `withInvocation()` gives each SDK
// call its own store. Outside one (CLI mode) a single process-wide store is
// used, so CLI behavior does not change.
//
// State keyed by the env object (see `db/account-scope.ts`) is per env copy.
// This store is per call: it survives the env copies that
// `withStoredAccount()` makes for each account within the same call, so a
// `--fresh` flag still reaches every account.

type InvocationStore = Map<object, unknown>;

const invocationStores = new AsyncLocalStorage<InvocationStore>();
const processStore: InvocationStore = new Map();

/** Run one SDK invocation with its own env and its own invocation state. */
export function withInvocation<T>(
  env: NodeJS.ProcessEnv,
  callback: () => T,
): T {
  return withEnv(env, () => invocationStores.run(new Map(), callback));
}

/**
 * Declare one piece of per-invocation state. The returned getter builds the
 * value with `init` the first time an invocation reads it, then returns the
 * same value for the rest of that invocation.
 */
export function invocationState<T extends object>(init: () => T): () => T {
  const key = {};
  return () => {
    const store = invocationStores.getStore() ?? processStore;
    let value = store.get(key) as T | undefined;
    if (value === undefined) {
      value = init();
      store.set(key, value);
    }
    return value;
  };
}

/**
 * Internal env var `createSentrySDK()` sets for each invocation unless it's
 * created with `persist: true`. With it set, the invocation reads `cli.db`
 * through a read-only view and writes no local state: the response cache, the
 * pagination cursor stack, and version checks are off.
 */
export const NO_PERSISTENCE_ENV_VAR = "SENTRY_CLI_NO_PERSISTENCE";

/** Whether the current invocation runs with persistence off. */
export function isPersistenceDisabled(): boolean {
  return getEnv()[NO_PERSISTENCE_ENV_VAR] === "1";
}
