/**
 * Backward-compat re-export: `sentry send-event` → `sentry event send`.
 *
 * Registered as a hidden alias in app.ts. The canonical command lives
 * in `event/send.ts`.
 */

// biome-ignore lint/performance/noBarrelFile: backward-compat alias, not a barrel
export { sendCommand as sendEventCommand } from "./event/send.js";
