/**
 * sentry react-native gradle
 *
 * Upload a React Native bundle + sourcemap during a Gradle build step (invoked
 * by the sentry-android-gradle-plugin). Injects a debug ID into the bundle and
 * its sourcemap, then uploads both as artifacts under the `~/<filename>`
 * convention — with debug-ID-only matching, or per release/distribution.
 *
 * Mirrors the legacy `sentry-cli react-native gradle`.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
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
import { resolveOrgAndProject } from "../../lib/resolve-target.js";
import { injectDebugId } from "../../lib/sourcemap/debug-id.js";

const log = logger.withTag("react-native.gradle");

const USAGE_HINT =
  "sentry react-native gradle --sourcemap <path> --bundle <path>";

/** Little-endian magic (0xFB0BD1E5) that starts an indexed RAM bundle. */
const RAM_BUNDLE_MAGIC = [0xe5, 0xd1, 0x0b, 0xfb];

/** Flags accepted by `react-native gradle`. */
type GradleFlags = {
  sourcemap: string;
  bundle: string;
  release?: string;
  dist?: string[];
  wait?: boolean;
  "wait-for"?: number;
};

/** Structured result for the gradle upload. */
type GradleResult = {
  bundle: string;
  sourcemap: string;
  debugId: string;
  release?: string;
  dist?: string[];
  /** Number of upload operations performed (one per distribution). */
  uploads: number;
};

/** Human-readable summary. */
function formatGradleResult(data: GradleResult): string {
  const rows: [string, string][] = [
    ["Bundle", data.bundle],
    ["Sourcemap", data.sourcemap],
    ["Debug ID", data.debugId],
  ];
  if (data.release) {
    rows.push(["Release", data.release]);
  }
  if (data.dist && data.dist.length > 0) {
    rows.push(["Distributions", data.dist.join(", ")]);
  }
  return renderMarkdown(mdKvTable(rows));
}

/** Ensure a path exists and is a regular file. */
async function assertFile(path: string, label: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) {
    throw new ValidationError(`${label} not found: ${path}`, label);
  }
}

/** Reject indexed RAM bundles, which cannot carry an injected debug ID. */
async function assertNotRamBundle(bundlePath: string): Promise<void> {
  const handle = await readFile(bundlePath);
  const isRamBundle =
    handle.length >= RAM_BUNDLE_MAGIC.length &&
    RAM_BUNDLE_MAGIC.every((byte, i) => handle[i] === byte);
  if (isRamBundle) {
    throw new ValidationError(
      "Indexed RAM bundles are not supported. Use a plain or Hermes bundle.",
      "bundle"
    );
  }
}

/** Build the artifact list for a debug-ID-injected bundle + sourcemap pair. */
function buildArtifacts(
  bundlePath: string,
  sourcemapPath: string,
  debugId: string
): ArtifactFile[] {
  const bundleName = basename(bundlePath);
  const sourcemapName = basename(sourcemapPath);
  return [
    {
      path: bundlePath,
      debugId,
      type: "minified_source",
      url: `~/${bundleName}`,
      sourcemapFilename: sourcemapName,
    },
    {
      path: sourcemapPath,
      debugId,
      type: "source_map",
      url: `~/${sourcemapName}`,
    },
  ];
}

export const gradleCommand = buildCommand({
  docs: {
    brief: "Upload a React Native bundle + sourcemap (Gradle build step)",
    fullDescription:
      "Upload a React Native bundle and sourcemap during a Gradle build step " +
      "(invoked by the sentry-android-gradle-plugin). A debug ID is injected " +
      "into both files and they are uploaded under the `~/<filename>` " +
      "convention.\n\n" +
      "Without `--release`, files are matched by debug ID. With `--release`, " +
      "they are also uploaded for each `--dist`.\n\n" +
      "Use `--wait`/`--wait-for` to block until the server finishes processing " +
      "the upload. Indexed/file RAM bundles (a pre-Hermes format) are not " +
      "supported; use a plain or Hermes bundle.",
  },
  output: {
    human: formatGradleResult,
  },
  parameters: {
    flags: {
      sourcemap: {
        kind: "parsed",
        parse: String,
        brief: "Path to the sourcemap to upload",
      },
      bundle: {
        kind: "parsed",
        parse: String,
        brief: "Path to the bundle to upload",
      },
      release: {
        kind: "parsed",
        parse: String,
        brief: "Release version to publish to",
        optional: true,
      },
      dist: {
        kind: "parsed",
        parse: String,
        variadic: true,
        brief: "Distribution(s) to publish (repeatable; requires --release)",
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
    },
  },
  async *func(this: SentryContext, flags: GradleFlags) {
    const bundlePath = resolve(this.cwd, flags.bundle);
    const sourcemapPath = resolve(this.cwd, flags.sourcemap);
    await assertFile(bundlePath, "bundle");
    await assertFile(sourcemapPath, "sourcemap");
    await assertNotRamBundle(bundlePath);

    const resolved = await resolveOrgAndProject({
      cwd: this.cwd,
      usageHint: USAGE_HINT,
    });
    if (!resolved) {
      throw new ContextError("Organization and project", USAGE_HINT);
    }
    const { org, project } = resolved;

    log.info("Processing React Native sourcemaps for Sentry upload.");
    const { debugId } = await injectDebugId(bundlePath, sourcemapPath);
    const files = buildArtifacts(bundlePath, sourcemapPath, debugId);

    const { wait, maxWaitMs } = resolveUploadWait(flags);
    const dists = flags.dist ?? [];
    let uploads = 0;
    if (flags.release && dists.length > 0) {
      for (const dist of dists) {
        log.info(
          `Uploading sourcemaps for release ${flags.release} distribution ${dist}`
        );
        await uploadSourcemaps({
          org,
          project,
          release: flags.release,
          dist,
          files,
          wait,
          maxWaitMs,
        });
        uploads += 1;
      }
    } else {
      await uploadSourcemaps({
        org,
        project,
        release: flags.release,
        files,
        wait,
        maxWaitMs,
      });
      uploads = 1;
    }

    yield new CommandOutput<GradleResult>({
      bundle: bundlePath,
      sourcemap: sourcemapPath,
      debugId,
      release: flags.release,
      dist: dists.length > 0 ? dists : undefined,
      uploads,
    });
    return {
      hint: `Uploaded ${uploads} artifact set(s) with debug ID ${debugId}.`,
    };
  },
});
