/**
 * sentry snapshots download
 *
 * Download baseline snapshot images from Sentry's preprod system to a local
 * directory. Resolve a snapshot by `--snapshot-id`, or the latest baseline for
 * an app via `--app-id` (optionally filtered by `--branch`). Ensures the
 * downloadable archive is built (triggering + polling if needed), then extracts
 * the images.
 *
 * Org-scoped. Sentry SaaS only.
 */

import { resolve } from "node:path";
import type { SentryContext } from "../../context.js";
import {
  getLatestBaseSnapshot,
  openSnapshotArchive,
  waitForSnapshotArchive,
} from "../../lib/api/preprod-artifacts.js";
import { buildCommand } from "../../lib/command.js";
import { getDefaultProject } from "../../lib/db/defaults.js";
import {
  ApiError,
  ContextError,
  ResolutionError,
  ValidationError,
} from "../../lib/errors.js";
import { mdKvTable, renderMarkdown } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";
import { resolveOrg } from "../../lib/resolve-target.js";
import { extractZipStream } from "../../lib/snapshots/archive.js";

const log = logger.withTag("snapshots.download");

const USAGE_HINT =
  "sentry snapshots download --app-id <app> | --snapshot-id <id>";
const DEFAULT_OUTPUT = "./snapshots-base/";

/** Flags accepted by `snapshots download`. */
type DownloadFlags = {
  "app-id"?: string;
  "snapshot-id"?: string;
  branch?: string;
  output?: string;
};

/** Structured result for `snapshots download`. */
type SnapshotDownloadResult = {
  /** Organization slug. */
  org: string;
  /** The resolved snapshot artifact ID. */
  snapshotId: string;
  /** Local directory the images were extracted to. */
  output: string;
  /** Number of images extracted. */
  imageCount: number;
};

/** Human-readable formatter for the download result. */
function formatDownloadResult(data: SnapshotDownloadResult): string {
  return renderMarkdown(
    mdKvTable([
      ["Snapshot ID", data.snapshotId],
      ["Images", String(data.imageCount)],
      ["Saved to", data.output],
    ])
  );
}

/**
 * Validate the mutually exclusive `--snapshot-id` / `--app-id` flags (and
 * `--branch`'s dependency on `--app-id`) before any I/O.
 *
 * @throws {ValidationError} On conflicting/misused flags.
 * @throws {ContextError} When neither ID flag is provided.
 */
function validateSnapshotFlags(flags: DownloadFlags): void {
  const appId = flags["app-id"];
  const snapshotId = flags["snapshot-id"];

  if (appId && snapshotId) {
    throw new ValidationError(
      "Provide only one of --app-id or --snapshot-id",
      "app-id"
    );
  }
  if (flags.branch && !appId) {
    throw new ValidationError(
      "--branch can only be used with --app-id",
      "branch"
    );
  }
  if (!(appId || snapshotId)) {
    throw new ContextError("Snapshot", USAGE_HINT, []);
  }
}

/**
 * Resolve the optional project (for `--app-id` with org auth tokens) from
 * `SENTRY_PROJECT` (honoring `<org>/<project>` combo notation) then the
 * configured default project.
 */
function resolveOptionalProject(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.SENTRY_PROJECT?.trim();
  if (raw) {
    const parts = raw.split("/");
    return parts.length === 2 ? parts[1] : raw;
  }
  return getDefaultProject() ?? undefined;
}

/**
 * Resolve the snapshot ID to download. Assumes {@link validateSnapshotFlags}
 * has run, so exactly one of `--snapshot-id` / `--app-id` is set.
 */
async function resolveSnapshotId(
  org: string,
  flags: DownloadFlags,
  project: string | undefined
): Promise<string> {
  const snapshotId = flags["snapshot-id"];
  if (snapshotId) {
    return snapshotId;
  }

  const appId = flags["app-id"] as string;
  log.info(`Resolving latest baseline snapshot for app '${appId}'...`);
  const latest = await getLatestBaseSnapshot(org, appId, {
    branch: flags.branch,
    project,
  });
  if (!latest) {
    const branchMsg = flags.branch ? ` on branch '${flags.branch}'` : "";
    throw new ResolutionError(
      `Baseline snapshot for app '${appId}'${branchMsg}`,
      "not found",
      USAGE_HINT,
      ["No baseline snapshot exists for this app yet."]
    );
  }
  log.info(
    `Found snapshot ${latest.headArtifactId} (${latest.imageCount} images)`
  );
  return latest.headArtifactId;
}

export const downloadCommand = buildCommand({
  docs: {
    brief: "Download baseline snapshot images",
    fullDescription:
      "Download baseline snapshot images from Sentry's preprod system to a " +
      "local directory.\n\n" +
      "Use --snapshot-id to download a specific snapshot, or --app-id to " +
      "resolve the latest baseline (org auth tokens require --project with a " +
      "project ID or slug for --app-id).\n\n" +
      "This feature only works with Sentry SaaS.\n\n" +
      "Usage:\n" +
      "  sentry snapshots download --snapshot-id 1234567890\n" +
      "  sentry snapshots download --app-id my-app --branch main\n" +
      "  sentry snapshots download --app-id my-app --output ./baseline/",
  },
  output: {
    human: formatDownloadResult,
  },
  parameters: {
    flags: {
      "app-id": {
        kind: "parsed",
        parse: String,
        brief:
          "App identifier (e.g. my-app) to resolve the latest baseline; mutually exclusive with --snapshot-id",
        optional: true,
      },
      "snapshot-id": {
        kind: "parsed",
        parse: String,
        brief: "Direct snapshot artifact ID; mutually exclusive with --app-id",
        optional: true,
      },
      branch: {
        kind: "parsed",
        parse: String,
        brief: "Git branch filter (only with --app-id)",
        optional: true,
      },
      output: {
        kind: "parsed",
        parse: String,
        brief: `Directory for extracted images (default: ${DEFAULT_OUTPUT})`,
        optional: true,
      },
    },
    aliases: {
      o: "output",
    },
  },
  async *func(this: SentryContext, flags: DownloadFlags) {
    // Validate flag combinations before any I/O so bad usage fails fast.
    validateSnapshotFlags(flags);

    const resolved = await resolveOrg({ cwd: this.cwd });
    if (!resolved) {
      throw new ContextError("Organization", USAGE_HINT);
    }
    const { org } = resolved;
    const project = resolveOptionalProject(this.env);

    const snapshotId = await resolveSnapshotId(org, flags, project);

    await waitForSnapshotArchive(org, snapshotId, () =>
      log.info("Building snapshot archive...")
    );

    log.info(`Downloading snapshot ${snapshotId}...`);
    const response = await openSnapshotArchive(org, snapshotId);
    if (!response.body) {
      throw new ApiError(
        "Snapshot archive response had no body",
        response.status,
        "Empty response body",
        `snapshots/${snapshotId}/archive/`
      );
    }

    const output = resolve(this.cwd, flags.output ?? DEFAULT_OUTPUT);
    const imageCount = await extractZipStream(
      response.body as unknown as AsyncIterable<Uint8Array>,
      output
    );
    if (imageCount === 0) {
      log.warn(
        `No images were extracted from snapshot ${snapshotId} — the archive may be empty or corrupt.`
      );
    }

    yield new CommandOutput<SnapshotDownloadResult>({
      org,
      snapshotId,
      output,
      imageCount,
    });
    return {
      hint: `Downloaded ${imageCount} image(s) from snapshot ${snapshotId} to ${output}`,
    };
  },
});
