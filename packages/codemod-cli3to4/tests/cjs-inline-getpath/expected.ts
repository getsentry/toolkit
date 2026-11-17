const { execFileSync } = require("child_process");
// TODO(sentry-v4): v4 `getPath()` is a Node.js script, not a native binary: spawn it as `execFile(process.execPath, [getPath(), ...args])`, or call the SDK methods instead
execFileSync(require("sentry").getPath(), ["--version"]);
