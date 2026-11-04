import { SentryCli } from "@sentry/cli";
const cli = new SentryCli();
await cli.releases.new("1.0.0", { projects: ["web", "api"] });
