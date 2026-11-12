import { createSentrySDK as SentryCli } from "sentry";
const cli = SentryCli();
const projects = ["web", process.env.PROJECT!];
await cli.release.create({ orgVersion: "1.0.0", project: projects.join(",") });
await cli.release.create({ orgVersion: "1.0.1", project: [...projects, "api"].join(",") });
await cli.release.create({ orgVersion: "1.0.2", project: newOpts.projects?.join(",") });
// TODO(sentry-v4): map v3 `projects` (array) to v4 `project` (comma-separated string) by hand
await cli.release.create({ orgVersion: "1.0.3" });
await cli.release.create({ orgVersion: "1.0.4", project: (ci ? ciProjects : ["web"]).join(",") });
await cli.release.create({ orgVersion: "1.0.5", project: (ci ? ciOpts : localOpts).projects?.join(",") });
