import { createSentrySDK as SentryCli } from "sentry";
const cli = SentryCli();
const env = "prod";
// TODO(sentry-v4): verify deploy options: v3 `env` is v4 `environment`; `started`/`finished` are ISO 8601 strings and `time` is a string of seconds (v3 took numbers); `projects` was dropped
await cli.release.deploy({ orgVersion: "1.0.0", environment: env, name: "Deploy #1" });
// TODO(sentry-v4): verify deploy options: v3 `env` is v4 `environment`; `started`/`finished` are ISO 8601 strings and `time` is a string of seconds (v3 took numbers); `projects` was dropped
await cli.release.deploy({ orgVersion: "1.0.0", ...deployOpts });
