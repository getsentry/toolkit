import SentryCli from "@sentry/cli";
async function upload() {
  const cli = new SentryCli();
  await cli.releases.setCommits("1.0.0", { auto: true });
}
