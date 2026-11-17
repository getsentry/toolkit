import { SentryCli } from "@sentry/cli";
const cli = new SentryCli(null, { authToken: process.env.T, org: "acme" });
await cli.releases.new("1.0.0");
await cli.releases.finalize("1.0.0");
