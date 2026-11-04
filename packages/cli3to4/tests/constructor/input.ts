import SentryCli from "@sentry/cli";
const cli = new SentryCli(null, { authToken: process.env.T, org: "acme" });
