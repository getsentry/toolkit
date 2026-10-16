/** Optional SSE metadata used to bootstrap the Local session picker. */
export const LOCAL_DIRECTORY_EVENT = "sentry.local.directory";

/** Ordered lifecycle metadata follows replayed envelopes on a scoped stream. */
export const LOCAL_SESSION_EVENT = "sentry.local.session";
export type LocalSessionEvent = {
  state: "open" | "retained";
  action?: "reset";
};
