const SentryCli = useCli ? require("sentry").default : null;
const cli = SentryCli({ token: t });
await cli.release.finalize({ orgVersion: "1.0.0" });
