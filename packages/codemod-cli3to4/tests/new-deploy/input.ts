import SentryCli from "@sentry/cli";
const cli = new SentryCli();
await cli.releases.newDeploy("1.0.0", { env: "prod", url: "https://x" });
