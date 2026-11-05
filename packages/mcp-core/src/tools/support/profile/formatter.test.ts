import { describe, expect, it } from "vitest";
import type { Flamegraph } from "../../../api-client/types";
import {
  formatFlamegraphAnalysis,
  formatFlamegraphComparison,
} from "./formatter";

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

describe("formatter", () => {
  describe("formatFlamegraphAnalysis", () => {
    it("includes transaction information", () => {
      const flamegraph = createMockFlamegraph();
      const output = formatFlamegraphAnalysis(flamegraph, {
        focusOnUserCode: true,
        maxHotPaths: 5,
      });

      expect(output).toContain("# Profile Analysis: /api/users");
      expect(output).toContain("**Transaction**: /api/users");
      expect(output).toContain("**Project ID**: 123");
      expect(output).toContain("**Platform**: python");
    });

    it("includes performance summary", () => {
      const flamegraph = createMockFlamegraph();
      const output = formatFlamegraphAnalysis(flamegraph, {
        focusOnUserCode: true,
        maxHotPaths: 5,
      });

      expect(output).toContain("## Performance Summary");
      expect(output).toContain("### Code Breakdown");
      expect(output).toContain("Total User Code Time");
      expect(output).toContain("Total Library Time");
    });

    it("includes top slow functions table", () => {
      const flamegraph = createMockFlamegraph();
      const output = formatFlamegraphAnalysis(flamegraph, {
        focusOnUserCode: true,
        maxHotPaths: 5,
      });

      expect(output).toContain("### Top Slow Functions");
      expect(output).toContain("| Function | File:Line |");
      expect(output).toContain("`handle_request`");
      expect(output).toContain("`fetch_data`");
    });

    it("includes hot paths section", () => {
      const flamegraph = createMockFlamegraph();
      const output = formatFlamegraphAnalysis(flamegraph, {
        focusOnUserCode: false,
        maxHotPaths: 5,
      });

      expect(output).toContain("## Top Hot Paths");
      expect(output).toContain("### Path #1:");
      expect(output).toContain("samples");
    });

    it("falls back to thread profiles when shared profile metadata is omitted", () => {
      const flamegraph = createMockFlamegraph({
        shared: {
          ...createMockFlamegraph().shared,
          profiles: [],
        },
      });
      const output = formatFlamegraphAnalysis(flamegraph, {
        focusOnUserCode: false,
        maxHotPaths: 5,
      });

      expect(output).toContain("**Total Profiles**: 1");
      expect(output).toContain("across 1 profiles");
    });

    it("includes actionable next steps", () => {
      const flamegraph = createMockFlamegraph();
      const output = formatFlamegraphAnalysis(flamegraph, {
        focusOnUserCode: true,
        maxHotPaths: 5,
      });

      expect(output).toContain("## Actionable Next Steps");
      expect(output).toContain("### Immediate Actions");
      expect(output).toContain("Compare with baseline");
    });

    it("respects focusOnUserCode option in hot paths", () => {
      const flamegraph = createMockFlamegraph();
      const outputUserCode = formatFlamegraphAnalysis(flamegraph, {
        focusOnUserCode: true,
        maxHotPaths: 5,
      });

      const outputAll = formatFlamegraphAnalysis(flamegraph, {
        focusOnUserCode: false,
        maxHotPaths: 5,
      });

      // User code output should show [YOUR CODE] markers
      expect(outputUserCode).toContain("[YOUR CODE]");

      // All code output should include library code
      expect(outputAll).toContain("psycopg2");
    });
  });

  describe("formatFlamegraphComparison", () => {
    it("includes comparison summary", () => {
      const baseline = createMockFlamegraph();
      const current = createMockFlamegraph();

      const output = formatFlamegraphComparison(baseline, current, {
        focusOnUserCode: false,
      });

      expect(output).toContain("# Profile Comparison: /api/users");
      expect(output).toContain("## Summary");
      expect(output).toContain("**Status**:");
    });

    it("shows 'No Significant Changes' when similar", () => {
      const baseline = createMockFlamegraph();
      const current = createMockFlamegraph();

      const output = formatFlamegraphComparison(baseline, current, {
        focusOnUserCode: false,
      });

      expect(output).toContain("No Significant Changes");
    });

    it("detects and reports major regressions", () => {
      const baseline = createMockFlamegraph();
      const current = createMockFlamegraph();

      // Make current 50% slower (comparison uses sumDuration, not weight)
      current.shared.frame_infos[0].sumDuration = 240000000;

      const output = formatFlamegraphComparison(baseline, current, {
        focusOnUserCode: false,
      });

      expect(output).toContain("Regression Detected");
      expect(output).toContain("## Major Regressions Detected");
      expect(output).toContain("`handle_request`");
    });

    it("includes key changes table", () => {
      const baseline = createMockFlamegraph();
      const current = createMockFlamegraph();

      const output = formatFlamegraphComparison(baseline, current, {
        focusOnUserCode: false,
      });

      expect(output).toContain("## Key Changes");
      expect(output).toContain(
        "| Function | File:Line | Baseline | Current | Change | Status |",
      );
    });

    it("shows improvement status when performance improves", () => {
      const baseline = createMockFlamegraph();
      const current = createMockFlamegraph();

      // Make current 20% faster (comparison uses sumDuration, not weight)
      current.shared.frame_infos[0].sumDuration = 128000000;
      current.shared.frame_infos[1].sumDuration = 128000000;
      current.shared.frame_infos[2].sumDuration = 80000000;

      const output = formatFlamegraphComparison(baseline, current, {
        focusOnUserCode: false,
      });

      expect(output).toContain("Improvement");
    });
  });

  describe("edge cases", () => {
    it("handles empty profiles gracefully", () => {
      const flamegraph = createMockFlamegraph({ profiles: [] });
      const output = formatFlamegraphAnalysis(flamegraph, {
        focusOnUserCode: true,
        maxHotPaths: 5,
      });

      expect(output).toContain("Profile Analysis:");
      expect(output).toContain("No significant hot paths found");
    });

    it("handles empty frames gracefully", () => {
      const flamegraph = createMockFlamegraph();
      flamegraph.shared.frames = [];
      flamegraph.shared.frame_infos = [];

      const output = formatFlamegraphAnalysis(flamegraph, {
        focusOnUserCode: true,
        maxHotPaths: 5,
      });

      // Should not throw and should produce output
      expect(typeof output).toBe("string");
    });

    it("handles missing optional fields", () => {
      const flamegraph = createMockFlamegraph({ transactionName: undefined });

      const output = formatFlamegraphAnalysis(flamegraph, {
        focusOnUserCode: true,
        maxHotPaths: 5,
      });

      expect(output).toContain("Unknown Transaction");
    });
  });
});
