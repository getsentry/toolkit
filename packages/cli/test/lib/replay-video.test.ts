/**
 * Tests for mobile replay video helpers.
 *
 * The join test runs the real ffmpeg on generated clips, and is skipped where
 * ffmpeg is not installed.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildConcatList,
  extractVideoClips,
  ffmpegConcatArgs,
  joinClips,
  outputFrameSize,
  type ReplayVideoClip,
} from "../../src/lib/replay-video.js";
import { whichSync } from "../../src/lib/which.js";

const T0 = 1_787_282_938_000;

function videoEvent(payload: Record<string, unknown>, timestamp = T0) {
  return { type: 5, timestamp, data: { tag: "video", payload } };
}

function clip(overrides: Partial<ReplayVideoClip> = {}): ReplayVideoClip {
  return {
    segmentId: 0,
    timestampMs: T0,
    durationMs: 5000,
    width: 540,
    height: 960,
    ...overrides,
  };
}

describe("extractVideoClips", () => {
  test("reads clips in playback order, once per segment", () => {
    const clips = extractVideoClips([
      videoEvent({ segmentId: 1, duration: 5000 }, T0 + 5000),
      { type: 5, timestamp: T0, data: { tag: "breadcrumb", payload: {} } },
      videoEvent({ segmentId: 0, duration: 4000, width: 540, height: 960 }),
      videoEvent({ segmentId: 1, duration: 5000 }, T0 + 6000),
    ]);

    expect(clips).toEqual([
      {
        segmentId: 0,
        timestampMs: T0,
        durationMs: 4000,
        width: 540,
        height: 960,
      },
      { segmentId: 1, timestampMs: T0 + 5000, durationMs: 5000 },
    ]);
  });

  test("skips clips without a duration or segment ID", () => {
    expect(
      extractVideoClips([
        videoEvent({ segmentId: 0, duration: 0 }),
        videoEvent({ segmentId: 1 }),
        videoEvent({ duration: 5000 }),
        { type: 4, timestamp: T0, data: { tag: "video" } },
      ]),
    ).toEqual([]);
  });
});

describe("buildConcatList", () => {
  test("holds each clip until the next one starts", () => {
    const list = buildConcatList([
      { clip: clip(), file: "clip-00000.mp4" },
      {
        clip: clip({ segmentId: 1, timestampMs: T0 + 5000 }),
        file: "clip-00001.mp4",
      },
      {
        clip: clip({
          segmentId: 2,
          timestampMs: T0 + 62_500,
          durationMs: 2500,
        }),
        file: "clip-00002.mp4",
      },
    ]);

    expect(list).toBe(
      [
        "ffconcat version 1.0",
        "file clip-00000.mp4",
        "duration 5.000",
        "file clip-00001.mp4",
        "duration 57.500",
        "file clip-00002.mp4",
        "duration 2.500",
        "",
      ].join("\n"),
    );
  });
});

describe("outputFrameSize", () => {
  test("is null when every clip has one size", () => {
    expect(
      outputFrameSize([clip(), clip({ width: undefined, height: undefined })]),
    ).toBeNull();
  });

  test("letterboxes rotated clips into the largest even frame", () => {
    expect(
      outputFrameSize([clip(), clip({ width: 961, height: 539 })]),
    ).toEqual({ width: 962, height: 960 });
  });
});

describe("ffmpegConcatArgs", () => {
  test("copies streams when no scaling is needed", () => {
    expect(ffmpegConcatArgs("list.txt", "out.mp4", null)).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "concat",
      "-i",
      "list.txt",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "out.mp4",
    ]);
  });

  test("re-encodes into one frame size", () => {
    const args = ffmpegConcatArgs("list.txt", "out.mp4", {
      width: 960,
      height: 960,
    });
    expect(args).toContain("libx264");
    expect(args[args.indexOf("-vf") + 1]).toBe(
      "scale=960:960:force_original_aspect_ratio=decrease," +
        "pad=960:960:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p",
    );
  });
});

const ffmpeg = whichSync("ffmpeg");

describe.skipIf(!ffmpeg)("joinClips with ffmpeg", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "replay-video-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeClip(file: string, size: string) {
    execFileSync(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=${size}:rate=1:duration=2`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      join(dir, file),
    ]);
  }

  test("joins clips of different sizes into one mp4", async () => {
    makeClip("clip-00000.mp4", "540x960");
    makeClip("clip-00001.mp4", "960x540");
    const first = clip({ durationMs: 2000 });
    const second = clip({
      segmentId: 1,
      timestampMs: T0 + 4000,
      durationMs: 2000,
      width: 960,
      height: 540,
    });
    const listPath = join(dir, "clips.txt");
    await writeFile(
      listPath,
      buildConcatList([
        { clip: first, file: "clip-00000.mp4" },
        { clip: second, file: "clip-00001.mp4" },
      ]),
    );
    const outputPath = join(dir, "out.mp4");

    await joinClips({
      ffmpeg: ffmpeg as string,
      listPath,
      outputPath,
      clips: [first, second],
    });

    expect((await stat(outputPath)).size).toBeGreaterThan(0);
  });
});
