/**
 * sentry react-native xcode
 *
 * Upload React Native sourcemaps from an Xcode build phase. Runs in three modes:
 *
 *  - **debug** — a non-release build with no packager fetch: just run the RN
 *    build script and exit.
 *  - **fetch** — a simulator build with `--allow-fetch`: download the bundle +
 *    sourcemap from the running packager, then upload.
 *  - **wrap** — a release build: run the RN build script with this CLI standing
 *    in for `NODE_BINARY`/`HERMES_CLI_PATH` (see `wrap-call.ts`), read back the
 *    produced bundle + sourcemap from a JSON report, then upload.
 *
 * Mirrors the legacy `sentry-cli react-native xcode`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { SentryContext } from "../../context.js";
import type { ArtifactFile } from "../../lib/api/sourcemaps.js";
import {
  resolveUploadWait,
  uploadSourcemaps,
} from "../../lib/api/sourcemaps.js";
import { buildCommand } from "../../lib/command.js";
import { ContextError, ValidationError } from "../../lib/errors.js";
import { mdKvTable, renderMarkdown } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";
import {
  isSea,
  type SourceMapReport,
} from "../../lib/react-native/wrap-call.js";
import {
  findHermesc,
  findNode,
  resolveReleaseAndDist,
} from "../../lib/react-native/xcode-env.js";
import { resolveOrgAndProject } from "../../lib/resolve-target.js";

const log = logger.withTag("react-native.xcode");

const USAGE_HINT = "sentry react-native xcode";
const DEFAULT_PACKAGER_URL = "http://127.0.0.1:8081/";
const DEFAULT_BUILD_SCRIPT =
  "../node_modules/react-native/scripts/react-native-xcode.sh";

/** Matches one or more trailing slashes. */
const TRAILING_SLASHES = /\/+$/;

/** Flags accepted by `react-native xcode`. */
type XcodeFlags = {
  force?: boolean;
  "allow-fetch"?: boolean;
  "fetch-from"?: string;
  "build-script"?: string;
  dist?: string[];
  wait?: boolean;
  "wait-for"?: number;
  "no-auto-release"?: boolean;
  "allow-xcode-infoplist-preprocessing"?: boolean;
};

/** Structured result for the xcode command. */
type XcodeResult = {
  mode: "debug" | "fetch" | "wrap";
  bundle?: string;
  sourcemap?: string;
  debugId?: string;
  release?: string;
  dist?: string[];
  uploads: number;
};

/** A resolved bundle + sourcemap pair to upload. */
type BundlePair = { bundle: string; sourcemap: string };

function formatResult(data: XcodeResult): string {
  const rows: [string, string][] = [["Mode", data.mode]];
  if (data.bundle) {
    rows.push(["Bundle", data.bundle]);
  }
  if (data.sourcemap) {
    rows.push(["Sourcemap", data.sourcemap]);
  }
  if (data.debugId) {
    rows.push(["Debug ID", data.debugId]);
  }
  if (data.release) {
    rows.push(["Release", data.release]);
  }
  if (data.dist && data.dist.length > 0) {
    rows.push(["Distributions", data.dist.join(", ")]);
  }
  return renderMarkdown(mdKvTable(rows));
}

/** Whether the build script should be wrapped (release build or forced). */
function shouldWrap(flags: XcodeFlags, env: NodeJS.ProcessEnv): boolean {
  if (flags.force) {
    return true;
  }
  const configuration = env.CONFIGURATION;
  if (configuration === undefined) {
    throw new ValidationError(
      "Need to run this from Xcode (CONFIGURATION is not set).",
      "CONFIGURATION"
    );
  }
  return !configuration.includes("Debug");
}

/** Resolve the RN build script path (canonicalized). */
function resolveScript(flags: XcodeFlags, cwd: string): string {
  const script = resolve(cwd, flags["build-script"] ?? DEFAULT_BUILD_SCRIPT);
  if (!existsSync(script)) {
    throw new ValidationError(
      `React Native build script not found: ${script}`,
      "build-script"
    );
  }
  return script;
}

/** Run the build script directly, propagating its exit status. */
function runScript(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv
): number {
  const rv = spawnSync(script, args, { stdio: "inherit", env });
  // A signal-killed child has `status === null`; treat that as a failure.
  return rv.status ?? (rv.signal !== null || rv.error ? 1 : 0);
}

/** Poll a URL until it responds or the timeout elapses. */
async function waitUntilAvailable(
  url: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.status < 500) {
        return true;
      }
    } catch (err) {
      log.debug("Packager not up yet", err);
    }
    await sleep(500);
  }
  return false;
}

/** Fetch the bundle + sourcemap from the running RN packager. */
async function fetchFromPackager(
  fetchUrl: string,
  tempDir: string
): Promise<BundlePair> {
  const url = fetchUrl.replace(TRAILING_SLASHES, "");
  if (!(await waitUntilAvailable(url, 10_000))) {
    throw new ValidationError(
      "React Native packager did not respond in time.",
      "fetch-from"
    );
  }
  const bundle = join(tempDir, "index.ios.bundle");
  const sourcemap = join(tempDir, "index.ios.map");
  const bundleRes = await fetch(
    `${url}/index.ios.bundle?platform=ios&dev=true`
  );
  if (!bundleRes.ok) {
    throw new ValidationError(
      `Packager returned ${bundleRes.status} for the bundle.`,
      "fetch-from"
    );
  }
  writeFileSync(bundle, Buffer.from(await bundleRes.arrayBuffer()));
  const mapRes = await fetch(`${url}/index.ios.map?platform=ios&dev=true`);
  if (!mapRes.ok) {
    throw new ValidationError(
      `Packager returned ${mapRes.status} for the sourcemap.`,
      "fetch-from"
    );
  }
  writeFileSync(sourcemap, Buffer.from(await mapRes.arrayBuffer()));
  return { bundle, sourcemap };
}

/**
 * Resolve the command RN should invoke in place of `NODE_BINARY`/`HERMES_CLI_PATH`.
 *
 * A SEA binary's `process.execPath` is the CLI itself. Under an npm install
 * `process.execPath` is Node and `argv[1]` is the CLI script, so RN's
 * `$NODE_BINARY <args>` would run plain Node and never re-enter the wrapper;
 * generate a small shim that re-invokes the CLI instead. (macOS/Xcode only.)
 */
function resolveSelfInvocation(ctx: SentryContext, tempDir: string): string {
  const execPath = ctx.process.execPath;
  if (isSea()) {
    return execPath;
  }
  const script = ctx.process.argv[1] ?? "";
  const shim = join(tempDir, "sentry-rn-node.sh");
  writeFileSync(shim, `#!/bin/sh\nexec "${execPath}" "${script}" "$@"\n`, {
    mode: 0o755,
  });
  return shim;
}

/** Run the wrapped build and read the produced bundle/sourcemap paths. */
function runWrappedBuild(
  script: string,
  scriptArgs: string[],
  ctx: SentryContext,
  tempDir: string
): { status: number; pair: BundlePair | null } {
  const reportPath = join(tempDir, "sourcemap-report.json");
  writeFileSync(reportPath, "{}");
  const node = findNode(ctx.env);
  const hermesc = findHermesc(ctx.env);
  const self = resolveSelfInvocation(ctx, tempDir);

  const env: NodeJS.ProcessEnv = {
    ...ctx.env,
    NODE_BINARY: self,
    SENTRY_RN_REAL_NODE_BINARY: node,
    SENTRY_RN_SOURCEMAP_REPORT: reportPath,
    __SENTRY_RN_WRAP_XCODE_CALL: "1",
  };
  if (existsSync(hermesc)) {
    env.HERMES_CLI_PATH = self;
    env.SENTRY_RN_REAL_HERMES_CLI_PATH = hermesc;
  }

  const status = runScript(script, scriptArgs, env);

  let report: SourceMapReport;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf-8")) as SourceMapReport;
  } catch (error) {
    log.debug("Failed to read sourcemap report file", error);
    return { status, pair: null };
  }
  if (!(report.packager_bundle_path && report.packager_sourcemap_path)) {
    return { status, pair: null };
  }
  // Prefer the Hermes bundle + combined sourcemap when present.
  if (report.hermes_bundle_path && report.hermes_sourcemap_path) {
    log.info("Using Hermes bundle and combined source map.");
    return {
      status,
      pair: {
        bundle: report.hermes_bundle_path,
        sourcemap: report.hermes_sourcemap_path,
      },
    };
  }
  log.info("Using React Native Packager bundle and source map.");
  return {
    status,
    pair: {
      bundle: report.packager_bundle_path,
      sourcemap: report.packager_sourcemap_path,
    },
  };
}

/** Read the debug id already present in a sourcemap (from the Metro plugin). */
async function readSourcemapDebugId(
  mapPath: string
): Promise<string | undefined> {
  try {
    const map = JSON.parse(await readFile(mapPath, "utf-8")) as {
      debugId?: string;
      debug_id?: string;
    };
    return map.debugId ?? map.debug_id;
  } catch (err) {
    log.debug("Could not read debug id from sourcemap", err);
    return;
  }
}

/** Upload the bundle/sourcemap pair using the sourcemap's existing debug id. */
async function uploadPair(
  pair: BundlePair,
  ctx: SentryContext,
  flags: XcodeFlags
): Promise<{
  debugId?: string;
  release?: string;
  dist: string[];
  uploads: number;
}> {
  const resolved = await resolveOrgAndProject({
    cwd: ctx.cwd,
    usageHint: USAGE_HINT,
  });
  if (!resolved) {
    throw new ContextError("Organization and project", USAGE_HINT);
  }
  const { org, project } = resolved;

  // The RN Metro/Sentry plugin injects the debug id into the bundle + sourcemap
  // at build time, and the wrapper copies it into the Hermes sourcemap. We must
  // NOT re-inject: a release bundle may be Hermes bytecode, which a JS snippet
  // would corrupt. Read the existing debug id from the sourcemap instead.
  const debugId = await readSourcemapDebugId(pair.sourcemap);
  if (!debugId) {
    log.warn(
      "No debug id found in the sourcemap; uploading without one. Ensure the " +
        "Sentry React Native Metro plugin is configured."
    );
  }
  const debugIdField = debugId ? { debugId } : {};
  const files: ArtifactFile[] = [
    {
      path: pair.bundle,
      ...debugIdField,
      type: "minified_source",
      url: `~/${basename(pair.bundle)}`,
      sourcemapFilename: basename(pair.sourcemap),
    },
    {
      path: pair.sourcemap,
      ...debugIdField,
      type: "source_map",
      url: `~/${basename(pair.sourcemap)}`,
    },
  ];

  const { release, dist } = await resolveReleaseAndDist(
    ctx.env,
    ctx.cwd,
    flags["no-auto-release"] ?? false,
    flags["allow-xcode-infoplist-preprocessing"] ?? false
  );
  // Explicit --dist overrides the environment/plist-derived distribution.
  let dists: string[] = [];
  if (flags.dist && flags.dist.length > 0) {
    dists = flags.dist;
  } else if (dist) {
    dists = [dist];
  }

  const { wait, maxWaitMs } = resolveUploadWait(flags);
  let uploads = 0;
  if (dists.length > 0) {
    for (const d of dists) {
      await uploadSourcemaps({
        org,
        project,
        release,
        dist: d,
        files,
        wait,
        maxWaitMs,
      });
      uploads += 1;
    }
  } else {
    await uploadSourcemaps({ org, project, release, files, wait, maxWaitMs });
    uploads = 1;
  }
  return { debugId, release, dist: dists, uploads };
}

/** Either a resolved pair to upload, or a terminal (no-upload) outcome. */
type PrepareResult =
  | {
      kind: "terminal";
      result: XcodeResult;
      hint: string;
      exitCode?: number;
    }
  | { kind: "pair"; mode: "fetch" | "wrap"; pair: BundlePair };

/** Resolve the bundle/sourcemap pair via the packager (fetch) or a wrapped build. */
async function preparePair(
  ctx: SentryContext,
  script: string,
  scriptArgs: string[],
  fetchUrl: string | undefined
): Promise<PrepareResult> {
  const tempDir = mkdtempSync(join(tmpdir(), "sentry-rn-xcode-"));
  if (fetchUrl) {
    log.info(`Fetching sourcemaps from ${fetchUrl}`);
    return {
      kind: "pair",
      mode: "fetch",
      pair: await fetchFromPackager(fetchUrl, tempDir),
    };
  }
  const result = runWrappedBuild(script, scriptArgs, ctx, tempDir);
  // A failed build must not publish artifacts (matches the legacy CLI, which
  // exits on a non-zero build status before uploading).
  if (result.status !== 0) {
    return {
      kind: "terminal",
      result: { mode: "wrap", uploads: 0 },
      hint: "React Native build failed; skipped upload.",
      exitCode: result.status,
    };
  }
  if (!result.pair) {
    log.warn("Build produced no packager sourcemaps.");
    return {
      kind: "terminal",
      result: { mode: "wrap", uploads: 0 },
      hint: "No sourcemaps were produced by the build.",
    };
  }
  return { kind: "pair", mode: "wrap", pair: result.pair };
}

export const xcodeCommand = buildCommand({
  docs: {
    brief: "Upload React Native sourcemaps (Xcode build step)",
    fullDescription:
      "Upload React Native sourcemaps from an Xcode build phase. In a release " +
      "build the RN build script is wrapped so the produced bundle and " +
      "sourcemap are captured and uploaded; in a simulator build with " +
      "`--allow-fetch` they are fetched from the packager; in a debug build " +
      "the script simply runs.\n\n" +
      "Release/distribution come from `SENTRY_RELEASE`/`SENTRY_DIST` or the " +
      "app Info.plist (unless `--no-auto-release`); outside an Xcode build the " +
      "release is discovered via `xcodebuild`. Use `--wait`/`--wait-for` to " +
      "block until the server finishes processing the upload.",
  },
  auth: false,
  output: {
    human: formatResult,
  },
  parameters: {
    flags: {
      force: {
        kind: "boolean",
        brief: "Run even in a debug configuration",
        optional: true,
      },
      "allow-fetch": {
        kind: "boolean",
        brief: "Fetch sourcemaps from the packager on simulator builds",
        optional: true,
      },
      "fetch-from": {
        kind: "parsed",
        parse: String,
        brief: `Packager URL to fetch from (default: ${DEFAULT_PACKAGER_URL})`,
        optional: true,
      },
      "build-script": {
        kind: "parsed",
        parse: String,
        brief: "Path to the react-native-xcode.sh build script",
        optional: true,
      },
      dist: {
        kind: "parsed",
        parse: String,
        variadic: true,
        brief: "Distribution(s) to publish (repeatable)",
        optional: true,
      },
      wait: {
        kind: "boolean",
        brief: "Wait for the server to fully process the uploaded files",
        optional: true,
      },
      "wait-for": {
        kind: "parsed",
        parse: Number,
        brief: "Wait for processing, but at most this many seconds",
        optional: true,
      },
      "no-auto-release": {
        kind: "boolean",
        brief: "Don't read the release from Xcode project files",
        optional: true,
      },
      "allow-xcode-infoplist-preprocessing": {
        kind: "boolean",
        brief: "Run the C preprocessor over Info.plist (INFOPLIST_PREPROCESS)",
        optional: true,
      },
    },
    aliases: { f: "force" },
    positional: {
      kind: "array",
      parameter: {
        placeholder: "script-arg",
        brief: "Extra arguments passed to the build script",
        parse: String,
      },
    },
  },
  async *func(this: SentryContext, flags: XcodeFlags, ...scriptArgs: string[]) {
    const wrap = shouldWrap(flags, this.env);
    const script = resolveScript(flags, this.cwd);

    const simulator = this.env.PLATFORM_NAME?.endsWith("simulator") ?? false;
    const fetchUrl =
      flags["allow-fetch"] && simulator
        ? (flags["fetch-from"] ?? DEFAULT_PACKAGER_URL)
        : undefined;

    // Debug build with no fetch: just run the script and exit.
    if (!(wrap || fetchUrl)) {
      log.info("Running in debug mode, skipping script wrapping.");
      const status = runScript(script, scriptArgs, this.env);
      if (status !== 0) {
        this.process.exitCode = status;
      }
      yield new CommandOutput<XcodeResult>({ mode: "debug", uploads: 0 });
      return { hint: "Ran the React Native build script (debug mode)." };
    }

    const prep = await preparePair(this, script, scriptArgs, fetchUrl);
    if (prep.kind === "terminal") {
      if (prep.exitCode !== undefined) {
        this.process.exitCode = prep.exitCode;
      }
      yield new CommandOutput<XcodeResult>(prep.result);
      return { hint: prep.hint };
    }

    log.info("Processing React Native sourcemaps for Sentry upload.");
    const { pair, mode } = prep;
    const { debugId, release, dist, uploads } = await uploadPair(
      pair,
      this,
      flags
    );

    yield new CommandOutput<XcodeResult>({
      mode,
      bundle: pair.bundle,
      sourcemap: pair.sourcemap,
      debugId,
      release,
      dist: dist.length > 0 ? dist : undefined,
      uploads,
    });
    return {
      hint: debugId
        ? `Uploaded sourcemaps with debug ID ${debugId}.`
        : "Uploaded sourcemaps.",
    };
  },
});
