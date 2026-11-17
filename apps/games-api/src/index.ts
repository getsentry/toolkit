import * as Sentry from "@sentry/cloudflare";
import app from "./app";
import type { Env } from "./leaderboard";

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    // Requests can carry the client IP and cookies set for all of sentry.new.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
  }),
  app,
) satisfies ExportedHandler<Env>;
