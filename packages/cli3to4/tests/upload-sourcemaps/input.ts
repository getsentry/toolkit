import SentryCli from "@sentry/cli";
const cli = new SentryCli();
await cli.releases.uploadSourceMaps("1.0.0", { include: ["./dist"] });
