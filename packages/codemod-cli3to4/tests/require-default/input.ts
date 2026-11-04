const SentryCli = require("@sentry/cli").default;
const cli = new SentryCli({ authToken: process.env.T });
cli.execute(["releases", "new", "1.0.0"], false);
