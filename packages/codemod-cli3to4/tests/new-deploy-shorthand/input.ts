import { SentryCli } from "@sentry/cli";
const cli = new SentryCli();
const env = "prod";
await cli.releases.newDeploy("1.0.0", { env, name: "Deploy #1" });
await cli.releases.newDeploy("1.0.0", deployOpts);
