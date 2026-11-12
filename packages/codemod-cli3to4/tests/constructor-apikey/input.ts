import SentryCli from "@sentry/cli";
const cli = new SentryCli(null, { apiKey: process.env.KEY, silent: true });
