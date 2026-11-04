import * as Sentry from "@sentry/cli";
const cli = new Sentry.SentryCli();
await cli.releases.listDeploys("1.0.0");
