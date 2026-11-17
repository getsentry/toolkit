import { SentryCli } from "@sentry/cli";
const cli = new SentryCli();
await cli.sourceMaps.inject({ paths: ["./dist"], dryRun: true });
