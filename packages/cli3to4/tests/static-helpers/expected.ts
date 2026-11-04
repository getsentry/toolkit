import { createSentrySDK as SentryCli } from "sentry";
// TODO(sentry-v4): v4 has no static `getVersion()`; run `sentry --version` or resolve the `sentry` binary yourself
console.log(SentryCli.getVersion());
