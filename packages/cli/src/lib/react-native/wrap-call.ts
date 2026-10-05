/**
 * React Native Xcode build wrapper (`wrap_call`).
 *
 * When `react-native xcode` runs a release build it re-points `NODE_BINARY`
 * (and `HERMES_CLI_PATH`) at this CLI and sets `__SENTRY_RN_WRAP_XCODE_CALL=1`.
 * The RN build script then invokes us in place of Node/Hermes; we parse the
 * bundle/sourcemap paths out of the arguments, forward the call to the real
 * tool, record what we learned in a JSON report, and (for Hermes) copy the
 * packager debug ID into the combined sourcemap.
 *
 * Mirrors the legacy `sentry-cli react-native xcode`'s `wrap_call`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { logger } from "../logger.js";

const log = logger.withTag("react-native.wrap");

/** Paths discovered while wrapping the RN build tools. */
export type SourceMapReport = {
  packager_bundle_path?: string;
  packager_sourcemap_path?: string;
  hermes_bundle_path?: string;
  hermes_sourcemap_path?: string;
};

/** Whether this process is a Node Single Executable Application. */
export function isSea(): boolean {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const req = createRequire(import.meta.url);
    const sea = req("node:sea") as { isSea?: () => boolean };
    return sea.isSea?.() === true;
  } catch {
    return false;
  }
}

/**
 * The arguments the RN build script passed to us (i.e. everything after the
 * program). In a SEA binary `argv[0]` is the binary; under `node script …`
 * `argv[1]` is the script.
 */
function getWrapArgs(): string[] {
  return isSea() ? process.argv.slice(1) : process.argv.slice(2);
}

/** Read the JSON report file if present, else start fresh. */
function loadReport(path: string): SourceMapReport {
  if (!existsSync(path)) {
    return {};
  }
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SourceMapReport;
  } catch {
    return {};
  }
}

/** Extract the value following `flag` (supports `--flag value` and `--flag=value`). */
function extractArg(args: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === flag) {
      return args[i + 1];
    }
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return;
}

/** Whether the invocation is an RN packager bundle command. */
function isBundleCommand(args: string[], bundleCommand?: string): boolean {
  const sub = args[1];
  if (sub === undefined) {
    return false;
  }
  if (bundleCommand) {
    return sub === bundleCommand;
  }
  return sub === "bundle" || sub === "ram-bundle" || sub === "export:embed";
}

/** Parse packager bundle output, adding a `--sourcemap-output` if missing. */
function handleBundle(args: string[], report: SourceMapReport): void {
  const bundle = extractArg(args, "--bundle-output");
  let sourcemap = extractArg(args, "--sourcemap-output");

  if (!sourcemap && bundle) {
    const mapName = `${basename(bundle, ".jsbundle")}.jsbundle.map`;
    sourcemap = join(tmpdir(), mapName);
    args.push("--sourcemap-output", sourcemap);
  }
  report.packager_sourcemap_path = sourcemap;
  report.packager_bundle_path = bundle;
}

/** Copy the packager sourcemap's debug ID into the Hermes combined sourcemap. */
function copyDebugId(report: SourceMapReport): void {
  const {
    packager_sourcemap_path: pkgPath,
    hermes_sourcemap_path: hermesPath,
  } = report;
  if (!(pkgPath && hermesPath)) {
    log.debug("Missing packager/Hermes sourcemap path; skipping debug id copy");
    return;
  }
  let pkg: Record<string, unknown>;
  let hermes: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
    hermes = JSON.parse(readFileSync(hermesPath, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch (err) {
    log.debug("Could not read sourcemaps for debug id copy", err);
    return;
  }
  if ("debugId" in hermes || "debug_id" in hermes) {
    return;
  }
  const debugId = pkg.debugId ?? pkg.debug_id;
  if (debugId === undefined) {
    return;
  }
  hermes.debugId = debugId;
  hermes.debug_id = debugId;
  writeFileSync(hermesPath, JSON.stringify(hermes));
}

/**
 * Run the wrapped Node/Hermes invocation, updating the sourcemap report.
 *
 * @returns The exit code of the wrapped process.
 */
/** Whether the invocation is the Hermes combine-source-maps script. */
function isComposeCommand(args: string[], env: NodeJS.ProcessEnv): boolean {
  const first = args[0];
  if (first === undefined || args.length <= 1) {
    return false;
  }
  return (
    first.endsWith("compose-source-maps.js") ||
    (Boolean(env.COMPOSE_SOURCEMAP_PATH) &&
      first === env.COMPOSE_SOURCEMAP_PATH)
  );
}

/** Classify the wrapped invocation, recording paths into `report`. */
function classifyInvocation(
  args: string[],
  env: NodeJS.ProcessEnv,
  report: SourceMapReport
): { executeHermes: boolean; shouldCopyDebugId: boolean } {
  if (isBundleCommand(args, env.SENTRY_RN_BUNDLE_COMMAND)) {
    handleBundle(args, report);
    return { executeHermes: false, shouldCopyDebugId: false };
  }
  if (args.length > 1 && args[0] === "-emit-binary") {
    report.hermes_bundle_path = extractArg(args, "-out");
    return { executeHermes: true, shouldCopyDebugId: false };
  }
  if (isComposeCommand(args, env)) {
    report.hermes_sourcemap_path = extractArg(args, "-o");
    return { executeHermes: false, shouldCopyDebugId: true };
  }
  return { executeHermes: false, shouldCopyDebugId: false };
}

export function wrapCall(env: NodeJS.ProcessEnv = process.env): number {
  const reportPath = env.SENTRY_RN_SOURCEMAP_REPORT;
  if (!reportPath) {
    throw new Error("SENTRY_RN_SOURCEMAP_REPORT is not set");
  }
  const report = loadReport(reportPath);
  const args = getWrapArgs();
  const noDebugId = env.SENTRY_RN_NO_DEBUG_ID === "1";

  const { executeHermes, shouldCopyDebugId } = classifyInvocation(
    args,
    env,
    report
  );

  const executable = executeHermes
    ? env.SENTRY_RN_REAL_HERMES_CLI_PATH
    : env.SENTRY_RN_REAL_NODE_BINARY;
  if (!executable) {
    throw new Error(
      "Missing SENTRY_RN_REAL_NODE_BINARY / SENTRY_RN_REAL_HERMES_CLI_PATH"
    );
  }

  const rv = spawnSync(executable, args, { stdio: "inherit" });
  // A signal-killed child has `status === null`; treat that as a failure.
  const status = rv.status ?? (rv.signal !== null || rv.error ? 1 : 0);

  if (!noDebugId && shouldCopyDebugId) {
    copyDebugId(report);
  }

  writeFileSync(reportPath, JSON.stringify(report));
  return status;
}
