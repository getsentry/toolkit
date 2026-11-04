import * as Sentry from "@sentry/cloudflare";
import app from "./app";
import type { Env } from "./leaderboard";

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    // Request headers include CF-Connecting-IP.
    integrations: [
      Sentry.requestDataIntegration({ include: { headers: false } }),
    ],
  }),
  app,
) satisfies ExportedHandler<Env>;
