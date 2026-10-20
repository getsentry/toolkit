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
