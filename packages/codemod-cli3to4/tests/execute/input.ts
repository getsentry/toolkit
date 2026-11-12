import SentryCli from "@sentry/cli";
const cli = new SentryCli();
await cli.execute(["releases", "new", version], true);
