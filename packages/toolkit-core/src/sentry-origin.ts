import { isSentryHost } from "./sentry-host.js";

/** Strict SaaS origin check for credential and regional-host trust decisions. */
export function isSaaSTrustOrigin(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      !url.username &&
      !url.password &&
      isSentryHost(url.hostname)
    );
  } catch {
    return false;
  }
}
