/** Optional SSE metadata used to bootstrap the Local session picker. */
export const LOCAL_DIRECTORY_EVENT = "sentry.local.directory";

/** Ordered lifecycle metadata follows replayed envelopes on a scoped stream. */
export const LOCAL_SESSION_EVENT = "sentry.local.session";
export type LocalSessionEvent = {
  state: "open" | "retained";
  action?: "reset";
};

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
