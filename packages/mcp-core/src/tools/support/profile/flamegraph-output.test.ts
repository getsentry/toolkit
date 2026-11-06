import { describe, expect, it } from "vitest";
import type { Flamegraph } from "../../../api-client/types";
import {
  buildFlamegraphAnalysis,
  buildFlamegraphComparison,
} from "./flamegraph-output";

/**
 * Mock flamegraph fixture for testing formatters.
 */
function createMockFlamegraph(overrides: Partial<Flamegraph> = {}): Flamegraph {
  return {
    activeProfileIndex: 0,
    platform: "python",
    projectID: 123,
    transactionName: "/api/users",
    profiles: [
      {
        endValue: 100,
        isMainThread: true,
        name: "main",
        samples: [
          [0, 1, 2],
          [0, 1],
        ],
        sample_counts: [50, 30],
        sample_durations_ns: [100_000_000, 60_000_000],
        weights: [100, 60],
        startValue: 0,
        threadID: "main",
        type: "sampled",
        unit: "nanoseconds",
      },
    ],
    shared: {
      frames: [
        {
          file: "main.py",
          name: "handle_request",
          line: 10,
          is_application: true,
          fingerprint: 1001,
        },
        {
          file: "utils.py",
          name: "fetch_data",
          line: 25,
          is_application: true,
          fingerprint: 1002,
        },
        {
          file: "psycopg2/pool.py",
          name: "execute",
          line: 100,
          is_application: false,
          fingerprint: 1003,
        },
      ],
      frame_infos: [
        {
          count: 80,
          weight: 160,
          sumDuration: 160_000_000,
          sumSelfTime: 0,
          p75Duration: 50_000_000,
          p95Duration: 80_000_000,
          p99Duration: 120_000_000,
        },
        {
          count: 80,
          weight: 160,
          sumDuration: 160_000_000,
          sumSelfTime: 20_000_000,
          p75Duration: 40_000_000,
          p95Duration: 70_000_000,
          p99Duration: 100_000_000,
        },
        {
          count: 50,
          weight: 100,
          sumDuration: 100_000_000,
          sumSelfTime: 100_000_000,
          p75Duration: 50_000_000,
          p95Duration: 90_000_000,
          p99Duration: 200_000_000,
        },
      ],
      profiles: [
        {
          profile_id: "profile-abc123",
          transaction_id: "txn-456",
          timestamp: Date.now(),
        },
      ],
    },
    ...overrides,
  } as Flamegraph;
}

describe("buildFlamegraphAnalysis", () => {
  it("references shared frames by index from top functions and hot paths", () => {
    const analysis = buildFlamegraphAnalysis(createMockFlamegraph(), {
      focusOnUserCode: true,
      maxHotPaths: 5,
    });

    expect(analysis.frames.map((frame) => frame.name)).toEqual([
      "handle_request",
      "fetch_data",
      "execute",
    ]);
    expect(analysis.topFunctions).toEqual([0, 1]);
    expect(analysis.hotPaths).toEqual([
      { percentOfSamples: 62.5, sampleCount: 50, stack: [0, 1], leaf: 2 },
      { percentOfSamples: 37.5, sampleCount: 30, stack: [0, 1], leaf: 1 },
    ]);
  });

  it("splits sampled time by leaf frame so the breakdown adds up to the total", () => {
    const analysis = buildFlamegraphAnalysis(createMockFlamegraph(), {
      focusOnUserCode: true,
      maxHotPaths: 5,
    });

    // [0, 1, 2] ends in library code (100ms); [0, 1] ends in app code (60ms).
    expect(analysis).toMatchObject({
      estimatedTotalMs: 160,
      userCodeMs: 60,
      libraryMs: 100,
      userCodePercent: 37.5,
    });
    expect(analysis.userCodeMs + analysis.libraryMs).toBe(
      analysis.estimatedTotalMs,
    );
  });

  it("maps placeholder file and line values to null", () => {
    const flamegraph = createMockFlamegraph();
    flamegraph.shared.frames[0] = {
      ...flamegraph.shared.frames[0]!,
      file: "",
      line: 0,
    };

    const analysis = buildFlamegraphAnalysis(flamegraph, {
      focusOnUserCode: true,
      maxHotPaths: 5,
    });

    expect(analysis.frames[0]).toMatchObject({
      name: "handle_request",
      file: null,
      line: null,
      occurrences: 80,
    });
  });

  it("keeps library frames in hot path stacks when focusOnUserCode is false", () => {
    const analysis = buildFlamegraphAnalysis(createMockFlamegraph(), {
      focusOnUserCode: false,
      maxHotPaths: 5,
    });

    const [topPath] = analysis.hotPaths;
    expect(topPath?.stack.map((index) => analysis.frames[index]?.file)).toEqual(
      ["main.py", "utils.py", "psycopg2/pool.py"],
    );
    expect(topPath?.stack.at(-1)).toBe(topPath?.leaf);
    expect(analysis.topFunctions).toHaveLength(3);
  });

  it("falls back to thread profiles when shared profile metadata is omitted", () => {
    const flamegraph = createMockFlamegraph();
    flamegraph.shared.profiles = [];

    expect(
      buildFlamegraphAnalysis(flamegraph, {
        focusOnUserCode: true,
        maxHotPaths: 5,
      }).profileCount,
    ).toBe(1);
  });

  it("returns empty hot paths when there are no thread profiles", () => {
    const analysis = buildFlamegraphAnalysis(
      createMockFlamegraph({ profiles: [] }),
      { focusOnUserCode: true, maxHotPaths: 5 },
    );

    expect(analysis.hotPaths).toEqual([]);
    expect(analysis.sampleCount).toBe(0);
  });

  it("handles empty frames", () => {
    const flamegraph = createMockFlamegraph();
    flamegraph.shared.frames = [];
    flamegraph.shared.frame_infos = [];

    const analysis = buildFlamegraphAnalysis(flamegraph, {
      focusOnUserCode: false,
      maxHotPaths: 5,
    });

    expect(analysis.topFunctions).toEqual([]);
    expect(analysis.frames.every((frame) => frame.name === "unknown")).toBe(
      true,
    );
  });
});

describe("buildFlamegraphComparison", () => {
  it("reports no change for identical periods", () => {
    const comparison = buildFlamegraphComparison(
      createMockFlamegraph(),
      createMockFlamegraph(),
      { focusOnUserCode: false },
    );

    expect(comparison.status).toBe("no_change");
    expect(comparison.changes).toHaveLength(3);
  });

  it("detects major regressions", () => {
    const current = createMockFlamegraph();
    // Comparison uses sumDuration, not weight.
    current.shared.frame_infos[0]!.sumDuration = 240_000_000;

    const comparison = buildFlamegraphComparison(
      createMockFlamegraph(),
      current,
      { focusOnUserCode: false },
    );

    expect(comparison.status).toBe("major_regression");
    expect(comparison.changes[0]).toEqual({
      name: "handle_request",
      file: "main.py",
      line: 10,
      isApplication: true,
      baselineMs: 160,
      currentMs: 240,
      percentChange: 50,
      changeType: "major_regression",
    });
  });

  it("maps placeholder file and line values to null in changes", () => {
    const withPlaceholders = () => {
      const flamegraph = createMockFlamegraph();
      flamegraph.shared.frames[0] = {
        ...flamegraph.shared.frames[0]!,
        file: "",
        line: 0,
      };
      return flamegraph;
    };

    const comparison = buildFlamegraphComparison(
      withPlaceholders(),
      withPlaceholders(),
      { focusOnUserCode: false },
    );

    expect(
      comparison.changes.find((change) => change.name === "handle_request"),
    ).toMatchObject({ file: null, line: null });
  });

  it("keeps improvements in changes when many frames are unchanged", () => {
    const withFrames = (improvedDurationNs: number) => {
      const flamegraph = createMockFlamegraph();
      const template = flamegraph.shared.frame_infos[0]!;
      flamegraph.shared.frames = Array.from({ length: 13 }, (_, index) => ({
        file: `module_${index}.py`,
        name: `fn_${index}`,
        line: index + 1,
        is_application: true,
        fingerprint: 2000 + index,
      }));
      flamegraph.shared.frame_infos = flamegraph.shared.frames.map(
        (_, index) => ({
          ...template,
          sumDuration: index === 12 ? improvedDurationNs : 160_000_000,
        }),
      );
      return flamegraph;
    };

    const comparison = buildFlamegraphComparison(
      withFrames(160_000_000),
      withFrames(80_000_000),
      { focusOnUserCode: false },
    );

    expect(comparison.status).toBe("improvement");
    expect(comparison.changes).toHaveLength(10);
    expect(comparison.changes[0]).toMatchObject({
      name: "fn_12",
      changeType: "improvement",
      percentChange: -50,
    });
  });

  it("detects improvements", () => {
    const current = createMockFlamegraph();
    current.shared.frame_infos[0]!.sumDuration = 128_000_000;
    current.shared.frame_infos[1]!.sumDuration = 128_000_000;
    current.shared.frame_infos[2]!.sumDuration = 80_000_000;

    expect(
      buildFlamegraphComparison(createMockFlamegraph(), current, {
        focusOnUserCode: false,
      }).status,
    ).toBe("improvement");
  });
});
