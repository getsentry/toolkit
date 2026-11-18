#!/usr/bin/env node
// Run several `sentry local` commands against one Local daemon, then stop it.
// All steps share one offline env and config dir, so a daemon a step starts is
// the one later steps query. Each step writes command.txt, stdout.txt,
// stderr.txt, and exit-code.txt to <out>/step-<n>; `local daemon stop` writes
// them to <out>/teardown. See ../SKILL.md ("Drive").
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { offlineEnv, runSentry } from "./offline-env.mjs";

const usage = "usage: local-session.mjs --out DIR --step 'ARGS'...";
const argv = process.argv.slice(2);
let out;
const steps = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") out = argv[++i];
  else if (argv[i] === "--step") steps.push(argv[++i]);
  else {
    console.error(`unknown argument: ${argv[i]}\n${usage}`);
    process.exit(2);
  }
}
if (!out || steps.length === 0) {
  console.error(usage);
  process.exit(2);
}

/** A free loopback port, so the daemon never meets one already on 8969. */
function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

const placeholders = {
  "{app}": join(dirname(fileURLToPath(import.meta.url)), "local-app.mjs"),
  "{node}": process.execPath,
  "{port}": String(await freePort()),
};
const { env, configDir, cleanup } = offlineEnv({ token: false });
const statePath = join(configDir, "local-control-plane.json");

let failed = false;
try {
  for (const [n, step] of steps.entries()) {
    const args = step
      .split(/\s+/)
      .filter(Boolean)
      .map((arg) => placeholders[arg] ?? arg);
    const run = runSentry(env, args, join(out, `step-${n + 1}`));
    console.log(`step ${n + 1}: sentry ${args.join(" ")}: exit ${run.status}`);
  }
} finally {
  // Read the daemon's PID before stop removes its state file.
  const pid = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8")).pid
    : undefined;
  const stop = runSentry(
    env,
    ["local", "daemon", "stop", "--json"],
    join(out, "teardown"),
  );
  console.log(`teardown: sentry local daemon stop: exit ${stop.status}`);
  if (pid && isRunning(pid)) {
    // Only the daemon this run started: its PID came from this run's config dir.
    process.kill(pid, "SIGKILL");
    console.error(`teardown: killed daemon PID ${pid}, which survived stop`);
    failed = true;
  }
  cleanup();
}
process.exit(failed ? 1 : 0);

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
