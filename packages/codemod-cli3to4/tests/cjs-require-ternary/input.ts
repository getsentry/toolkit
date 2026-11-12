const SentryCli = useCli ? require("@sentry/cli") : null;
const cli = new SentryCli(null, { authToken: t });
await cli.releases.finalize("1.0.0");
