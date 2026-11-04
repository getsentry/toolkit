import SentryCli from "@sentry/cli";
const cli = new SentryCli(null, { authToken: t, headers: { "X-Proxy": "1" } });
