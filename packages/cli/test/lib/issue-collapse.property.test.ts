/**
 * Property-based tests for buildIssueListCollapse and ISSUE_DETAIL_COLLAPSE.
 *
 * Verifies invariants that must hold for any configuration of the collapse
 * parameter: always-collapsed fields, stats/lifetime control, and safety constraints.
 */

import { boolean, assert as fcAssert, property, tuple } from "fast-check";
import { describe, expect, test } from "vitest";

import {
  buildIssueListCollapse,
  ISSUE_DETAIL_COLLAPSE,
} from "../../src/lib/api/issues.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

describe("property: buildIssueListCollapse", () => {
  test("always collapses filtered and unhandled regardless of optional flags", () => {
    fcAssert(
      property(
        tuple(boolean(), boolean()),
        ([collapseStats, collapseLifetime]) => {
          const result = buildIssueListCollapse({
            shouldCollapseStats: collapseStats,
            shouldCollapseLifetime: collapseLifetime,
          });
          expect(result).toContain("filtered");
          expect(result).toContain("unhandled");
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("stats presence is exactly controlled by shouldCollapseStats", () => {
    fcAssert(
      property(
        tuple(boolean(), boolean()),
        ([collapseStats, collapseLifetime]) => {
          const result = buildIssueListCollapse({
            shouldCollapseStats: collapseStats,
            shouldCollapseLifetime: collapseLifetime,
          });
          expect(result.includes("stats")).toBe(collapseStats);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("lifetime presence is exactly controlled by shouldCollapseLifetime", () => {
    fcAssert(
      property(
        tuple(boolean(), boolean()),
        ([collapseStats, collapseLifetime]) => {
          const result = buildIssueListCollapse({
            shouldCollapseStats: collapseStats,
            shouldCollapseLifetime: collapseLifetime,
          });
          expect(result.includes("lifetime")).toBe(collapseLifetime);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("defaults to not collapsing lifetime when option omitted", () => {
    fcAssert(
      property(boolean(), (collapseStats) => {
        const result = buildIssueListCollapse({
          shouldCollapseStats: collapseStats,
        });
        expect(result).not.toContain("lifetime");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("never collapses base (would break all rendering)", () => {
    fcAssert(
      property(
        tuple(boolean(), boolean()),
        ([collapseStats, collapseLifetime]) => {
          const result = buildIssueListCollapse({
            shouldCollapseStats: collapseStats,
            shouldCollapseLifetime: collapseLifetime,
          });
          expect(result).not.toContain("base");
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns no duplicates", () => {
    fcAssert(
      property(
        tuple(boolean(), boolean()),
        ([collapseStats, collapseLifetime]) => {
          const result = buildIssueListCollapse({
            shouldCollapseStats: collapseStats,
            shouldCollapseLifetime: collapseLifetime,
          });
          expect(new Set(result).size).toBe(result.length);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("length equals 2 + number of optional flags enabled", () => {
    fcAssert(
      property(
        tuple(boolean(), boolean()),
        ([collapseStats, collapseLifetime]) => {
          const result = buildIssueListCollapse({
            shouldCollapseStats: collapseStats,
            shouldCollapseLifetime: collapseLifetime,
          });
          const expected =
            2 + (collapseStats ? 1 : 0) + (collapseLifetime ? 1 : 0);
          expect(result.length).toBe(expected);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("ISSUE_DETAIL_COLLAPSE", () => {
  test("contains exactly stats, lifetime, filtered, unhandled", () => {
    expect(ISSUE_DETAIL_COLLAPSE).toEqual([
      "stats",
      "lifetime",
      "filtered",
      "unhandled",
    ]);
  });

  test("never contains base (would break issue rendering)", () => {
    expect(ISSUE_DETAIL_COLLAPSE).not.toContain("base");
  });

  test("always includes stats (detail views never show sparklines)", () => {
    expect(ISSUE_DETAIL_COLLAPSE).toContain("stats");
  });

  test("is a superset of buildIssueListCollapse with all options enabled", () => {
    const listCollapse = buildIssueListCollapse({
      shouldCollapseStats: true,
      shouldCollapseLifetime: true,
    });
    for (const field of listCollapse) {
      expect(ISSUE_DETAIL_COLLAPSE).toContain(field);
    }
  });
});
