import { createSentrySDK as SentryCli } from "sentry";
const cli = SentryCli();
// TODO(sentry-v4): v3 `projects` (array) is v4 `project` (comma-separated string) — add it to this call
await cli.release.create({ orgVersion: "1.0.0" });
