#!/usr/bin/env node
// Run the `sentry` CLI from source with no live Sentry account, and record
// command.txt, stdout.txt, stderr.txt, and exit-code.txt in --out.
// Usage: sentry-offline.mjs --out DIR [--token] -- <sentry args>...
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OFFLINE_TOKEN, offlineEnv } from "./offline-env.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
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
const run = spawnSync(
  "pnpm",
  ["--silent", "--dir", join(repo, "packages/cli"), "run", "cli", ...cliArgs],
  {
    cwd: repo,
    env,
    encoding: "utf8",
  },
);
cleanup();

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "command.txt"), `sentry ${cliArgs.join(" ")}\n`);
writeFileSync(join(out, "stdout.txt"), run.stdout);
writeFileSync(join(out, "stderr.txt"), run.stderr);
writeFileSync(join(out, "exit-code.txt"), `${run.status}\n`);
const leaked = `${run.stdout}${run.stderr}`.includes(OFFLINE_TOKEN);
console.log(
  `sentry ${cliArgs.join(" ")}: exit ${run.status}${leaked ? ", PRINTED THE TOKEN" : ""}`,
);
process.exit(run.status ?? 1);
