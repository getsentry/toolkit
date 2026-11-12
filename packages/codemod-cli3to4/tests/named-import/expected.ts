import { createSentrySDK as SentryCli } from "sentry";
const cli = SentryCli({ token: process.env.T, org: "acme" });
await cli.release.create({ orgVersion: "1.0.0" });
await cli.release.finalize({ orgVersion: "1.0.0" });
