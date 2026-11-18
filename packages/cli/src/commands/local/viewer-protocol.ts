/** Optional SSE metadata used to bootstrap the Local session picker. */
export const LOCAL_DIRECTORY_EVENT = "sentry.local.directory";

/** Ordered lifecycle metadata follows replayed envelopes on a scoped stream. */
export const LOCAL_SESSION_EVENT = "sentry.local.session";
export type LocalSessionEvent = {
  state: "open" | "retained";
  action?: "reset";
  /** Existing retained-session deadline, in epoch milliseconds. */
  expiresAt?: number | undefined;
};

/**
 * The receiver rejected an envelope as too large (HTTP 413). SDKs ignore the
 * status and drop the envelope, so terminal tails print a warning.
 */
export const LOCAL_OVERSIZED_EVENT = "sentry.local.oversized";

const UUID_V7_RE =
  /^([\da-f]{8})-([\da-f]{4})-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

/**
 * Read when the receiver accepted an envelope from its SSE event ID.
 * Receiver IDs are UUIDv7s minted at ingest, so their first 48 bits are the
 * receive time in epoch milliseconds. Other IDs return undefined.
 */
export function envelopeReceivedAt(id: string): number | undefined {
  const match = UUID_V7_RE.exec(id);
  return match ? Number.parseInt(`${match[1]}${match[2]}`, 16) : undefined;
}

const LOCAL_UI_ORIGIN = "https://local.sentry.dev";
const LOCAL_UI_PREVIEW_HOST_RE = /^sentry-local-git-[a-z0-9-]+\.sentry\.dev$/;

/** Whether an origin is the production or preview Local viewer. */
export function isHostedUiOrigin(origin: string | undefined): origin is string {
  if (!origin) {
    return false;
  }

  if (!URL.canParse(origin)) {
    return false;
  }

  const url = new URL(origin);
  return (
    origin === url.origin &&
    url.protocol === "https:" &&
    (url.origin === LOCAL_UI_ORIGIN ||
      LOCAL_UI_PREVIEW_HOST_RE.test(url.hostname))
  );
}
