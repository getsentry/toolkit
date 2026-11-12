/**
 * Mobile replay video
 *
 * Mobile SDKs record the screen as one mp4 clip per recording segment and
 * describe each clip with a `video` custom event in that segment. This module
 * reads those events and joins downloaded clips into one mp4 with ffmpeg.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RRWebEvent } from "./replay-rrweb.js";

const execFileAsync = promisify(execFile);

/** rrweb `EventType.Custom`, which Sentry's `video` events use. */
const EVENT_TYPE_CUSTOM = 5;

/** One segment's screen recording, from its `video` custom event. */
export type ReplayVideoClip = {
  /** Recording segment the clip belongs to; its video endpoint's ID. */
  segmentId: number;
  /** When the clip starts, in epoch milliseconds. */
  timestampMs: number;
  /** Clip length in milliseconds. */
  durationMs: number;
  /** Frame size in pixels, when the SDK reported it. */
  width?: number;
  height?: number;
};

/** A downloaded clip and its file name, relative to the concat list. */
export type ReplayVideoClipFile = {
  clip: ReplayVideoClip;
  file: string;
};

/**
 * Read the video clips described by a replay's recording events.
 *
 * Mobile SDKs emit `{ type: 5, timestamp, data: { tag: "video", payload } }`
 * per segment, with `payload.segmentId` and `payload.duration` (ms). Like the
 * Sentry replay player, clips with no duration are skipped. Returns clips in
 * playback order; web replays have none.
 */
export function extractVideoClips(events: RRWebEvent[]): ReplayVideoClip[] {
  const clips = new Map<number, ReplayVideoClip>();
  for (const event of events) {
    const clip = parseVideoEvent(event);
    if (clip && !clips.has(clip.segmentId)) {
      clips.set(clip.segmentId, clip);
    }
  }
  return [...clips.values()].sort((a, b) => a.timestampMs - b.timestampMs);
}

/** File name for a downloaded clip, sortable in playback order. */
export function clipFileName(index: number): string {
  return `clip-${String(index).padStart(5, "0")}.mp4`;
}

/**
 * Build an ffmpeg concat demuxer list for the clips.
 *
 * Each clip lasts until the next one starts, so gaps in the recording (such as
 * the app in the background) hold the last frame, as the Sentry player does,
 * and the video's timeline matches the replay's.
 */
export function buildConcatList(files: ReplayVideoClipFile[]): string {
  const lines: string[] = ["ffconcat version 1.0"];
  files.forEach(({ clip, file }, index) => {
    const next = files[index + 1]?.clip;
    const durationMs = next
      ? Math.max(clip.durationMs, next.timestampMs - clip.timestampMs)
      : clip.durationMs;
    lines.push(`file ${file}`, `duration ${(durationMs / 1000).toFixed(3)}`);
  });
  return `${lines.join("\n")}\n`;
}

/**
 * The frame size to scale every clip to, or `null` when the clips share one
 * size and can be joined without re-encoding.
 *
 * Android starts a new segment when the screen rotates, so clips in one
 * replay can differ in size. Those are letterboxed into the largest width and
 * height, rounded up to even numbers for the H.264 encoder.
 */
export function outputFrameSize(
  clips: ReplayVideoClip[],
): { width: number; height: number } | null {
  const sized = clips.filter(
    (clip) => clip.width !== undefined && clip.height !== undefined,
  );
  const sizes = new Set(sized.map((clip) => `${clip.width}x${clip.height}`));
  if (sizes.size <= 1) {
    return null;
  }
  const evenUp = (value: number) => Math.ceil(value / 2) * 2;
  return {
    width: evenUp(Math.max(...sized.map((clip) => clip.width ?? 0))),
    height: evenUp(Math.max(...sized.map((clip) => clip.height ?? 0))),
  };
}

/** ffmpeg arguments that join the clips in `listPath` into `outputPath`. */
export function ffmpegConcatArgs(
  listPath: string,
  outputPath: string,
  frameSize: { width: number; height: number } | null,
): string[] {
  const input = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    "-i",
    listPath,
  ];
  if (!frameSize) {
    return [...input, "-c", "copy", "-movflags", "+faststart", outputPath];
  }
  const { width, height } = frameSize;
  return [
    ...input,
    "-vf",
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-an",
    "-movflags",
    "+faststart",
    outputPath,
  ];
}

/**
 * Join downloaded clips into one mp4 with the given ffmpeg binary.
 *
 * @throws {Error} When ffmpeg exits with an error; the message carries its stderr.
 */
export async function joinClips(options: {
  ffmpeg: string;
  listPath: string;
  outputPath: string;
  clips: ReplayVideoClip[];
}): Promise<void> {
  const { ffmpeg, listPath, outputPath, clips } = options;
  await execFileAsync(
    ffmpeg,
    ffmpegConcatArgs(listPath, outputPath, outputFrameSize(clips)),
    { maxBuffer: 10 * 1024 * 1024 },
  );
}

function parseVideoEvent(event: RRWebEvent): ReplayVideoClip | null {
  if (event.type !== EVENT_TYPE_CUSTOM) {
    return null;
  }
  const data = asRecord(event.data);
  if (data?.tag !== "video") {
    return null;
  }
  const payload = asRecord(data.payload);
  const segmentId = payload?.segmentId;
  const durationMs = payload?.duration;
  const { timestamp } = event;
  if (
    !(Number.isInteger(segmentId) && typeof segmentId === "number") ||
    segmentId < 0 ||
    typeof durationMs !== "number" ||
    !(durationMs > 0) ||
    typeof timestamp !== "number"
  ) {
    return null;
  }
  const width = positiveInteger(payload?.width);
  const height = positiveInteger(payload?.height);
  return {
    segmentId,
    timestampMs: timestamp,
    durationMs,
    ...(width !== undefined && height !== undefined ? { width, height } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}
