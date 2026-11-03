/** Classify a parsed hostname as Sentry-owned, including regional and tenant hosts. */
export function isSentryHost(host: string): boolean {
  return host === "sentry.io" || host.endsWith(".sentry.io");
}
