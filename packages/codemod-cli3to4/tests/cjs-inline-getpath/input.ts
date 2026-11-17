const { execFileSync } = require("child_process");
execFileSync(require("@sentry/cli").getPath(), ["--version"]);
