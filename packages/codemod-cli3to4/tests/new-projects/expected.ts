import { createSentrySDK as SentryCli } from "sentry";
const cli = SentryCli();
await cli.release.create({ orgVersion: "1.0.0", project: "web,api" });
