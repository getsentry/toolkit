const { SentryCli } = require("@sentry/cli");
const cli = new SentryCli(null, { authToken: process.env.T });
cli.releases.proposeVersion();
