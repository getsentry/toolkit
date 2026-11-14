import * as Sentry from "@sentry/react";
import { sentryBeforeSend } from "@sentry/mcp-core/telem/sentry";
import { resolveAttribution } from "./utils";

Sentry.init({
  dsn: import.meta.env["VITE_SENTRY_DSN"],
  tracesSampleRate: 1,
  beforeSend: sentryBeforeSend,
  // First-party only. Cloudflare Web Analytics injects beacon.min.js outside our
  // HTML; on older Mobile Safari it throws (e.g. t.entries.at is not a function).
  // allowUrls drops third-party script noise without enumerating vendors.
  allowUrls: [window.location.origin],
  environment:
    import.meta.env["VITE_SENTRY_ENVIRONMENT"] ?? import.meta.env["NODE_ENV"],
  integrations: [Sentry.browserTracingIntegration()],
});

resolveAttribution();
