#!/usr/bin/env node
import { createRequire } from "node:module";
import process from "node:process";
import { UsageError, buildUsage, resolveConfig } from "../lib/config.js";
import { startProxy } from "../lib/proxy.js";

const { version } = createRequire(import.meta.url)("../package.json");

/** stdout carries the MCP protocol only; every diagnostic goes to stderr. */
const log = (/** @type {string} */ message) => {
  process.stderr.write(`${message}\n`);
};

let config;
try {
  config = resolveConfig(process.argv.slice(2), process.env);
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  log(`Error: ${error.message}`);
  process.exit(1);
}

if (config.kind !== "run") {
  // No protocol session runs for --help/--version, so stdout is free.
  process.stdout.write(
    `${config.kind === "help" ? buildUsage(version) : version}\n`,
  );
  process.exit(0);
}

for (const warning of config.warnings) {
  log(`Warning: ${warning}`);
}

const proxy = await startProxy({
  endpoint: config.endpoint,
  accessToken: config.accessToken,
  userAgent: `sentry-mcp/${version}`,
  log,
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void proxy.close());
}

await proxy.closed;
// Flush buffered protocol output before exiting; idle HTTP sockets would
// otherwise keep the process alive.
process.stdout.write("", () => process.exit(0));
