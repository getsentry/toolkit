/**
 * Environment variable registry for CLI/library isolation.
 *
 * CLI mode never calls `setEnv()`, so `getEnv()` returns `process.env`.
 * Library mode calls `setEnv()` with a merged env copy — the consumer's
 * `process.env` is never mutated.
 */

let _env: NodeJS.ProcessEnv = process.env;

/** Get the active environment. Library mode overrides this; CLI uses process.env. */
export function getEnv(): NodeJS.ProcessEnv {
  return _env;
}

/** Set the active environment for this invocation. */
export function setEnv(env: NodeJS.ProcessEnv): void {
  _env = env;
}
