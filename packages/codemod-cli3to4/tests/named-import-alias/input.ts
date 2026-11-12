import { SentryCli as Cli, type SentryCliOptions, SentryCliNewDeployOptions } from "@sentry/cli";
const opts: SentryCliOptions = { authToken: "t" };
const cli = new Cli(null, opts);
