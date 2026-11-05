import SentryCli from "sentry";
// TODO(sentry-v4): verify this argument: v3's first constructor param was a configFile path (removed in v4); v4 takes an options object. Drop it if it's a config path, or map authToken→token if it's options
const cli = SentryCli(myOptions);
