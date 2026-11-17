import SentryCli from "@sentry/cli";
const cli = new SentryCli();
await cli.releases.setCommits("1.0.0", { auto: true });
