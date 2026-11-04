import SentryCli from "sentry";
const cli = SentryCli();
// TODO(sentry-v4): verify set-commits options: v4 has no `ignoreMissing`/`ignoreEmpty` (both dropped); repo/commit map via the `commit` flag and `auto`/`local` are kept
await cli.release["set-commits"]({ orgVersion: "1.0.0", auto: true });
