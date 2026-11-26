#!/usr/bin/env node
// `@sentry/wizard` 10 runs `sentry wizard` from the Sentry CLI, which replaced
// it. Arguments, stdio, the exit code, and signals pass through unchanged.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";

const NOTICE =
  "`@sentry/wizard` is deprecated. Use `npx sentry wizard` instead.";

/**
 * How long the first SIGINT waits before it is passed on. Ctrl-C signals the
 * terminal's whole foreground process group, so the CLI has that one already,
 * and a second SIGINT means "force quit" to it. A SIGINT sent to this process
 * alone, such as `kill -INT`, still reaches the CLI after the wait.
 */
const INTERRUPT_GRACE_MS = 3000;

/**
 * Find the `sentry` package's bin script. Its `exports` don't include
 * `package.json`, so look for the file where `require("sentry")` would.
 *
 * @returns {string | undefined}
 */
function findSentryBin() {
  const require = createRequire(import.meta.url);
  for (const nodeModules of require.resolve.paths("sentry") ?? []) {
    const manifestPath = join(nodeModules, "sentry", "package.json");
    if (!existsSync(manifestPath)) {
      continue;
    }
    /** @type {{ bin?: string | Record<string, string> }} */
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const bin =
      typeof manifest.bin === "string"
        ? manifest.bin
        : manifest.bin?.["sentry"];
    return bin === undefined ? undefined : resolve(dirname(manifestPath), bin);
  }
  return undefined;
}

process.stderr.write(`${NOTICE}\n`);

const sentryBin = findSentryBin();
if (sentryBin === undefined) {
  process.stderr.write(
    "Could not find the `sentry` package. Run `npx sentry wizard` instead.\n",
  );
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [sentryBin, "wizard", ...process.argv.slice(2)],
  { stdio: "inherit" },
);

let interrupts = 0;
/** @type {NodeJS.Timeout | undefined} */
let interruptFallback;
const onSigint = () => {
  interrupts += 1;
  clearTimeout(interruptFallback);
  if (interrupts > 1) {
    child.kill("SIGINT");
    return;
  }
  interruptFallback = setTimeout(
    () => child.kill("SIGINT"),
    INTERRUPT_GRACE_MS,
  );
};
const onSigterm = () => child.kill("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

child.on("error", (error) => {
  process.stderr.write(`Could not start the Sentry CLI: ${error.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  clearTimeout(interruptFallback);
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  if (signal === null) {
    process.exit(code ?? 1);
  }
  // End this process with the same signal, so callers see how the CLI ended.
  process.kill(process.pid, signal);
  // Only reached where the signal doesn't end the process, such as Windows.
  process.exit(128 + constants.signals[signal]);
});
