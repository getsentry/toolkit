const { createSentrySDK: SentryCli } = require("sentry");
const cli = SentryCli({ token: process.env.T });
cli.release["propose-version"]();
