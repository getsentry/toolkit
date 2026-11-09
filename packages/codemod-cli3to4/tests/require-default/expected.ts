const SentryCli = require("sentry").default;
const cli = SentryCli({ token: process.env.T });
// TODO(sentry-v4): run(...) passes raw CLI args verbatim; remap v3 command names to v4 (releases→release, new→create, login→auth login, …) and verify flags. NOTE: v3's second `execute` arg (`live`) is dropped — v4 `run()` always captures and returns output (v3 `live:false` behavior); if you passed `live:true`/`'rejectOnError'` for streamed stdio, adjust accordingly
cli.run("releases", "new", "1.0.0");
