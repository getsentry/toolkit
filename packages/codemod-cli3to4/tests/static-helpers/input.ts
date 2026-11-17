import { SentryCli } from "@sentry/cli";
import { execFileSync } from "node:child_process";
console.log(SentryCli.getVersion());
execFileSync(SentryCli.getPath(), ["--version"]);
