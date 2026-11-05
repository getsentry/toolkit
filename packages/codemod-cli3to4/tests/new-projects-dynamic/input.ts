import { SentryCli } from "@sentry/cli";
const cli = new SentryCli();
const projects = ["web", process.env.PROJECT!];
await cli.releases.new("1.0.0", { projects });
await cli.releases.new("1.0.1", { projects: [...projects, "api"] });
await cli.releases.new("1.0.2", newOpts);
await cli.releases.new("1.0.3", { projects, ...extra });
await cli.releases.new("1.0.4", { projects: ci ? ciProjects : ["web"] });
await cli.releases.new("1.0.5", ci ? ciOpts : localOpts);
