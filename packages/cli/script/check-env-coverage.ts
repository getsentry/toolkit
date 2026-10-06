#!/usr/bin/env tsx
/**
 * Environment variable documentation coverage.
 *
 * Scans the source tree for environment variables the CLI reads at runtime and
 * fails if any user-facing variable is missing from `ENV_VAR_REGISTRY`
 * (src/lib/env-registry.ts), which is the single source of truth for the
 * generated `configuration.md` docs.
 *
 * This closes the class of "code reads an env var but the docs never mention it"
 * bugs: a new `getEnv().SENTRY_FOO` read forces a deliberate choice — either
 * document it in the registry, or mark it internal in INTERNAL_ENV_VARS below.
 *
 * A variable counts as user-facing when its name starts with `SENTRY_` or is one
 * of the well-known cross-tool vars in PUBLIC_ENV_VARS. Internal plumbing,
 * test-only hooks, and vars inherited from the SDK are listed (with a reason) in
 * INTERNAL_ENV_VARS so their exclusion is explicit and reviewable.
 *
 * Usage:
 *   tsx script/check-env-coverage.ts
 *
 * Exit codes:
 *   0 - Every referenced user-facing env var is documented or explicitly internal
 *   1 - Coverage gap, redundant allowlist entry, or stale allowlist entry
 */

import { readFile } from "node:fs/promises";
import { glob } from "tinyglobby";
import { ENV_VAR_REGISTRY } from "../src/lib/env-registry.js";

/**
 * Well-known env vars that don't start with `SENTRY_` but are still part of the
 * CLI's documented, user-facing surface. Anything read here must be in the
 * registry too.
 */
const PUBLIC_ENV_VARS = new Set([
  "DO_NOT_TRACK",
  "NO_COLOR",
  "FORCE_COLOR",
  "NODE_EXTRA_CA_CERTS",
]);

/**
 * Env vars the CLI reads but intentionally keeps out of the user-facing docs.
 * Each needs a one-line reason so the exclusion is a deliberate, reviewable
 * decision rather than an oversight. Keep this list minimal.
 */
const INTERNAL_ENV_VARS = new Map<string, string>([
  [
    "SENTRY_ENVIRONMENT",
    "bash-hook traceback template only; inherited SDK convention",
  ],
  [
    "SENTRY_TRACES_SAMPLE_RATE",
    "inherited from the SDK when spawning subprocesses, not a CLI config knob",
  ],
  ["SENTRY_DIST", "react-native xcode build var, mirrors legacy sentry-cli"],
  [
    "SENTRY_SCAN_DISABLE_WORKERS",
    "internal scanner performance tuning, not user-facing",
  ],
  [
    "SENTRY_CLI_INTEGRATION_TEST_VERSION_OVERRIDE",
    "integration-test-only version override",
  ],
  ["SENTRY_RN_BUNDLE_COMMAND", "internal react-native wrapper plumbing"],
  ["SENTRY_RN_NO_DEBUG_ID", "internal react-native wrapper plumbing"],
  ["SENTRY_RN_REAL_HERMES_CLI_PATH", "internal react-native wrapper plumbing"],
  ["SENTRY_RN_REAL_NODE_BINARY", "internal react-native wrapper plumbing"],
  ["SENTRY_RN_SOURCEMAP_REPORT", "internal react-native wrapper plumbing"],
]);

const registryNames = new Set(ENV_VAR_REGISTRY.map((entry) => entry.name));

/**
 * Env-var-looking names read off an env object via member access, e.g.
 * `getEnv().SENTRY_ORG`, `process.env.NO_COLOR`, `ctx.env.SENTRY_HOST`,
 * `someEnv.SENTRY_DSN`. The leading alternation matches the standard accessors
 * plus any identifier ending in `env`/`Env` (the repo's env-copy convention).
 */
const ENV_MEMBER_RE =
  /(?:getEnv\(\)|process\.env|ctx\.env|\b\w*[eE]nv)\??\.([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Env-var reads via bracket access, e.g. `getEnv()["SENTRY_LOG_LEVEL"]` or
 * `getEnv()[CONFIG_DIR_ENV_VAR]`. The index is either a string literal or an
 * identifier resolved through the constant map built below.
 */
const ENV_BRACKET_RE =
  /(?:getEnv\(\)|process\.env|ctx\.env|\b\w*[eE]nv)\??\[\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s*\]/g;

/** `const FOO_ENV_VAR = "SENTRY_FOO";` — resolves bracket reads by constant. */
const ENV_CONST_RE =
  /\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]+)"|'([^']+)')/g;

function isUserFacing(name: string): boolean {
  return name.startsWith("SENTRY_") || PUBLIC_ENV_VARS.has(name);
}

const files = await glob("src/**/*.ts", {
  ignore: ["src/generated/**", "**/*.test.ts"],
});

// Pass 1: resolve `const X = "SENTRY_..."` declarations across the tree so that
// bracket reads indexed by a constant can be mapped back to a literal name.
const constMap = new Map<string, string>();
const fileContents = new Map<string, string>();
for (const file of files) {
  const content = await readFile(file, "utf-8");
  fileContents.set(file, content);
  for (const match of content.matchAll(ENV_CONST_RE)) {
    const value = match[2] ?? match[3];
    if (value && isUserFacing(value)) {
      constMap.set(match[1], value);
    }
  }
}

/** name -> first "file:line" where it is read (for actionable error output). */
const referenced = new Map<string, string>();

function record(name: string, file: string, content: string, index: number) {
  if (!isUserFacing(name) || referenced.has(name)) {
    return;
  }
  const line = content.slice(0, index).split("\n").length;
  referenced.set(name, `${file}:${line}`);
}

for (const [file, content] of fileContents) {
  for (const match of content.matchAll(ENV_MEMBER_RE)) {
    record(match[1], file, content, match.index);
  }
  for (const match of content.matchAll(ENV_BRACKET_RE)) {
    const ident = match[3];
    const name =
      match[1] ?? match[2] ?? (ident ? constMap.get(ident) : undefined);
    if (name) {
      record(name, file, content, match.index);
    }
  }
}

const errors: string[] = [];

// A user-facing var read in code must be documented or explicitly internal.
for (const [name, location] of referenced) {
  if (registryNames.has(name) || INTERNAL_ENV_VARS.has(name)) {
    continue;
  }
  errors.push(
    `Undocumented env var: ${name} (read at ${location})\n` +
      "    Add it to ENV_VAR_REGISTRY in src/lib/env-registry.ts so it appears in configuration.md,\n" +
      "    or add it to INTERNAL_ENV_VARS in this script with a reason if it is internal-only."
  );
}

// A name can't be both documented and internal.
for (const name of INTERNAL_ENV_VARS.keys()) {
  if (registryNames.has(name)) {
    errors.push(
      `Contradictory entry: ${name} is in both ENV_VAR_REGISTRY and INTERNAL_ENV_VARS. ` +
        "Remove it from INTERNAL_ENV_VARS."
    );
  }
}

// Keep the allowlist honest: drop entries no longer read anywhere.
for (const name of INTERNAL_ENV_VARS.keys()) {
  if (!referenced.has(name)) {
    errors.push(
      `Stale INTERNAL_ENV_VARS entry: ${name} is no longer read in src/. Remove it.`
    );
  }
}

if (errors.length > 0) {
  console.error(`\nFound ${errors.length} env var coverage issue(s):\n`);
  for (const err of errors) {
    console.error(`  ✗ ${err}\n`);
  }
  process.exit(1);
}

console.log(
  `✓ All ${referenced.size} user-facing env var(s) read in src/ are documented ` +
    `(${registryNames.size} in registry, ${INTERNAL_ENV_VARS.size} internal).`
);
