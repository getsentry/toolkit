/**
 * sentry build upload <paths...>
 *
 * Upload mobile builds to Sentry for preprod size analysis. Each build is
 * normalized into a deterministic wrapper ZIP and uploaded via the
 * chunk-upload + preprod-artifacts assemble protocol.
 *
 * This PR supports Android APK/AAB. iOS XCArchive/IPA is ported separately;
 * git/VCS metadata collection is added in a follow-up. Sentry SaaS only.
 */

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SentryContext } from "../../context.js";
import {
  type BuildUploadMetadata,
  uploadBuild,
} from "../../lib/api/preprod-artifacts.js";
import {
  detectBuildFormatFromFile,
  normalizeBuildDirectory,
  normalizeBuildFile,
  normalizeIpa,
  parsePluginFromPipeline,
  validateXcarchiveDirectory,
} from "../../lib/build/index.js";
import {
  collectVcsMetadata,
  isCi,
  type VcsFlags,
  vcsInfoToBody,
} from "../../lib/build/vcs.js";
import { buildCommand } from "../../lib/command.js";
import { ContextError, ValidationError } from "../../lib/errors.js";
import {
  colorTag,
  mdKvTable,
  renderMarkdown,
} from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";
import { resolveOrgAndProject } from "../../lib/resolve-target.js";

const log = logger.withTag("build.upload");

const USAGE_HINT = "sentry build upload <path>";

/** Parse `--pr-number` as a non-negative integer. */
function parsePrNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("PR number must be a non-negative integer");
  }
  return parsed;
}

/** Flags accepted by `build upload`. */
type UploadFlags = {
  "build-configuration"?: string;
  "release-notes"?: string;
  "install-group"?: string[];
} & VcsFlags;

/** Result for a single uploaded path. */
type BuildUploadEntry = {
  /** The build file path. */
  path: string;
  /** The assembled artifact URL, or `null` if this path failed. */
  artifactUrl: string | null;
  /** Failure reason, or `null` on success. */
  error: string | null;
};

/** Structured result for `build upload`. */
type BuildUploadResult = {
  /** Per-path outcomes. */
  builds: BuildUploadEntry[];
  /** Number of builds successfully uploaded. */
  uploadedCount: number;
};

/** Human-readable formatter for the upload result. */
function formatUploadResult(data: BuildUploadResult): string {
  const rows = data.builds.map((entry): [string, string] => [
    entry.path,
    entry.error
      ? colorTag("error", entry.error)
      : (entry.artifactUrl ?? colorTag("muted", "uploaded")),
  ]);
  const header =
    data.uploadedCount === data.builds.length
      ? `Uploaded ${data.uploadedCount} build(s)`
      : `Uploaded ${data.uploadedCount} of ${data.builds.length} build(s)`;
  return renderMarkdown(`${header}\n\n${mdKvTable(rows)}`);
}

/**
 * Normalize and upload a single build path.
 *
 * @throws {ValidationError} When the path is unreadable or an unsupported format.
 */
async function uploadOne(
  ctx: SentryContext,
  path: string,
  org: string,
  project: string,
  metadata: BuildUploadMetadata
): Promise<string> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (err) {
    log.debug(`Failed to stat build path ${path}`, err);
    throw new ValidationError(`Path does not exist: ${path}`, "path");
  }

  const plugin = parsePluginFromPipeline(ctx.env.SENTRY_PIPELINE);

  // Normalize into a wrapper ZIP on disk (streamed, so peak memory does not
  // scale with the build size), then upload it via the file-based chunk path.
  const workDir = await mkdtemp(join(tmpdir(), "sentry-build-"));
  const outPath = join(workDir, "normalized.zip");
  try {
    // An XCArchive is a directory; validate its structure, then zip it. The
    // validation refuses arbitrary directories so a stray
    // `sentry build upload ./` can't sweep up source, .git/, or secrets.
    if (info.isDirectory()) {
      validateXcarchiveDirectory(path);
      await normalizeBuildDirectory(path, outPath, plugin);
    } else {
      // detectBuildFormatFromFile only classifies files (apk/aab/ipa);
      // XCArchive is a directory, handled above.
      const format = await detectBuildFormatFromFile(path);
      if (format === "ipa") {
        await normalizeIpa(path, outPath, plugin);
      } else if (format === "apk" || format === "aab") {
        await normalizeBuildFile(path, outPath, plugin);
      } else {
        throw new ValidationError(
          `Unsupported build format (expected APK, AAB, IPA, or XCArchive): ${path}`,
          "path"
        );
      }
    }
    return await uploadBuild({
      org,
      project,
      contentPath: outPath,
      metadata,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export const uploadCommand = buildCommand({
  docs: {
    brief: "Upload builds to a project",
    fullDescription:
      "Upload mobile builds to Sentry for preprod size analysis. Each build " +
      "is normalized into a deterministic ZIP and uploaded via the " +
      "chunk-upload + assemble protocol.\n\n" +
      "Supported formats: Android APK/AAB, iOS XCArchive (a directory) and IPA. " +
      "Note: iOS Assets.car asset catalogs are not parsed into per-asset " +
      "images. This feature only works with Sentry SaaS.\n\n" +
      "Usage:\n" +
      "  sentry build upload ./app-release.apk\n" +
      "  sentry build upload ./MyApp.xcarchive\n" +
      "  sentry build upload ./MyApp.ipa --build-configuration Release\n" +
      "  sentry build upload ./app.aab --install-group qa --install-group beta",
  },
  output: {
    human: formatUploadResult,
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        brief: "Path(s) to the build(s) to upload (APK, AAB, IPA, or XCArchive)",
        parse: String,
        placeholder: "path",
      },
    },
    flags: {
      "build-configuration": {
        kind: "parsed",
        parse: String,
        brief:
          "Build configuration for the upload (defaults to the current version)",
        optional: true,
      },
      "release-notes": {
        kind: "parsed",
        parse: String,
        brief: "Release notes for the build",
        optional: true,
      },
      "install-group": {
        kind: "parsed",
        parse: String,
        brief:
          "Install group(s) for this build (repeatable); builds sharing a group show updates for each other",
        optional: true,
        variadic: true,
      },
      "head-sha": {
        kind: "parsed",
        parse: String,
        brief: "VCS commit SHA (defaults to the current commit)",
        optional: true,
      },
      "base-sha": {
        kind: "parsed",
        parse: String,
        brief:
          "VCS base commit SHA (defaults to the merge-base with the base ref)",
        optional: true,
      },
      "vcs-provider": {
        kind: "parsed",
        parse: String,
        brief: "VCS provider (defaults to the current remote's provider)",
        optional: true,
      },
      "head-repo-name": {
        kind: "parsed",
        parse: String,
        brief: "Head repository name, e.g. owner/repo (defaults to the current)",
        optional: true,
      },
      "base-repo-name": {
        kind: "parsed",
        parse: String,
        brief: "Base repository name, e.g. owner/repo (for forks)",
        optional: true,
      },
      "head-ref": {
        kind: "parsed",
        parse: String,
        brief: "Head branch/reference (defaults to the current branch)",
        optional: true,
      },
      "base-ref": {
        kind: "parsed",
        parse: String,
        brief: "Base branch/reference (defaults to the merge-base tracking ref)",
        optional: true,
      },
      "pr-number": {
        kind: "parsed",
        parse: parsePrNumber,
        brief:
          "Pull request number (auto-detected in pull_request GitHub Actions runs)",
        optional: true,
      },
      "force-git-metadata": {
        kind: "boolean",
        brief:
          "Force collecting git metadata even outside CI (conflicts with --no-git-metadata)",
        optional: true,
      },
      "no-git-metadata": {
        kind: "boolean",
        brief: "Disable automatic git metadata collection",
        optional: true,
      },
    },
  },
  async *func(this: SentryContext, flags: UploadFlags, ...paths: string[]) {
    if (paths.length === 0) {
      throw new ValidationError("At least one build path is required", "path");
    }

    const resolved = await resolveOrgAndProject({
      cwd: this.cwd,
      usageHint: USAGE_HINT,
    });
    if (!resolved) {
      throw new ContextError("Organization and project", USAGE_HINT);
    }
    const { org, project } = resolved;

    if (flags["force-git-metadata"] && flags["no-git-metadata"]) {
      throw new ValidationError(
        "--force-git-metadata and --no-git-metadata cannot be used together",
        "force-git-metadata"
      );
    }
    // Collect git metadata automatically in CI (unless disabled), or when forced.
    const shouldCollectVcs =
      Boolean(flags["force-git-metadata"]) ||
      (!flags["no-git-metadata"] && isCi(this.env));
    const vcs = collectVcsMetadata(
      flags,
      this.cwd,
      this.env,
      shouldCollectVcs
    );

    const metadata: BuildUploadMetadata = {
      buildConfiguration: flags["build-configuration"],
      releaseNotes: flags["release-notes"],
      installGroups: flags["install-group"],
      vcs: vcsInfoToBody(vcs),
    };

    const builds: BuildUploadEntry[] = [];
    for (const path of paths) {
      try {
        const artifactUrl = await uploadOne(this, path, org, project, metadata);
        builds.push({ path, artifactUrl, error: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to upload build ${path}`, err);
        builds.push({ path, artifactUrl: null, error: message });
      }
    }

    const uploadedCount = builds.filter((b) => b.error === null).length;
    yield new CommandOutput<BuildUploadResult>({ builds, uploadedCount });

    // Deliberate deviation from the legacy CLI, which only exits non-zero when
    // *every* build fails: we fail loud on *any* failure so CI/agents never
    // mistake a partial upload for a clean success.
    if (uploadedCount === 0) {
      this.process.exitCode = 1;
      return { hint: "No builds were uploaded. See the errors above." };
    }
    if (uploadedCount < builds.length) {
      this.process.exitCode = 1;
      return {
        hint: `Uploaded ${uploadedCount} of ${builds.length} build(s); some failed.`,
      };
    }
    return { hint: "View your builds in Sentry to see the size analysis." };
  },
});
