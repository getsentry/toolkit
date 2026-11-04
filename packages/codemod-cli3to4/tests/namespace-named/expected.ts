import * as Sentry from "sentry";
const cli = Sentry.createSentrySDK();
await cli.release.deploys({ orgVersion: "1.0.0" });
