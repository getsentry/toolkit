import SentryCli from "sentry";
const cli = SentryCli();
// TODO(sentry-v4): sourcemaps are debug-ID-first in v4: set the `directory` option to your bundle output dir (v3 `include` was a path array — run one upload per directory) and review the remaining options
await cli.sourcemap.upload({ release: "1.0.0" });
