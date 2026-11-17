import SentryCli from "sentry";
await SentryCli({ token: t }).release.finalize({ orgVersion: "1.0.0" });
// TODO(sentry-v4): run(...) passes raw CLI args verbatim; remap v3 command names to v4 (releases→release, new→create, login→auth login, …) and verify flags. NOTE: v3's second `execute` arg (`live`) is dropped — v4 `run()` always captures and returns output (v3 `live:false` behavior); if you passed `live:true`/`'rejectOnError'` for streamed stdio, adjust accordingly
await SentryCli().run("releases", "list");
