/**
 * Environment variable registry for CLI/library isolation.
 *
 * CLI mode never calls `setEnv()`, so `getEnv()` returns `process.env`.
 * SDK invocations own an async context, including work that outlives their
 * command handler. The consumer's `process.env` is never mutated.
 */

import { AsyncLocalStorage } from "node:async_hooks";

type InvocationContext = { env: NodeJS.ProcessEnv };
const invocationContext = new AsyncLocalStorage<InvocationContext>();

const envState: { defaultEnv: NodeJS.ProcessEnv } = { defaultEnv: process.env };

/** Get the active environment. Library mode overrides this; CLI uses process.env. */
export function getEnv(): NodeJS.ProcessEnv {
  return invocationContext.getStore()?.env ?? envState.defaultEnv;
}

/** Set the fallback environment outside SDK invocations (used by tests). */
export function setEnv(env: NodeJS.ProcessEnv): void {
  envState.defaultEnv = env;
}

/** Run with a captured environment; asynchronous descendants retain it. */
export function withEnv<T>(env: NodeJS.ProcessEnv, run: () => T): T {
  return invocationContext.run({ env }, run);
}

/**
 * Lazily create module-owned state for each SDK invocation, or one shared
 * instance for CLI mode. Weak keys let finished invocations be collected
 * without clearing state still needed by pending requests.
 */
export function createInvocationState<T extends object>(
  create: () => T
): () => T {
  const states = new WeakMap<InvocationContext, T>();
  let cliState: T | undefined;
  return () => {
    const context = invocationContext.getStore();
    if (!context) {
      cliState ??= create();
      return cliState;
    }
    let state = states.get(context);
    if (!state) {
      state = create();
      states.set(context, state);
    }
    return state;
  };
}
