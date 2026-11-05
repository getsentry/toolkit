let SentryCli;
SentryCli = require("sentry").default;
const cli = SentryCli({ token: t });
await cli.release.finalize({ orgVersion: "1.0.0" });
