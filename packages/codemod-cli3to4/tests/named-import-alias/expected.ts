// TODO(sentry-v4): v4 has no `SentryCliNewDeployOptions` export; use the parameter types of the v4 SDK methods instead
import { createSentrySDK as Cli, type SentryOptions as SentryCliOptions, SentryCliNewDeployOptions } from "sentry";
const opts: SentryCliOptions = { authToken: "t" };
// TODO(sentry-v4): v4 renamed the `authToken` option to `token` — update it inside the options object passed here
const cli = Cli(opts);
