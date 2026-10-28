export const TELEMETRY_PREFIX = "🔎 [Telemetry]";

const noop = (..._args: unknown[]) => {};
let _log = noop;
let _warn = noop;

export function activateLogger() {
  _log = (...args: unknown[]) => console.log(TELEMETRY_PREFIX, ...args);
  _warn = (...args: unknown[]) => console.warn(TELEMETRY_PREFIX, ...args);
}

export function deactivateLogger() {
  _log = noop;
  _warn = noop;
}

export function log(...args: unknown[]) {
  _log(...args);
}

export function warn(...args: unknown[]) {
  _warn(...args);
}
