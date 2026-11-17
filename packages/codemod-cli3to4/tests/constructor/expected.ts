import SentryCli from "sentry";
const cli = SentryCli({ token: process.env.T, org: "acme" });
