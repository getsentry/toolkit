#!/usr/bin/env node
// `@sentry/wizard` 10 runs `sentry wizard` from the Sentry CLI, which replaced
// it. Old flags are translated to the command's syntax; stdio, the exit code,
// and signals pass through unchanged.
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
 * `package.json`, so resolve its entry point and walk up to its manifest.
 * Resolving works in `node_modules` installs and under Yarn Plug'n'Play.
 *
 * @returns {string | undefined}
 */
function findSentryBin() {
  let dir;
  try {
    dir = dirname(createRequire(import.meta.url).resolve("sentry"));
  } catch {
    return undefined;
  }
  for (;;) {
    const manifestPath = join(dir, "package.json");
    if (existsSync(manifestPath)) {
      /** @type {{ name?: string, bin?: string | Record<string, string> }} */
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === "sentry") {
        const bin =
          typeof manifest.bin === "string"
            ? manifest.bin
            : manifest.bin?.["sentry"];
        return bin === undefined ? undefined : resolve(dir, bin);
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/** Old flags with a `sentry wizard` equivalent, by name. */
const TRANSLATED = new Map([
  ["i", "integration"],
  ["integration", "integration"],
  ["u", "url"],
  ["url", "url"],
  ["org", "org"],
  ["project", "project"],
]);

/** Flags that become `-f`, including `-f` itself. */
const FORCE_FLAGS = new Set([
  "f",
  "force",
  "force-install",
  "ignore-git-changes",
]);

/** Old flags without an equivalent that take a value, which is dropped too. */
const VALUE_FLAGS = new Set([
  "promo-code",
  "coming-from",
  "xcode-project-dir",
  "app-target",
  "hosted-test-target",
]);

/** Old flags that take every value up to the next flag. */
const ARRAY_FLAGS = new Set(["p", "platform"]);

/**
 * Translate `@sentry/wizard` arguments to `sentry wizard [<org>/<project>]
 * [<integration>] [-f]`, plus the CLI's environment variables for `--url` and
 * `--spotlight`. Other arguments, such as a target or integration already
 * written as positionals, pass through. Values are never printed: some old
 * flags carried tokens.
 *
 * @param {readonly string[]} args
 * @returns {{ args: string[], env: Record<string, string>, notices: string[] }}
 */
function translateArgs(args) {
  /** @type {Map<string, string>} */
  const values = new Map();
  /** @type {string[]} */
  const positionals = [];
  /** @type {string[]} */
  const notices = [];
  let force = false;
  let help = false;
  let spotlight = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const name = flag.replace(/^--?/, "");
    let value = equals === -1 ? undefined : arg.slice(equals + 1);
    const isNextValue = () => !(args[index + 1] ?? "-").startsWith("-");
    const equivalent = TRANSLATED.get(name);
    if (
      value === undefined &&
      (equivalent !== undefined ||
        VALUE_FLAGS.has(name) ||
        name.startsWith("preSelectedProject.")) &&
      isNextValue()
    ) {
      index += 1;
      value = args[index];
    }
    if (ARRAY_FLAGS.has(name)) {
      while (value === undefined && isNextValue()) {
        index += 1;
      }
    }
    if (FORCE_FLAGS.has(name)) {
      force = true;
    } else if (name === "spotlight") {
      spotlight = true;
    } else if (equivalent === undefined) {
      notices.push(`Ignoring ${flag}: \`sentry wizard\` has no such option.`);
    } else if (value === undefined) {
      notices.push(`Ignoring ${flag}: it needs a value.`);
    } else {
      values.set(equivalent, value);
    }
  }

  const org = values.get("org");
  const project = values.get("project");
  if (org === undefined && project !== undefined) {
    notices.push(
      "Ignoring --project: it needs --org, so the wizard asks for the project.",
    );
  }
  const integration = values.get("integration");
  const url = values.get("url");
  return {
    args: [
      ...(org === undefined ? [] : [`${org}/${project ?? ""}`]),
      ...positionals,
      ...(integration === undefined ? [] : [integration]),
      ...(force ? ["-f"] : []),
      ...(help ? ["--help"] : []),
    ],
    env: {
      ...(url === undefined ? {} : { SENTRY_URL: url }),
      ...(spotlight ? { SENTRY_SPOTLIGHT: "1" } : {}),
    },
    notices,
  };
}

process.stderr.write(`${NOTICE}\n`);
const translated = translateArgs(process.argv.slice(2));
for (const notice of translated.notices) {
  process.stderr.write(`${notice}\n`);
}

const sentryBin = findSentryBin();
if (sentryBin === undefined) {
  process.stderr.write(
    "Could not find the `sentry` package. Run `npx sentry wizard` instead.\n",
  );
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [sentryBin, "wizard", ...translated.args],
  {
    stdio: "inherit",
    env: { ...process.env, ...translated.env },
  },
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
