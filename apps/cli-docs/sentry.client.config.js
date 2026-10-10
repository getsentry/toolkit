import * as Sentry from "@sentry/astro";

Sentry.init({
  dsn: "https://2aca5fe97c71868bc3aa7fb48620dc39@o1.ingest.us.sentry.io/4510798755856384",
  environment: import.meta.env.PUBLIC_SENTRY_ENVIRONMENT ?? "development",
  release: import.meta.env.PUBLIC_SENTRY_RELEASE || undefined,
  sendDefaultPii: true,
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration(),
  ],
  enableLogs: true,
  tracesSampleRate: 1.0,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  // Enable in all environments (including development)
  enabled: true,
  // Uncomment to debug Sentry initialization
  // debug: true,
});

// Expose globally for inline scripts
window.Sentry = Sentry;
