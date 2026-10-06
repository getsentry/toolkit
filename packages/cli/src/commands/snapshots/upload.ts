/**
 * sentry snapshots upload <path> --app-id <id>
 *
 * Upload a folder of screenshot images as a snapshot for visual diffing. Each
 * image is hashed and uploaded to Objectstore (skipping any already present),
 * then a manifest is POSTed to create the snapshot. Sentry SaaS only.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { SentryContext } from "../../context.js";
import {
  type CreateSnapshotResponse,
  createPreprodSnapshot,
  fetchSnapshotsUploadOptions,
} from "../../lib/api/preprod-artifacts.js";
import {
  collectVcsMetadata,
  isCi,
  type VcsFlags,
  type VcsInfo,
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
import {
  type ObjectstoreConfig,
  objectExists,
  putObject,
} from "../../lib/objectstore.js";
import { resolveOrgAndProject } from "../../lib/resolve-target.js";
import {
  type CollectedImage,
  collectImages,
  normalizeImageNames,
  splitAndTrim,
  validateImageSizes,
} from "../../lib/snapshots/images.js";

const log = logger.withTag("snapshots.upload");

const USAGE_HINT = "sentry snapshots upload <path> --app-id <id>";

/** Concurrency for objectstore HEAD/PUT requests. */
const UPLOAD_CONCURRENCY = 8;

/** Flags accepted by `snapshots upload`. */
type UploadFlags = {
  "app-id": string;
  "diff-threshold"?: number;
  selective?: boolean;
  "all-image-file-names"?: string;
  "all-image-file-names-file"?: string;
} & VcsFlags;

/** Structured result for `snapshots upload`. */
type SnapshotUploadResult = {
  /** Number of image files discovered. */
  imagesFound: number;
  /** Number of images newly uploaded to objectstore. */
  uploaded: number;
  /** Number of images skipped (already present in objectstore). */
  skipped: number;
  /** The created snapshot, or `null` when there was nothing to record. */
  snapshot: CreateSnapshotResponse | null;
};

/** Parse `--diff-threshold` as a float in [0, 1]. */
function parseDiffThreshold(value: string): number {
  const parsed = Number(value);
  if (value.trim() === "" || Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("diff threshold must be a number between 0.0 and 1.0");
  }
  return parsed;
}

/** Parse `--pr-number` as a non-negative integer. */
function parsePrNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("PR number must be a non-negative integer");
  }
  return parsed;
}

/**
 * Resolve `--all-image-file-names` / `--all-image-file-names-file` into a
 * normalized list, or `undefined` when neither is set.
 */
async function resolveAllImageNames(
  flags: UploadFlags
): Promise<string[] | undefined> {
  if (flags["all-image-file-names"] !== undefined) {
    const names = normalizeImageNames(
      splitAndTrim(flags["all-image-file-names"], ",")
    );
    if (names.length === 0) {
      throw new ValidationError(
        "--all-image-file-names must not be empty",
        "all-image-file-names"
      );
    }
    return names;
  }
  if (flags["all-image-file-names-file"] !== undefined) {
    const path = flags["all-image-file-names-file"];
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (err) {
      log.debug(`Failed to read --all-image-file-names-file ${path}`, err);
      throw new ValidationError(
        `Failed to read --all-image-file-names-file: ${path}`,
        "all-image-file-names-file"
      );
    }
    const names = normalizeImageNames(splitAndTrim(content, "\n"));
    if (names.length === 0) {
      throw new ValidationError(
        `--all-image-file-names-file is empty or contains only blank lines: ${path}`,
        "all-image-file-names-file"
      );
    }
    return names;
  }
  return;
}

/**
 * Validate the git-metadata flags and collect VCS info for the manifest.
 *
 * @throws {ValidationError} On conflicting flags or a PR number without a base SHA.
 */
function collectVcs(
  flags: UploadFlags,
  cwd: string,
  env: NodeJS.ProcessEnv
): VcsInfo {
  if (flags["force-git-metadata"] && flags["no-git-metadata"]) {
    throw new ValidationError(
      "--force-git-metadata and --no-git-metadata cannot be used together",
      "force-git-metadata"
    );
  }
  const shouldCollect =
    Boolean(flags["force-git-metadata"]) ||
    (!flags["no-git-metadata"] && isCi(env));
  const vcs = collectVcsMetadata(flags, cwd, env, shouldCollect);
  if (vcs.prNumber !== undefined && !vcs.baseSha) {
    throw new ValidationError(
      "A PR number was provided but no base SHA could be determined. " +
        "Pass --base-sha explicitly or ensure your CI exposes the merge base.",
      "pr-number"
    );
  }
  return vcs;
}

/**
 * Resolve the selective-upload settings and validate that every collected image
 * is present in `--all-image-file-names` (when provided).
 *
 * @throws {ValidationError} When an uploaded image is not in the provided list.
 */
async function resolveSelective(
  flags: UploadFlags,
  images: CollectedImage[]
): Promise<{ selective: boolean; allImageNames?: string[] }> {
  const allImageNames = await resolveAllImageNames(flags);
  const selective = Boolean(flags.selective) || allImageNames !== undefined;
  if (allImageNames) {
    const known = new Set(allImageNames);
    const unknown = images
      .map((img) => img.relativePath)
      .filter((key) => !known.has(key))
      .sort();
    if (unknown.length > 0) {
      throw new ValidationError(
        `The following uploaded images are not in --all-image-file-names: ${unknown.join(
          ", "
        )}`,
        "all-image-file-names"
      );
    }
  }
  return { selective, allImageNames };
}

/** Run `fn` over `items` with bounded concurrency. */
async function runPooled<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(fn));
  }
}

/** A per-image manifest metadata entry (width/height override sidecar). */
function imageMetadata(image: CollectedImage): Record<string, unknown> {
  return {
    ...image.sidecar,
    content_hash: image.hash,
    width: image.width,
    height: image.height,
  };
}

/** Result of uploading images to objectstore. */
type UploadImagesResult = {
  /** Manifest entries keyed by relative image path. */
  entries: Record<string, Record<string, unknown>>;
  /** Number of images newly uploaded. */
  uploaded: number;
  /** Number of images skipped (already present). */
  skipped: number;
};

/**
 * Upload the collected images to objectstore, deduping by content and skipping
 * objects that already exist.
 */
async function uploadImages(
  org: string,
  project: string,
  images: CollectedImage[]
): Promise<UploadImagesResult> {
  const { objectstore } = await fetchSnapshotsUploadOptions(org, project);
  const config: ObjectstoreConfig = objectstore;

  const findScope = (name: string): string | undefined =>
    config.scopes.find(([key]) => key === name)?.[1];
  const orgId = findScope("org");
  const projectId = findScope("project");
  if (!(orgId && projectId)) {
    throw new ValidationError(
      "Snapshot upload options are missing org/project scope",
      "app-id"
    );
  }

  const entries: Record<string, Record<string, unknown>> = {};
  const prepared: { path: string; key: string }[] = [];
  const duplicates: string[] = [];
  for (const image of images) {
    if (entries[image.relativePath]) {
      duplicates.push(image.relativePath);
      continue;
    }
    entries[image.relativePath] = imageMetadata(image);
    prepared.push({
      path: image.path,
      key: `${orgId}/${projectId}/${image.hash}`,
    });
  }
  if (duplicates.length > 0) {
    log.warn(`Duplicate paths encountered, skipping: ${duplicates.join(", ")}`);
  }

  // HEAD to find objects already present, then PUT only the missing ones.
  const existing = new Set<string>();
  await runPooled(prepared, UPLOAD_CONCURRENCY, async (item) => {
    if (await objectExists(config, item.key)) {
      existing.add(item.key);
    }
  });
  const missing = prepared.filter((item) => !existing.has(item.key));
  await runPooled(missing, UPLOAD_CONCURRENCY, async (item) => {
    await putObject(config, item.key, await readFile(item.path));
  });

  return {
    entries,
    uploaded: missing.length,
    skipped: prepared.length - missing.length,
  };
}

/** Inputs for {@link buildManifest}. */
type ManifestOptions = {
  appId: string;
  entries: Record<string, Record<string, unknown>>;
  diffThreshold?: number;
  selective: boolean;
  allImageNames?: string[];
  vcs: VcsInfo;
};

/** Build the snapshot manifest body (VcsInfo flattened at the top level). */
function buildManifest(opts: ManifestOptions): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    app_id: opts.appId,
    images: opts.entries,
    ...vcsInfoToBody(opts.vcs),
  };
  if (opts.diffThreshold !== undefined) {
    manifest.diff_threshold = opts.diffThreshold;
  }
  if (opts.selective) {
    manifest.selective = true;
  }
  if (opts.allImageNames) {
    manifest.all_image_file_names = opts.allImageNames;
  }
  return manifest;
}

/** Human-readable formatter for the upload result. */
function formatUploadResult(data: SnapshotUploadResult): string {
  if (!data.snapshot) {
    return renderMarkdown("No image files found.");
  }
  const rows: [string, string][] = [
    ["Snapshot", data.snapshot.artifactId],
    ["Images", String(data.snapshot.imageCount)],
    ["Uploaded", String(data.uploaded)],
    ["Skipped (already present)", String(data.skipped)],
  ];
  if (data.snapshot.snapshotUrl) {
    rows.push(["URL", data.snapshot.snapshotUrl]);
  }
  return renderMarkdown(
    `${colorTag("green", "Created snapshot")}\n\n${mdKvTable(rows)}`
  );
}

export const uploadCommand = buildCommand({
  docs: {
    brief: "Upload snapshots to a project",
    fullDescription:
      "Upload a folder of screenshot images as a snapshot for visual diffing.\n\n" +
      "Each image (PNG/JPEG) is hashed and uploaded to Sentry's object store " +
      "(images already present are skipped), then a manifest is created. " +
      "Companion `<image>.json` sidecar files add per-image metadata. " +
      "This feature only works with Sentry SaaS.\n\n" +
      "Usage:\n" +
      "  sentry snapshots upload ./screenshots --app-id com.example.app\n" +
      "  sentry snapshots upload ./shots --app-id my-app --diff-threshold 0.01\n" +
      "  sentry snapshots upload ./shots --app-id my-app --selective",
  },
  output: {
    human: formatUploadResult,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Path to the folder containing images to upload",
          parse: String,
          placeholder: "path",
        },
      ],
    },
    flags: {
      "app-id": {
        kind: "parsed",
        parse: String,
        brief: "The application identifier",
      },
      "diff-threshold": {
        kind: "parsed",
        parse: parseDiffThreshold,
        brief:
          "Only report an image as changed when its difference exceeds this fraction (0.0–1.0, e.g. 0.01 = 1%)",
        optional: true,
      },
      selective: {
        kind: "boolean",
        brief:
          "This upload contains only a subset of images (removals/renames won't be detected on PRs)",
        optional: true,
      },
      "all-image-file-names": {
        kind: "parsed",
        parse: String,
        brief:
          "Comma-separated list of all image names in the full suite (for selective uploads; implies --selective)",
        optional: true,
      },
      "all-image-file-names-file": {
        kind: "parsed",
        parse: String,
        brief:
          "Path to a file listing all image names, one per line (for selective uploads; implies --selective)",
        optional: true,
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
        brief:
          "Head repository name, e.g. owner/repo (defaults to the current)",
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
        brief:
          "Base branch/reference (defaults to the merge-base tracking ref)",
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
  async *func(this: SentryContext, flags: UploadFlags, path: string) {
    // Resolve against the command's cwd; the walker requires an absolute path.
    const dir = resolve(this.cwd, path);
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory()) {
      throw new ValidationError(`Path is not a directory: ${path}`, "path");
    }

    const resolved = await resolveOrgAndProject({
      cwd: this.cwd,
      usageHint: USAGE_HINT,
    });
    if (!resolved) {
      throw new ContextError("Organization and project", USAGE_HINT);
    }
    const { org, project } = resolved;

    if (
      flags["all-image-file-names"] !== undefined &&
      flags["all-image-file-names-file"] !== undefined
    ) {
      throw new ValidationError(
        "--all-image-file-names and --all-image-file-names-file cannot be used together",
        "all-image-file-names"
      );
    }
    const vcs = collectVcs(flags, this.cwd, this.env);

    const images = await collectImages(dir);
    validateImageSizes(images);

    const { selective, allImageNames } = await resolveSelective(flags, images);
    // A complete name list makes zero uploaded images a valid all-unchanged run.
    if (images.length === 0 && allImageNames === undefined) {
      yield new CommandOutput<SnapshotUploadResult>({
        imagesFound: 0,
        uploaded: 0,
        skipped: 0,
        snapshot: null,
      });
      return { hint: "No image files found." };
    }

    let uploadResult: UploadImagesResult = {
      entries: {},
      uploaded: 0,
      skipped: 0,
    };
    if (images.length > 0) {
      log.info(`Uploading ${images.length} image(s)...`);
      uploadResult = await uploadImages(org, project, images);
    }
    const { entries, uploaded, skipped } = uploadResult;

    const manifest = buildManifest({
      appId: flags["app-id"],
      entries,
      diffThreshold: flags["diff-threshold"],
      selective,
      allImageNames,
      vcs,
    });
    const snapshot = await createPreprodSnapshot(org, project, manifest);

    yield new CommandOutput<SnapshotUploadResult>({
      imagesFound: images.length,
      uploaded,
      skipped,
      snapshot,
    });
    return {
      hint: snapshot.snapshotUrl
        ? `View your snapshot at ${snapshot.snapshotUrl}`
        : "View your snapshot in Sentry.",
    };
  },
});
