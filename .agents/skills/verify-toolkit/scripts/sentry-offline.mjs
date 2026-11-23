#!/usr/bin/env node
// Run the `sentry` CLI from source with no live Sentry account, and record
// command.txt, stdout.txt, stderr.txt, and exit-code.txt in --out.
// Usage: sentry-offline.mjs --out DIR [--token] -- <sentry args>...
import { OFFLINE_TOKEN, offlineEnv, runSentry } from "./offline-env.mjs";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const own = split === -1 ? argv : argv.slice(0, split);
const cliArgs = split === -1 ? [] : argv.slice(split + 1);
const outIndex = own.indexOf("--out");
const out = outIndex === -1 ? undefined : own[outIndex + 1];
if (!out || cliArgs.length === 0) {
  console.error(
    "usage: sentry-offline.mjs --out DIR [--token] -- <sentry args>...",
  );
  process.exit(2);
}

const { env, cleanup } = offlineEnv({ token: own.includes("--token") });
const run = runSentry(env, cliArgs, out);
cleanup();

const leaked = `${run.stdout}${run.stderr}`.includes(OFFLINE_TOKEN);
console.log(
  `sentry ${cliArgs.join(" ")}: exit ${run.status}${leaked ? ", PRINTED THE TOKEN" : ""}`,
);
process.exit(run.status ?? 1);
