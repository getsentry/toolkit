import SentryCli from "sentry";
const cli = SentryCli();
// TODO(sentry-v4): release deploy needs <environment> (and optional [name]) as positionals plus --url/--started/--finished/--time flags from your v3 options — add them to this run() call
await cli.run("release", "deploy", "1.0.0");
