/**
 * sentry replay download
 *
 * Download a Session Replay recording as rrweb JSON: the flat event array
 * that rrweb-player and rrvideo consume. Mobile replays are recorded as
 * video, so they download as one mp4, joined with ffmpeg.
 */

import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import pLimit from "p-limit";
import type { SentryContext } from "../../context.js";
import {
  downloadReplayVideoClip,
  getReplayRecordingSegments,
  resolveReplay,
} from "../../lib/api-client.js";
import { sentry } from "../../lib/app-identity.js";
import { buildCommand } from "../../lib/command.js";
import { parseFilePath } from "../../lib/completion-target.js";
import { ApiError, CliError, ResolutionError } from "../../lib/errors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  formatReplayDownloadResult,
  type ReplayDownloadData,
} from "../../lib/formatters/replay.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import { withProgress } from "../../lib/polling.js";
import {
  hasFullSnapshot,
  rrwebDurationMs,
  toRRWebEvents,
} from "../../lib/replay-rrweb.js";
import {
  buildConcatList,
  clipFileName,
  extractVideoClips,
  joinClips,
  type ReplayVideoClip,
  type ReplayVideoClipFile,
} from "../../lib/replay-video.js";
import { whichSync } from "../../lib/which.js";
import type { ReplayDetails } from "../../types/index.js";
import {
  type ReplayArguments,
  replayArguments,
  validateReplayProjectScope,
} from "./view.js";

type DownloadFlags = {
  readonly output?: string;
  readonly fresh: boolean;
  readonly json?: boolean;
};

/** Parallel clip downloads; mobile replays have one clip per ~5 s. */
const VIDEO_CLIP_CONCURRENCY = 6;

/** Concat list written next to saved clips, for joining them later. */
const CONCAT_LIST_FILE = "clips.txt";

const usageHint = () =>
  sentry`replay download [<org>/<project>/]<replay-id> | <replay-url>`;

const log = logger.withTag("replay.download");

export const downloadCommand = buildCommand({
  docs: {
    brief: "Download a Session Replay as rrweb JSON or mp4 video",
    fullDescription:
      "Download a Session Replay recording as rrweb JSON: a single flat, " +
      "time-ordered array of events that rrweb-player and rrvideo can play.\n\n" +
      "All recorded events are kept, including Sentry's custom events " +
      "(breadcrumbs, performance spans).\n\n" +
      "Mobile replays are recorded as video clips instead, so they download " +
      "as one mp4. Joining the clips needs ffmpeg on your PATH. Gaps in the " +
      "recording, such as time the app spent in the background, hold the " +
      "last frame, so the video's timeline matches the replay's. Without " +
      "ffmpeg, the clips are saved in a <name>-clips directory with a " +
      `${CONCAT_LIST_FILE} list that ffmpeg can join later.\n\n` +
      "ID formats:\n" +
      "  <id>                     - auto-detect org from config or DSN\n" +
      "  <org>/<id>               - explicit organization\n" +
      "  <org>/<project>/<id>     - explicit org/project context\n" +
      "  <replay-url>             - parse org and replay ID from a Sentry URL",
    examples: [
      {
        description:
          "Download a replay as rrweb JSON to ./<replay-id>.rrweb.json",
        run: "replay download my-org/346789a703f6454384f1de473b8b9fcc",
      },
      {
        description:
          "Download a mobile replay as one mp4 to ./<replay-id>.mp4 (needs ffmpeg)",
        run: "replay download my-org/7c5b4a3f2e1d4c6b8a9f0e1d2c3b4a59",
      },
      {
        description: "Choose where the file goes",
        run: "replay download my-org/346789a703f6454384f1de473b8b9fcc --output ./replay.json",
      },
      {
        description: "Download from a replay URL",
        run: "replay download https://sentry.io/organizations/my-org/explore/replays/346789a703f6454384f1de473b8b9fcc/",
      },
    ],
  },
  output: {
    human: formatReplayDownloadResult,
  },
  parameters: {
    positional: replayArguments("download", usageHint),
    flags: {
      output: {
        kind: "parsed",
        parse: parseFilePath,
        brief:
          "Output path (default: <replay-id>.rrweb.json, or <replay-id>.mp4 for mobile replays, in the current directory)",
        optional: true,
      },
      fresh: FRESH_FLAG,
    },
    aliases: { ...FRESH_ALIASES, o: "output" },
  },
  async *func(
    this: SentryContext,
    flags: DownloadFlags,
    target: ReplayArguments,
  ) {
    applyFreshFlag(flags);
    const { cwd } = this;

    const resolved = await target.resolved;
    const { replayId } = resolved;

    let replay: ReplayDetails;
    try {
      replay = await resolveReplay(resolved.org, replayId, {
        projectSlugs: resolved.project ? [resolved.project] : undefined,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        throw new ResolutionError(
          `Replay '${replayId}'`,
          "not found",
          sentry`replay download ${resolved.org}/${replayId}`,
          [
            "Check that you are querying the right organization",
            "The replay may be past your retention window",
          ],
        );
      }
      throw error;
    }

    await validateReplayProjectScope({
      org: resolved.org,
      project: resolved.project,
      expectedProjectId: resolved.projectData?.id,
      replayId,
      replay,
      command: "download",
    });

    if (replay.is_archived || !replay.project_id) {
      throw noRecordingError(resolved.org, replay.id);
    }

    // No expectedSegments hint: follow the cursor to the end so a stale
    // count_segments can't cut the download short.
    const segments = await getReplayRecordingSegments(
      resolved.org,
      String(replay.project_id),
      replay.id,
    );
    const events = toRRWebEvents(segments);
    if (events.length === 0) {
      throw noRecordingError(resolved.org, replay.id);
    }

    const clips = extractVideoClips(events);
    if (clips.length > 0) {
      const result = await downloadVideo({
        org: resolved.org,
        projectId: String(replay.project_id),
        replayId: replay.id,
        clips,
        output: resolve(cwd, flags.output ?? `${replay.id}.mp4`),
        json: flags.json,
        segmentCount: segments.length,
        eventCount: events.length,
      });
      yield new CommandOutput(result);
      return {
        hint:
          result.format === "mp4"
            ? `Downloaded replay ${replay.id} to ${result.output}`
            : `Saved ${result.clipCount} clips of replay ${replay.id} to ${result.output}. Install ffmpeg and rerun to get one mp4.`,
      };
    }

    if (!hasFullSnapshot(events)) {
      log.warn(
        "This recording has no full DOM snapshot, so rrweb players cannot render it.",
      );
    }

    const output = resolve(cwd, flags.output ?? `${replay.id}.rrweb.json`);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(events));

    yield new CommandOutput({
      org: resolved.org,
      replayId: replay.id,
      format: "rrweb" as const,
      output,
      segmentCount: segments.length,
      eventCount: events.length,
      durationMs: rrwebDurationMs(events),
    });
    return { hint: `Downloaded replay ${replay.id} to ${output}` };
  },
});

/** The segments endpoint answers 200 [] for archived or expired recordings. */
function noRecordingError(org: string, replayId: string): ResolutionError {
  return new ResolutionError(
    `Replay '${replayId}'`,
    "has no recording to download",
    sentry`replay view ${org}/${replayId}`,
    ["The replay may be archived or past your retention window"],
  );
}

type DownloadVideoOptions = {
  org: string;
  projectId: string;
  replayId: string;
  clips: ReplayVideoClip[];
  /** Absolute path for the joined mp4. */
  output: string;
  json?: boolean;
  segmentCount: number;
  eventCount: number;
};

/**
 * Download a mobile replay's clips and join them into one mp4 with ffmpeg.
 *
 * Without ffmpeg, the clips and a concat list are saved in `<name>-clips/`
 * next to the output path instead, with a warning.
 *
 * @throws {CliError} When ffmpeg fails; the clips are kept on disk.
 */
async function downloadVideo(
  options: DownloadVideoOptions,
): Promise<ReplayDownloadData> {
  const { output } = options;
  const clipsDir = `${output.slice(0, output.length - extname(output).length)}-clips`;
  const ffmpeg = whichSync("ffmpeg");

  await mkdir(dirname(output), { recursive: true });
  // Download next to the output so the clips can be renamed into place
  // without crossing filesystems. Clips from an earlier run are only
  // replaced once every new clip is on disk.
  const workDir = await mkdtemp(
    join(dirname(output), `.${basename(clipsDir)}-`),
  );
  let files: ReplayVideoClipFile[];
  try {
    files = await saveClips(workDir, options);
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }

  if (!ffmpeg) {
    const kept = await keepClips(workDir, clipsDir);
    const listPath = join(kept, CONCAT_LIST_FILE);
    log.warn(
      `ffmpeg was not found on your PATH, so the ${files.length} video clips were saved separately in ${kept}. ` +
        `Install ffmpeg and rerun to get one mp4, or join them with: ffmpeg -f concat -i ${listPath} -c copy ${output}`,
    );
    return videoResult(options, files, "clips", kept);
  }

  try {
    await joinClips({
      ffmpeg,
      listPath: join(workDir, CONCAT_LIST_FILE),
      outputPath: output,
      clips: files.map((file) => file.clip),
    });
  } catch (error) {
    log.debug("ffmpeg failed to join replay video clips", error);
    const kept = await keepClips(workDir, clipsDir);
    throw new CliError(
      `ffmpeg could not join the replay video clips: ${ffmpegErrorMessage(error)}\n` +
        `The clips are saved in ${kept}.`,
    );
  }
  await rm(workDir, { recursive: true, force: true });
  return videoResult(options, files, "mp4", output);
}

/**
 * Download every clip into `dir` and write the concat list beside them.
 *
 * A clip that 404s (no stored video for that segment) is skipped with a
 * warning, as the replay player shows nothing new for it either.
 */
async function saveClips(
  dir: string,
  options: DownloadVideoOptions,
): Promise<ReplayVideoClipFile[]> {
  const { org, projectId, replayId, clips } = options;
  const limit = pLimit(VIDEO_CLIP_CONCURRENCY);
  const total = clips.length;
  let done = 0;

  const saved = await withProgress(
    { message: `Downloading video clips 0/${total}...`, json: options.json },
    (setMessage) =>
      Promise.all(
        clips.map((clip, index) =>
          limit(async (): Promise<ReplayVideoClipFile | null> => {
            const file = clipFileName(index);
            try {
              const bytes = await downloadReplayVideoClip(
                org,
                projectId,
                replayId,
                clip.segmentId,
              );
              await writeFile(join(dir, file), bytes);
            } catch (error) {
              if (error instanceof ApiError && error.status === 404) {
                log.debug(`No video stored for segment ${clip.segmentId}`);
                return null;
              }
              throw error;
            } finally {
              done += 1;
              setMessage(`Downloading video clips ${done}/${total}...`);
            }
            return { clip, file };
          }),
        ),
      ),
  );

  const files = saved.filter((file) => file !== null);
  if (files.length === 0) {
    throw noRecordingError(org, replayId);
  }
  if (files.length < total) {
    log.warn(
      `${total - files.length} of ${total} video clips had no stored video and were skipped.`,
    );
  }
  await writeFile(join(dir, CONCAT_LIST_FILE), buildConcatList(files));
  return files;
}

/**
 * Move clips out of the temporary directory so the user keeps them, replacing
 * clips from an earlier run.
 */
async function keepClips(workDir: string, clipsDir: string): Promise<string> {
  try {
    await rm(clipsDir, { recursive: true, force: true });
    await rename(workDir, clipsDir);
    return clipsDir;
  } catch (error) {
    log.debug(`Could not rename ${workDir} to ${clipsDir}`, error);
    return workDir;
  }
}

function videoResult(
  options: DownloadVideoOptions,
  files: ReplayVideoClipFile[],
  format: "mp4" | "clips",
  output: string,
): ReplayDownloadData {
  const first = files[0]?.clip;
  const last = files.at(-1)?.clip;
  return {
    org: options.org,
    replayId: options.replayId,
    format,
    output,
    segmentCount: options.segmentCount,
    eventCount: options.eventCount,
    clipCount: files.length,
    durationMs:
      first && last
        ? last.timestampMs + last.durationMs - first.timestampMs
        : 0,
  };
}

/** The useful part of an execFile failure: ffmpeg's stderr, else the error. */
function ffmpegErrorMessage(error: unknown): string {
  const stderr =
    error instanceof Error && "stderr" in error ? error.stderr : undefined;
  if (typeof stderr === "string" && stderr.trim()) {
    return stderr.trim().split("\n").slice(-3).join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}
