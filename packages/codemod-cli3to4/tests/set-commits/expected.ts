import SentryCli from "sentry";
const cli = SentryCli();
// TODO(sentry-v4): verify set-commits options: v3 `repo`/`commit`/`previousCommit` become one `commit: "REPO@PREV..SHA"` string; `ignoreMissing`/`ignoreEmpty` were dropped; `auto` is kept
await cli.release["set-commits"]({ orgVersion: "1.0.0", auto: true });
