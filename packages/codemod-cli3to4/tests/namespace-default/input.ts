import * as Sentry from "@sentry/cli";
const cli = new Sentry.default({ authToken: process.env.T });
cli.execute(["releases", "list"]);
