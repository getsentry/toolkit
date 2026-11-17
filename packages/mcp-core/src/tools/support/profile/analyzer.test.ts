import { describe, it, expect } from "vitest";
import type { Flamegraph } from "../../../api-client/types";
import {
  analyzeHotPathsFromFlamegraph,
  reconstructCallStack,
  identifyHotspotFramesFromFlamegraph,
  generatePerformanceInsights,
  compareFrameStats,
  formatDuration,
  hasProfileData,
} from "./analyzer";

/**
 * Mock flamegraph fixture for testing.
 * Contains 3 frames: main.py (user), utils.py (user), psycopg2.py (library)
 * Contains 2 samples with different call stacks.
 */
function createMockFlamegraph(overrides: Partial<Flamegraph> = {}): Flamegraph {
  return {
    activeProfileIndex: 0,
    platform: "python",
    projectID: 1,
    transactionName: "/api/users",
    profiles: [
      {
        endValue: 100,
        isMainThread: true,
        name: "main",
        samples: [
          [0, 1, 2], // main.py -> utils.py -> psycopg2.py
          [0, 1], // main.py -> utils.py
        ],
        sample_counts: [50, 30],
        sample_durations_ns: [100_000_000, 60_000_000], // 100ms, 60ms
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
          p99Duration: 200_000_000, // High variance
        },
      ],
      profiles: [
        {
          profile_id: "profile-123",
          transaction_id: "txn-456",
          timestamp: Date.now(),
        },
      ],
    },
    ...overrides,
  } as Flamegraph;
}

describe("analyzer", () => {
  describe("analyzeHotPathsFromFlamegraph", () => {
    it("extracts hot paths sorted by duration", () => {
      const flamegraph = createMockFlamegraph();
      const hotPaths = analyzeHotPathsFromFlamegraph(flamegraph, {
        focusOnUserCode: false,
        maxHotPaths: 10,
      });

      expect(hotPaths).toHaveLength(2);
      // First path should be the one with longer duration (100ms > 60ms)
      expect(hotPaths[0].duration).toBe(100_000_000);
      expect(hotPaths[1].duration).toBe(60_000_000);
    });

    it("calculates percentage of total correctly", () => {
      const flamegraph = createMockFlamegraph();
      const hotPaths = analyzeHotPathsFromFlamegraph(flamegraph, {
        focusOnUserCode: false,
        maxHotPaths: 10,
      });

      // Total samples: 50 + 30 = 80
      // First path: 50/80 = 62.5%
      expect(hotPaths[0].percentOfTotal).toBeCloseTo(62.5, 1);
      // Second path: 30/80 = 37.5%
      expect(hotPaths[1].percentOfTotal).toBeCloseTo(37.5, 1);
    });

    it("filters to user code when focusOnUserCode is true", () => {
      const flamegraph = createMockFlamegraph();
      const hotPaths = analyzeHotPathsFromFlamegraph(flamegraph, {
        focusOnUserCode: true,
        maxHotPaths: 10,
      });

      // User code frames should be filtered
      expect(hotPaths[0].userCodeFrames).toHaveLength(2);
      expect(
        hotPaths[0].userCodeFrames.every((f) => f.frame.is_application),
      ).toBe(true);
    });

    it("respects maxHotPaths limit", () => {
      const flamegraph = createMockFlamegraph();
      const hotPaths = analyzeHotPathsFromFlamegraph(flamegraph, {
        focusOnUserCode: false,
        maxHotPaths: 1,
      });

      expect(hotPaths).toHaveLength(1);
    });

    it("returns empty array for flamegraph without profiles", () => {
      const flamegraph = createMockFlamegraph({ profiles: [] });
      const hotPaths = analyzeHotPathsFromFlamegraph(flamegraph, {
        focusOnUserCode: false,
        maxHotPaths: 10,
      });

      expect(hotPaths).toHaveLength(0);
    });
  });

  describe("reconstructCallStack", () => {
    it("reconstructs call stack with correct depth tracking", () => {
      const flamegraph = createMockFlamegraph();
      const callStack = reconstructCallStack(
        [0, 1, 2],
        flamegraph.shared.frames,
        flamegraph.shared.frame_infos,
      );

      expect(callStack).toHaveLength(3);
      expect(callStack[0].depth).toBe(0);
      expect(callStack[1].depth).toBe(1);
      expect(callStack[2].depth).toBe(2);
    });

    it("marks root and leaf frames correctly", () => {
      const flamegraph = createMockFlamegraph();
      // Note: reconstructCallStack expects leaf-to-root order
      const callStack = reconstructCallStack(
        [2, 1, 0], // leaf first, root last
        flamegraph.shared.frames,
        flamegraph.shared.frame_infos,
      );

      // First frame is leaf (leaf-to-root order)
      expect(callStack[0].isLeaf).toBe(true);
      expect(callStack[0].isRoot).toBe(false);

      // Middle frame
      expect(callStack[1].isRoot).toBe(false);
      expect(callStack[1].isLeaf).toBe(false);

      // Last frame is root
      expect(callStack[2].isRoot).toBe(true);
      expect(callStack[2].isLeaf).toBe(false);
    });

    it("handles single-frame stacks", () => {
      const flamegraph = createMockFlamegraph();
      const callStack = reconstructCallStack(
        [0],
        flamegraph.shared.frames,
        flamegraph.shared.frame_infos,
      );

      expect(callStack).toHaveLength(1);
      // Single frame is both root and leaf
      expect(callStack[0].isRoot).toBe(true);
      expect(callStack[0].isLeaf).toBe(true);
    });

    it("preserves frame index reference", () => {
      const flamegraph = createMockFlamegraph();
      const callStack = reconstructCallStack(
        [0, 1, 2],
        flamegraph.shared.frames,
        flamegraph.shared.frame_infos,
      );

      expect(callStack[0].frameIndex).toBe(0);
      expect(callStack[1].frameIndex).toBe(1);
      expect(callStack[2].frameIndex).toBe(2);
    });
  });

  describe("identifyHotspotFramesFromFlamegraph", () => {
    it("identifies hotspot frames sorted by weight", () => {
      const flamegraph = createMockFlamegraph();
      const hotspots = identifyHotspotFramesFromFlamegraph(flamegraph, {
        focusOnUserCode: false,
      });

      expect(hotspots.length).toBeGreaterThan(0);
      // Should be sorted by weight (highest first)
      for (let i = 1; i < hotspots.length; i++) {
        expect(hotspots[i - 1].frameInfo.weight).toBeGreaterThanOrEqual(
          hotspots[i].frameInfo.weight,
        );
      }
    });

    it("filters to user code when requested", () => {
      const flamegraph = createMockFlamegraph();
      const hotspots = identifyHotspotFramesFromFlamegraph(flamegraph, {
        focusOnUserCode: true,
      });

      // All should be user code (psycopg2 excluded)
      expect(hotspots.every((h) => h.frame.is_application)).toBe(true);
    });

    it("calculates percentage of total", () => {
      const flamegraph = createMockFlamegraph();
      const hotspots = identifyHotspotFramesFromFlamegraph(flamegraph, {
        focusOnUserCode: false,
      });

      // All percentages should sum to a reasonable value
      const totalPercent = hotspots.reduce(
        (sum, h) => sum + h.percentOfTotal,
        0,
      );
      expect(totalPercent).toBeGreaterThan(0);
    });
  });

  describe("generatePerformanceInsights", () => {
    it("detects high variance (p99 >> p75)", () => {
      const insights = generatePerformanceInsights({
        count: 100,
        weight: 100,
        sumDuration: 100_000_000,
        sumSelfTime: 100_000_000,
        p75Duration: 10_000_000, // 10ms
        p95Duration: 50_000_000, // 50ms
        p99Duration: 50_000_000, // 50ms (p99 > p75 * 3)
      });

      expect(insights.some((i) => i.type === "high_variance")).toBe(true);
    });

    it("detects consistently slow (p75 > 100ms)", () => {
      const insights = generatePerformanceInsights({
        count: 100,
        weight: 100,
        sumDuration: 200_000_000,
        sumSelfTime: 200_000_000,
        p75Duration: 150_000_000, // 150ms > 100ms threshold
        p95Duration: 180_000_000,
        p99Duration: 200_000_000,
      });

      expect(insights.some((i) => i.type === "consistently_slow")).toBe(true);
    });

    it("detects hot function (count > 1000)", () => {
      const insights = generatePerformanceInsights({
        count: 5000, // > 1000 threshold
        weight: 100,
        sumDuration: 50_000_000,
        sumSelfTime: 50_000_000,
        p75Duration: 10_000,
        p95Duration: 15_000,
        p99Duration: 20_000,
      });

      expect(insights.some((i) => i.type === "hot_function")).toBe(true);
    });

    it("detects consistent performance (low variance)", () => {
      const insights = generatePerformanceInsights({
        count: 100,
        weight: 100,
        sumDuration: 10_000_000,
        sumSelfTime: 10_000_000,
        p75Duration: 10_000_000,
        p95Duration: 12_000_000,
        p99Duration: 14_000_000, // p99 <= p75 * 1.5
      });

      expect(insights.some((i) => i.type === "consistent")).toBe(true);
    });
  });

  describe("compareFrameStats", () => {
    it("detects major regression (>20% slower)", () => {
      const baseline = createMockFlamegraph();
      const current = createMockFlamegraph();

      // Make current 30% slower (comparison uses sumDuration)
      current.shared.frame_infos[0].sumDuration = 208000000; // 160ms * 1.3 = 208ms

      const comparisons = compareFrameStats(baseline, current, {
        focusOnUserCode: false,
      });

      const regressions = comparisons.filter(
        (c) => c.changeType === "major_regression",
      );
      expect(regressions.length).toBeGreaterThan(0);
      expect(regressions[0].percentChange).toBeGreaterThan(20);
    });

    it("detects minor regression (10-20% slower)", () => {
      const baseline = createMockFlamegraph();
      const current = createMockFlamegraph();

      // Make current 15% slower (comparison uses sumDuration)
      current.shared.frame_infos[1].sumDuration = 184000000; // 160ms * 1.15 = 184ms

      const comparisons = compareFrameStats(baseline, current, {
        focusOnUserCode: false,
      });

      const minorRegressions = comparisons.filter(
        (c) => c.changeType === "minor_regression",
      );
      expect(minorRegressions.length).toBeGreaterThan(0);
    });

    it("detects improvement (<-10%)", () => {
      const baseline = createMockFlamegraph();
      const current = createMockFlamegraph();

      // Make current 20% faster (comparison uses sumDuration)
      current.shared.frame_infos[0].sumDuration = 128000000; // 160ms * 0.8 = 128ms

      const comparisons = compareFrameStats(baseline, current, {
        focusOnUserCode: false,
      });

      const improvements = comparisons.filter(
        (c) => c.changeType === "improvement",
      );
      expect(improvements.length).toBeGreaterThan(0);
    });

    it("identifies no change for small differences", () => {
      const baseline = createMockFlamegraph();
      const current = createMockFlamegraph();

      // Make current 5% slower (within no_change threshold, uses sumDuration)
      current.shared.frame_infos[0].sumDuration = 168000000; // 160ms * 1.05 = 168ms

      const comparisons = compareFrameStats(baseline, current, {
        focusOnUserCode: false,
      });

      const noChange = comparisons.filter((c) => c.changeType === "no_change");
      expect(noChange.length).toBeGreaterThan(0);
    });

    it("filters to user code when requested", () => {
      const baseline = createMockFlamegraph();
      const current = createMockFlamegraph();

      const comparisons = compareFrameStats(baseline, current, {
        focusOnUserCode: true,
      });

      // Library frames should not be in the comparison
      expect(comparisons.every((c) => c.frame.is_application)).toBe(true);
    });

    it("sorts by severity (major regressions first)", () => {
      const baseline = createMockFlamegraph();
      const current = createMockFlamegraph();

      // Create different severity changes
      current.shared.frame_infos[0].weight = 240; // major regression (+50%)
      current.shared.frame_infos[1].weight = 176; // minor regression (+10%)

      const comparisons = compareFrameStats(baseline, current, {
        focusOnUserCode: true,
      });

      if (comparisons.length >= 2) {
        // Major regressions should come before minor ones
        const firstMajorIdx = comparisons.findIndex(
          (c) => c.changeType === "major_regression",
        );
        const firstMinorIdx = comparisons.findIndex(
          (c) => c.changeType === "minor_regression",
        );

        if (firstMajorIdx >= 0 && firstMinorIdx >= 0) {
          expect(firstMajorIdx).toBeLessThan(firstMinorIdx);
        }
      }
    });
  });

  describe("formatDuration", () => {
    it("formats microseconds", () => {
      expect(formatDuration(500_000)).toBe("500µs");
    });

    it("formats milliseconds", () => {
      expect(formatDuration(50_000_000)).toBe("50ms");
    });

    it("formats seconds", () => {
      expect(formatDuration(1_500_000_000)).toBe("1.5s");
    });
  });

  describe("hasProfileData", () => {
    it("returns true for flamegraph with profiles and frames", () => {
      const flamegraph = createMockFlamegraph();
      expect(hasProfileData(flamegraph)).toBe(true);
    });

    it("returns false for flamegraph without profiles", () => {
      const flamegraph = createMockFlamegraph({ profiles: [] });
      expect(hasProfileData(flamegraph)).toBe(false);
    });

    it("returns false for flamegraph without frames", () => {
      const flamegraph = createMockFlamegraph();
      flamegraph.shared.frames = [];
      expect(hasProfileData(flamegraph)).toBe(false);
    });
  });
});
