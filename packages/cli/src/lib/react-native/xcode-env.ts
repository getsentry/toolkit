/**
 * Xcode build-environment helpers for `react-native xcode`.
 *
 * Ports the pieces of the legacy `utils/xcode` needed to (a) locate the Node and
 * Hermes compilers the way the React Native build script does, and (b) derive a
 * release/distribution from the build environment or the project `Info.plist`.
 */

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { logger } from "../logger.js";

const log = logger.withTag("react-native.xcode-env");

/** Matches runs of whitespace (splitting preprocessor flag/definition tokens). */
const WHITESPACE = /\s+/;

/** Splits command output into lines, tolerating CRLF endings. */
const LINE_SPLIT = /\r?\n/;

/** Bundle identity extracted from an `Info.plist` or the build environment. */
export type InfoPlist = {
  /** `CFBundleName` / `PRODUCT_NAME`. */
  name: string;
  /** `CFBundleIdentifier` / `PRODUCT_BUNDLE_IDENTIFIER`. */
  bundleId: string;
  /** `CFBundleShortVersionString` / `MARKETING_VERSION`. */
  version: string;
  /** `CFBundleVersion` / `CURRENT_PROJECT_VERSION`. */
  build: string;
};

/** A read-only view of the process environment. */
type Env = Record<string, string | undefined>;

/**
 * Resolve the Node binary the RN build script should call, matching the legacy
 * `find_node`: `NODE_BINARY` if set and non-empty, else `node`.
 */
export function findNode(env: Env): string {
  const fromEnv = env.NODE_BINARY;
  return fromEnv && fromEnv.length > 0 ? fromEnv : "node";
}

/**
 * Resolve the Hermes compiler path, matching the legacy `find_hermesc`:
 * `HERMES_CLI_PATH` if set, else `$PODS_ROOT/hermes-engine/destroot/bin/hermesc`.
 */
export function findHermesc(env: Env): string {
  const fromEnv = env.HERMES_CLI_PATH;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  const podsRoot = env.PODS_ROOT ?? "";
  return `${podsRoot}/hermes-engine/destroot/bin/hermesc`;
}

/**
 * Expand Xcode-style variable references (`$(VAR)`, `${VAR}`) in a string,
 * supporting the `:rfc1034identifier` and `:identifier` modifiers.
 *
 * @param input - The string possibly containing variable references.
 * @param vars - The variable table (typically the process environment).
 */
export function expandXcodeVars(input: string, vars: Env): string {
  return input.replace(/\$[({]([^)}]*)[)}]/g, (_match, key: string) => {
    if (!key) {
      return "";
    }
    const colon = key.indexOf(":");
    const name = colon < 0 ? key : key.slice(0, colon);
    const modifier = colon < 0 ? undefined : key.slice(colon + 1);
    const value = vars[name] ?? "";
    if (modifier === "rfc1034identifier") {
      return value.replace(/[\s/]+/g, "-");
    }
    if (modifier === "identifier") {
      return value.replace(/[\s/]+/g, "_");
    }
    return value;
  });
}

/** Decode the handful of XML entities that appear in plist string values. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Extract `<key>…</key><string>…</string>` pairs from an XML `Info.plist`.
 *
 * This is a deliberately small parser: it only reads top-level string entries,
 * which is all the CFBundle* metadata the command needs. Binary plists are not
 * supported (the source `Info.plist` referenced by `INFOPLIST_FILE` is XML).
 */
export function parseInfoPlistStrings(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  const re = /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g;
  let match: RegExpExecArray | null = re.exec(xml);
  while (match !== null) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) {
      result[decodeXmlEntities(key.trim())] = decodeXmlEntities(value);
    }
    match = re.exec(xml);
  }
  return result;
}

/** Build an {@link InfoPlist} purely from Xcode build-setting env vars. */
function fromEnvVars(vars: Env): InfoPlist | null {
  const name = vars.PRODUCT_NAME;
  const bundleId = vars.PRODUCT_BUNDLE_IDENTIFIER;
  const version = vars.MARKETING_VERSION;
  const build = vars.CURRENT_PROJECT_VERSION;
  if (!(name && bundleId && version && build)) {
    return null;
  }
  return { name, bundleId, version, build };
}

/** Whether a parsed plist carries the fields we require. */
function plistComplete(p: Partial<InfoPlist>): p is InfoPlist {
  return Boolean(p.name && p.bundleId && p.version && p.build);
}

/** Run a command, returning stdout or `null` if it fails / is unavailable. */
function runCapture(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    log.debug(`${cmd} invocation failed`, err);
    return null;
  }
}

/** Extract the four CFBundle* fields from a parsed plist string map. */
function toPartialPlist(raw: Record<string, string>): Partial<InfoPlist> {
  return {
    name: raw.CFBundleName,
    bundleId: raw.CFBundleIdentifier,
    version: raw.CFBundleShortVersionString,
    build: raw.CFBundleVersion,
  };
}

/**
 * Run the C preprocessor over an `Info.plist` (`INFOPLIST_PREPROCESS=YES`),
 * mirroring the legacy `cc -xc -P -E` invocation with the project's
 * preprocessor flags/definitions. Returns the parsed strings or `null`.
 */
function preprocessPlist(
  path: string,
  vars: Env
): Record<string, string> | null {
  const args = ["-xc", "-P", "-E"];
  const other = vars.INFOPLIST_OTHER_PREPROCESSOR_FLAGS;
  if (other) {
    args.push(...other.split(WHITESPACE).filter(Boolean));
  }
  const defs = vars.INFOPLIST_PREPROCESSOR_DEFINITIONS;
  if (defs) {
    for (const token of defs.split(WHITESPACE).filter(Boolean)) {
      args.push(`-D${token}`);
    }
  }
  args.push(path);
  const out = runCapture("cc", args);
  return out ? parseInfoPlistStrings(out) : null;
}

/**
 * Load an `Info.plist` and expand its build-setting variables.
 *
 * When `allowPreprocessing` is set and `INFOPLIST_PREPROCESS=YES`, the plist is
 * run through `cc` first (some project templates use `#include`/macros). Falls
 * back to build-setting env vars when the plist is missing or incomplete (e.g.
 * the storyboard-only partial `Info.plist` newer Xcode templates emit).
 */
async function loadAndProcess(
  path: string,
  vars: Env,
  allowPreprocessing: boolean
): Promise<InfoPlist | null> {
  const shouldPreprocess =
    allowPreprocessing && vars.INFOPLIST_PREPROCESS === "YES";
  let raw: Record<string, string> | null = null;
  if (shouldPreprocess) {
    raw = preprocessPlist(path, vars);
  } else {
    try {
      raw = parseInfoPlistStrings(await readFile(path, "utf-8"));
    } catch (err) {
      log.debug("Could not read Info.plist", err);
    }
  }
  const parsed = raw ? toPartialPlist(raw) : {};
  const base = plistComplete(parsed) ? parsed : fromEnvVars(vars);
  if (!base) {
    return null;
  }
  return {
    name: expandXcodeVars(base.name, vars),
    bundleId: expandXcodeVars(base.bundleId, vars),
    version: expandXcodeVars(base.version, vars),
    build: expandXcodeVars(base.build, vars),
  };
}

/** Minimal `xcodebuild -list` project info. */
type XcodeProjectInfo = {
  path: string;
  targets: string[];
  configurations: string[];
};

/** Locate a single `.xcodeproj` under `cwd` and read its targets/configs. */
function getXcodeProjectInfo(cwd: string): XcodeProjectInfo | null {
  let projectPath: string | null = null;
  if (cwd.endsWith(".xcodeproj")) {
    projectPath = cwd;
  } else {
    let entries: string[] = [];
    try {
      entries = readdirSync(cwd);
    } catch (err) {
      log.debug("Could not read directory for .xcodeproj discovery", err);
      return null;
    }
    const projects = entries
      .filter((name) => name.endsWith(".xcodeproj"))
      .map((name) => join(cwd, name));
    if (projects.length === 1) {
      projectPath = projects[0] ?? null;
    }
  }
  if (!projectPath) {
    return null;
  }
  const out = runCapture("xcodebuild", [
    "-list",
    "-json",
    "-project",
    projectPath,
  ]);
  if (!out) {
    return null;
  }
  try {
    const parsed = JSON.parse(out) as {
      project?: { targets?: string[]; configurations?: string[] };
    };
    if (!parsed.project) {
      return null;
    }
    return {
      path: resolve(projectPath),
      targets: parsed.project.targets ?? [],
      configurations: parsed.project.configurations ?? [],
    };
  } catch (err) {
    log.debug("Malformed xcodebuild -list JSON", err);
    return null;
  }
}

/** Parse `xcodebuild -showBuildSettings` output into a build-var map. */
function getBuildVars(
  projectPath: string,
  target: string,
  configuration: string
): Record<string, string> {
  const out = runCapture("xcodebuild", [
    "-showBuildSettings",
    "-project",
    projectPath,
    "-target",
    target,
    "-configuration",
    configuration,
  ]);
  const vars: Record<string, string> = {};
  if (!out) {
    return vars;
  }
  for (const line of out.split(LINE_SPLIT)) {
    if (!line.startsWith("    ")) {
      continue;
    }
    const suffix = line.slice(4);
    const idx = suffix.indexOf(" = ");
    if (idx > 0) {
      vars[suffix.slice(0, idx)] = suffix.slice(idx + 3);
    }
  }
  return vars;
}

/** Case-insensitive lookup of a configuration name. */
function findConfiguration(
  pi: XcodeProjectInfo,
  name: string
): string | undefined {
  const lower = name.toLowerCase();
  return pi.configurations.find((cfg) => cfg.toLowerCase() === lower);
}

/** Resolve the Info.plist for the project's first target (release, else debug). */
async function fromProjectInfo(
  pi: XcodeProjectInfo,
  allowPreprocessing: boolean
): Promise<InfoPlist | null> {
  const config =
    findConfiguration(pi, "release") ?? findConfiguration(pi, "debug");
  const target = pi.targets[0];
  if (!(config && target)) {
    return null;
  }
  const vars = getBuildVars(pi.path, target, config);
  const infoPlistFile = vars.INFOPLIST_FILE;
  if (!infoPlistFile) {
    return null;
  }
  const base = vars.PROJECT_DIR ?? dirname(pi.path);
  return await loadAndProcess(
    resolve(base, infoPlistFile),
    vars,
    allowPreprocessing
  );
}

/**
 * Discover the app's bundle identity from the Xcode build environment.
 *
 * When run inside an Xcode build phase (`XCODE_VERSION_ACTUAL` set), reads
 * `INFOPLIST_FILE` (expanding `$(VAR)` references and, if requested, running the
 * C preprocessor) and falls back to build-setting env vars. Otherwise, locates
 * a single `.xcodeproj` and queries `xcodebuild` for the first target's
 * settings. Returns `null` when the identity cannot be determined.
 *
 * @param allowPreprocessing - Permit `cc`-based `INFOPLIST_PREPROCESS` handling.
 */
export async function discoverInfoPlist(
  env: Env,
  cwd: string,
  allowPreprocessing = false
): Promise<InfoPlist | null> {
  if (env.XCODE_VERSION_ACTUAL) {
    const filename = env.INFOPLIST_FILE;
    if (!filename) {
      return fromEnvVars(env);
    }
    const path = resolve(cwd, env.PROJECT_DIR ?? ".", filename);
    return await loadAndProcess(path, env, allowPreprocessing);
  }
  const pi = getXcodeProjectInfo(cwd);
  if (!pi) {
    return null;
  }
  return await fromProjectInfo(pi, allowPreprocessing);
}

/** A resolved release + distribution for the sourcemap upload. */
export type ReleaseAndDist = {
  release?: string;
  dist?: string;
};

/**
 * Resolve the release name and distribution to upload under.
 *
 * Priority mirrors the legacy CLI: `SENTRY_RELEASE`/`SENTRY_DIST` env vars win;
 * otherwise the app `Info.plist` yields `release = <bundleId>@<version>+<build>`
 * and `dist = <build>`.
 *
 * @throws When neither env vars nor the Info.plist provide the identity and
 *   auto-release was not disabled.
 */
export async function resolveReleaseAndDist(
  env: Env,
  cwd: string,
  noAutoRelease: boolean,
  allowPreprocessing = false
): Promise<ReleaseAndDist> {
  const distEnv = env.SENTRY_DIST;
  const releaseEnv = env.SENTRY_RELEASE;

  if (!(distEnv || releaseEnv) && noAutoRelease) {
    return {};
  }
  if (distEnv || releaseEnv) {
    return { release: releaseEnv, dist: distEnv };
  }

  const plist = await discoverInfoPlist(env, cwd, allowPreprocessing);
  if (!plist) {
    throw new Error(
      "Could not determine release: set SENTRY_RELEASE/SENTRY_DIST, run from " +
        "Xcode, or pass --no-auto-release."
    );
  }
  return {
    dist: plist.build,
    release: `${plist.bundleId}@${plist.version}+${plist.build}`,
  };
}
