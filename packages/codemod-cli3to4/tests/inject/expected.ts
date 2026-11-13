import { createSentrySDK as SentryCli } from "sentry";
const cli = SentryCli();
// TODO(sentry-v4): verify inject options: v4 takes one `directory` (v3 `paths` was an array — run once per directory), and `ignore`/`ext` are comma-separated strings; `ignoreFile`/`dryRun` are kept
await cli.sourcemap.inject({ paths: ["./dist"], dryRun: true });
