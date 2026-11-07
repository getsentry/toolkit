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

/**
 * Internal env var `createSentrySDK({ persist: false })` sets for one
 * invocation. With it set, the invocation reads and writes nothing local: the
 * database is a null store, and the response cache, `.sentryclirc` files,
 * custom CA files, version checks, and telemetry are off.
 */
export const NO_PERSISTENCE_ENV_VAR = "SENTRY_CLI_NO_PERSISTENCE";

/** Whether the current invocation runs with persistence off. */
export function isPersistenceDisabled(): boolean {
  return getEnv()[NO_PERSISTENCE_ENV_VAR] === "1";
}
