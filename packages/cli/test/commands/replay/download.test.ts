/**
 * Tests for `sentry replay download`.
 *
 * Drives the command via its wrapper `loader()`. Org resolution and the
 * replay API are spied; the rrweb file is written for real into a temp cwd.
 * For mobile replays, the ffmpeg lookup and the ffmpeg join are spied.
 */

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArgumentParseError } from "@stricli/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { downloadCommand } from "../../../src/commands/replay/download.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";
import {
  ApiError,
  ContextError,
  ResolutionError,
} from "../../../src/lib/errors.js";

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";

vi.mock("../../../src/lib/which.js", () => ({ whichSync: vi.fn() }));

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as which from "../../../src/lib/which.js";

vi.mock("../../../src/lib/replay-video.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/replay-video.js")>();
  return { ...actual, joinClips: vi.fn(actual.joinClips) };
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as replayVideo from "../../../src/lib/replay-video.js";
import type { ReplayDetails } from "../../../src/types/index.js";

const REPLAY_ID = "346789a703f6454384f1de473b8b9fcc";
const T0 = 1_787_282_938_000;

const SEGMENTS = [
  [
    { type: 4, data: { href: "/", width: 800, height: 600 }, timestamp: T0 },
    { type: 2, data: { node: {} }, timestamp: T0 + 1 },
    { type: 3, data: { source: 1 }, timestamp: T0 + 3000 },
    { type: 5, data: { tag: "breadcrumb" }, timestamp: T0 + 1000 },
  ],
  [{ type: 3, data: { source: 1 }, timestamp: T0 + 5000 }],
];

/** A mobile recording: one 5 s clip per segment, 15 s apart. */
const VIDEO_SEGMENTS = [
  [
    videoEvent(0, T0),
    { type: 5, data: { tag: "breadcrumb" }, timestamp: T0 + 100 },
  ],
  [videoEvent(1, T0 + 15_000)],
];

function videoEvent(segmentId: number, timestamp: number) {
  return {
    type: 5,
    timestamp,
    data: {
      tag: "video",
      payload: {
        segmentId,
        duration: 5000,
        width: 540,
        height: 960,
        container: "mp4",
        encoding: "h264",
      },
    },
  };
}

function sampleReplay(overrides: Partial<ReplayDetails> = {}): ReplayDetails {
  return {
    id: REPLAY_ID,
    count_errors: 0,
    count_segments: 2,
    duration: 5,
    error_ids: [],
    info_ids: [],
    started_at: "2025-01-30T14:32:15+00:00",
    tags: {},
    project_id: "42",
    trace_ids: [],
    urls: [],
    user: { display_name: "Test User" },
    warning_ids: [],
    ...overrides,
  };
}

let tmpDir: string;

function createContext() {
  const writes: string[] = [];
  const errors: string[] = [];
  const collect = (sink: string[]) => (data: string | Uint8Array) => {
    sink.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    return true;
  };
  return {
    context: {
      stdout: { write: collect(writes) },
      stderr: { write: collect(errors) },
      cwd: tmpDir,
      env: {} as NodeJS.ProcessEnv,
      process: { ...process, exitCode: undefined } as typeof process,
    },
    output: () => writes.join(""),
  };
}

async function readEvents(path: string): Promise<{ type: number }[]> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("replay download", () => {
  let resolveReplaySpy: ReturnType<typeof vi.spyOn>;
  let segmentsSpy: ReturnType<typeof vi.spyOn>;
  let resolveTargetSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // The module-level vi.fn wrappers keep call history across tests
    vi.clearAllMocks();
    tmpDir = await mkdtemp(join(tmpdir(), "replay-dl-"));
    resolveTargetSpy = vi
      .spyOn(resolveTarget, "resolveOrgOptionalTarget")
      .mockResolvedValue({ org: "test-org" });
    resolveReplaySpy = vi
      .spyOn(apiClient, "resolveReplay")
      .mockResolvedValue(sampleReplay());
    segmentsSpy = vi
      .spyOn(apiClient, "getReplayRecordingSegments")
      .mockResolvedValue(SEGMENTS);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("writes a flat rrweb array to <replay-id>.rrweb.json in cwd", async () => {
    const harness = createContext();
    const func = await downloadCommand.loader();

    await func.call(harness.context, { fresh: false }, REPLAY_ID);

    const output = join(tmpDir, `${REPLAY_ID}.rrweb.json`);
    const events = await readEvents(output);
    expect(events.map((event) => event.type)).toEqual([4, 2, 5, 3, 3]);

    expect(harness.output()).toContain(REPLAY_ID);
    expect(harness.output()).toContain(output);
  });

  test("fetches every segment from the replay's own project", async () => {
    const func = await downloadCommand.loader();

    await func.call(createContext().context, { fresh: false }, REPLAY_ID);

    // No expectedSegments hint: a stale count must not truncate the download
    expect(segmentsSpy).toHaveBeenCalledWith("test-org", "42", REPLAY_ID);
  });

  test("writes to --output, creating parent directories", async () => {
    const func = await downloadCommand.loader();

    await func.call(
      createContext().context,
      { fresh: false, output: "nested/dir/replay.json" },
      REPLAY_ID,
    );

    const events = await readEvents(join(tmpDir, "nested/dir/replay.json"));
    expect(events).toHaveLength(5);
  });

  test("reports counts with --json", async () => {
    const harness = createContext();
    const func = await downloadCommand.loader();

    await func.call(harness.context, { fresh: false, json: true }, REPLAY_ID);

    expect(JSON.parse(harness.output())).toEqual({
      org: "test-org",
      replayId: REPLAY_ID,
      format: "rrweb",
      output: join(tmpDir, `${REPLAY_ID}.rrweb.json`),
      segmentCount: 2,
      eventCount: 5,
      durationMs: 5000,
    });
  });

  test("accepts a replay URL", async () => {
    const func = await downloadCommand.loader();

    await func.call(
      createContext().context,
      { fresh: false },
      `https://sentry.io/organizations/url-org/explore/replays/${REPLAY_ID}/`,
    );

    expect(resolveTargetSpy).toHaveBeenCalledWith(
      { type: "org-all", org: "url-org" },
      tmpDir,
      "replay download",
    );
  });

  test("still writes a recording without a full snapshot", async () => {
    segmentsSpy.mockResolvedValue([
      [{ type: 5, data: { tag: "breadcrumb" }, timestamp: T0 }],
    ]);
    const func = await downloadCommand.loader();

    await func.call(createContext().context, { fresh: false }, REPLAY_ID);

    const events = await readEvents(join(tmpDir, `${REPLAY_ID}.rrweb.json`));
    expect(events).toHaveLength(1);
  });

  test("rejects an archived replay without fetching segments", async () => {
    resolveReplaySpy.mockResolvedValue(
      sampleReplay({ is_archived: true, project_id: null }),
    );
    const func = await downloadCommand.loader();

    await expect(
      func.call(createContext().context, { fresh: false }, REPLAY_ID),
    ).rejects.toThrow(ResolutionError);
    expect(segmentsSpy).not.toHaveBeenCalled();
  });

  test("rejects a replay outside the named project", async () => {
    resolveTargetSpy.mockResolvedValue({
      org: "test-org",
      project: "other",
      projectData: { id: "7" },
    });
    const func = await downloadCommand.loader();

    await expect(
      func.call(
        createContext().context,
        { fresh: false },
        `test-org/other/${REPLAY_ID}`,
      ),
    ).rejects.toThrow(/is not in project 'other'/);
    expect(segmentsSpy).not.toHaveBeenCalled();
  });

  test("rejects a replay whose recording is empty", async () => {
    segmentsSpy.mockResolvedValue([[], []]);
    const func = await downloadCommand.loader();

    await expect(
      func.call(createContext().context, { fresh: false }, REPLAY_ID),
    ).rejects.toThrow(/has no recording to download/);
    await expect(
      readFile(join(tmpDir, `${REPLAY_ID}.rrweb.json`)),
    ).rejects.toThrow();
  });

  test("maps a 404 to a not-found resolution error", async () => {
    resolveReplaySpy.mockRejectedValue(new ApiError("Not found", 404));
    const func = await downloadCommand.loader();

    await expect(
      func.call(createContext().context, { fresh: false }, REPLAY_ID),
    ).rejects.toThrow(/not found/);
  });

  describe("mobile replays", () => {
    let clipSpy: ReturnType<typeof vi.spyOn>;
    let joinSpy: ReturnType<typeof vi.spyOn>;
    let concatList: string | undefined;

    beforeEach(() => {
      segmentsSpy.mockResolvedValue(VIDEO_SEGMENTS);
      clipSpy = vi
        .spyOn(apiClient, "downloadReplayVideoClip")
        .mockImplementation(async (_org, _project, _replay, segmentId) =>
          new TextEncoder().encode(`clip ${segmentId}`),
        );
      vi.mocked(which.whichSync).mockReturnValue("/usr/bin/ffmpeg");
      concatList = undefined;
      joinSpy = vi
        .spyOn(replayVideo, "joinClips")
        .mockImplementation(async ({ listPath, outputPath }) => {
          concatList = await readFile(listPath, "utf8");
          await writeFile(outputPath, "joined");
        });
    });

    test("joins the clips into <replay-id>.mp4 with ffmpeg", async () => {
      const harness = createContext();
      const func = await downloadCommand.loader();

      await func.call(harness.context, { fresh: false, json: true }, REPLAY_ID);

      const output = join(tmpDir, `${REPLAY_ID}.mp4`);
      expect(await readFile(output, "utf8")).toBe("joined");
      expect(clipSpy).toHaveBeenCalledWith("test-org", "42", REPLAY_ID, 0);
      expect(clipSpy).toHaveBeenCalledWith("test-org", "42", REPLAY_ID, 1);
      expect(joinSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          ffmpeg: "/usr/bin/ffmpeg",
          outputPath: output,
        }),
      );
      // The first clip holds its last frame until the second starts
      expect(concatList).toContain("file clip-00000.mp4\nduration 15.000");
      expect(concatList).toContain("file clip-00001.mp4\nduration 5.000");
      // The temporary clip directory is removed
      expect(await readdir(tmpDir)).toEqual([`${REPLAY_ID}.mp4`]);
      expect(JSON.parse(harness.output())).toEqual({
        org: "test-org",
        replayId: REPLAY_ID,
        format: "mp4",
        output,
        segmentCount: 2,
        eventCount: 3,
        clipCount: 2,
        durationMs: 20_000,
      });
    });

    test("saves the clips in a directory when ffmpeg is missing", async () => {
      vi.mocked(which.whichSync).mockReturnValue(null);
      const harness = createContext();
      const func = await downloadCommand.loader();

      await func.call(harness.context, { fresh: false, json: true }, REPLAY_ID);

      const clipsDir = join(tmpDir, `${REPLAY_ID}-clips`);
      expect((await readdir(clipsDir)).sort()).toEqual([
        "clip-00000.mp4",
        "clip-00001.mp4",
        "clips.txt",
      ]);
      expect(await readFile(join(clipsDir, "clip-00001.mp4"), "utf8")).toBe(
        "clip 1",
      );
      expect(joinSpy).not.toHaveBeenCalled();
      expect(JSON.parse(harness.output())).toMatchObject({
        format: "clips",
        output: clipsDir,
        clipCount: 2,
      });
    });

    test("keeps the clips when ffmpeg fails", async () => {
      joinSpy.mockRejectedValue(
        Object.assign(new Error("Command failed"), {
          stderr: "clip-00001.mp4: Invalid data found when processing input\n",
        }),
      );
      const func = await downloadCommand.loader();

      await expect(
        func.call(createContext().context, { fresh: false }, REPLAY_ID),
      ).rejects.toThrow(/ffmpeg could not join.*Invalid data found/s);

      expect(await readdir(tmpDir)).toEqual([`${REPLAY_ID}-clips`]);
    });

    test("replaces clips from an earlier run", async () => {
      const clipsDir = join(tmpDir, `${REPLAY_ID}-clips`);
      await mkdir(clipsDir);
      await writeFile(join(clipsDir, "clip-00009.mp4"), "stale");
      joinSpy.mockRejectedValue(new Error("Command failed"));
      const func = await downloadCommand.loader();

      await expect(
        func.call(createContext().context, { fresh: false }, REPLAY_ID),
      ).rejects.toThrow(/ffmpeg could not join/);

      expect(await readdir(tmpDir)).toEqual([`${REPLAY_ID}-clips`]);
      expect((await readdir(clipsDir)).sort()).toEqual([
        "clip-00000.mp4",
        "clip-00001.mp4",
        "clips.txt",
      ]);

      vi.mocked(which.whichSync).mockReturnValue(null);
      await writeFile(join(clipsDir, "clip-00009.mp4"), "stale");
      await func.call(createContext().context, { fresh: false }, REPLAY_ID);

      expect(await readdir(clipsDir)).not.toContain("clip-00009.mp4");
    });

    test("skips clips with no stored video", async () => {
      clipSpy.mockImplementation(async (_org, _project, _replay, segmentId) => {
        if (segmentId === 1) {
          throw new ApiError("Not found", 404);
        }
        return new TextEncoder().encode("clip 0");
      });
      const harness = createContext();
      const func = await downloadCommand.loader();

      await func.call(harness.context, { fresh: false, json: true }, REPLAY_ID);

      expect(concatList).toBe(
        "ffconcat version 1.0\nfile clip-00000.mp4\nduration 5.000\n",
      );
      expect(JSON.parse(harness.output())).toMatchObject({ clipCount: 1 });
    });

    test("keeps clips from an earlier run when a rerun fails", async () => {
      vi.mocked(which.whichSync).mockReturnValue(null);
      const clipsDir = join(tmpDir, `${REPLAY_ID}-clips`);
      await mkdir(clipsDir);
      await writeFile(join(clipsDir, "clip-00000.mp4"), "earlier");
      clipSpy.mockRejectedValue(new ApiError("Server error", 500));
      const func = await downloadCommand.loader();

      await expect(
        func.call(createContext().context, { fresh: false }, REPLAY_ID),
      ).rejects.toThrow(ApiError);

      expect(await readdir(tmpDir)).toEqual([`${REPLAY_ID}-clips`]);
      expect(await readFile(join(clipsDir, "clip-00000.mp4"), "utf8")).toBe(
        "earlier",
      );
    });

    test("rejects a replay whose clips are all missing", async () => {
      clipSpy.mockRejectedValue(new ApiError("Not found", 404));
      const func = await downloadCommand.loader();

      await expect(
        func.call(createContext().context, { fresh: false }, REPLAY_ID),
      ).rejects.toThrow(/has no recording to download/);
      expect(await readdir(tmpDir)).toEqual([]);
    });
  });

  test("shows its own usage when the replay ID is missing", async () => {
    const func = await downloadCommand.loader();

    const error = await func
      .call(createContext().context, { fresh: false })
      .catch((caught: unknown) => caught);

    // An argument error, as the CLI reports it, wrapping the parser's error
    expect(error).toBeInstanceOf(ArgumentParseError);
    const { exception } = error as ArgumentParseError;
    expect(exception).toBeInstanceOf(ContextError);
    expect((exception as ContextError).message).toContain(
      "sentry replay download",
    );
  });
});
