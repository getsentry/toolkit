import SentryCli from "sentry";
// TODO(sentry-v4): verify these v3 options — they have no direct v4 SentryOptions equivalent: apiKey, silent (apiKey → rename to `token`; dsn → use SENTRY_DSN env; silent/customHeader/headers/vcsRemote were dropped)
const cli = SentryCli({ apiKey: process.env.KEY, silent: true });
