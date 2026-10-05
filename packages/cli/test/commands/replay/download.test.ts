/**
 * Tests for `sentry replay download`.
 *
 * Drives the command via its wrapper `loader()`. Org resolution and the
 * replay API are spied; the rrweb file is written for real into a temp cwd.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { downloadCommand } from "../../../src/commands/replay/download.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
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
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";
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
      .spyOn(resolveTarget, "resolveOrgOptionalFromArg")
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
      REPLAY_ID
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
      `https://sentry.io/organizations/url-org/explore/replays/${REPLAY_ID}/`
    );

    expect(resolveTargetSpy).toHaveBeenCalledWith(
      "url-org/",
      tmpDir,
      "replay download"
    );
  });

  test("still writes a recording without a full snapshot", async () => {
    segmentsSpy.mockResolvedValue([
      [{ type: 5, data: { tag: "video" }, timestamp: T0 }],
    ]);
    const func = await downloadCommand.loader();

    await func.call(createContext().context, { fresh: false }, REPLAY_ID);

    const events = await readEvents(join(tmpDir, `${REPLAY_ID}.rrweb.json`));
    expect(events).toHaveLength(1);
  });

  test("rejects an archived replay without fetching segments", async () => {
    resolveReplaySpy.mockResolvedValue(
      sampleReplay({ is_archived: true, project_id: null })
    );
    const func = await downloadCommand.loader();

    await expect(
      func.call(createContext().context, { fresh: false }, REPLAY_ID)
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
        `test-org/other/${REPLAY_ID}`
      )
    ).rejects.toThrow(/is not in project 'other'/);
    expect(segmentsSpy).not.toHaveBeenCalled();
  });

  test("rejects a replay whose recording is empty", async () => {
    segmentsSpy.mockResolvedValue([[], []]);
    const func = await downloadCommand.loader();

    await expect(
      func.call(createContext().context, { fresh: false }, REPLAY_ID)
    ).rejects.toThrow(/has no recording to download/);
    await expect(
      readFile(join(tmpDir, `${REPLAY_ID}.rrweb.json`))
    ).rejects.toThrow();
  });

  test("maps a 404 to a not-found resolution error", async () => {
    resolveReplaySpy.mockRejectedValue(new ApiError("Not found", 404));
    const func = await downloadCommand.loader();

    await expect(
      func.call(createContext().context, { fresh: false }, REPLAY_ID)
    ).rejects.toThrow(/not found/);
  });

  test("shows its own usage when the replay ID is missing", async () => {
    const func = await downloadCommand.loader();

    const error = await func
      .call(createContext().context, { fresh: false })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ContextError);
    expect((error as ContextError).message).toContain("sentry replay download");
  });
});
