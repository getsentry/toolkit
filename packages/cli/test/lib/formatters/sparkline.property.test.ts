/**
 * Property-based tests for the sparkline renderer.
 *
 * Verifies invariants that must hold for any valid input:
 * output length, character set, normalization behavior, and edge cases.
 */

import { array, assert as fcAssert, integer, nat, property } from "fast-check";
import { describe, expect, test } from "vitest";
import { sparkline } from "../../../src/lib/formatters/sparkline.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

/** All valid sparkline characters: scan-line zero + 8 block levels. */
const VALID_CHARS = ["⎽", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Block characters only (non-zero values). Used for ordering tests. */
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Arbitrary for non-negative integer arrays (typical event counts). */
const valuesArb = array(nat({ max: 10_000 }), { minLength: 1, maxLength: 100 });

/** Arbitrary for sparkline width (reasonable range). */
const widthArb = integer({ min: 1, max: 50 });

describe("property: sparkline", () => {
  test("output length <= width", () => {
    fcAssert(
      property(valuesArb, widthArb, (values, width) => {
        const result = sparkline(values, width);
        expect(result.length).toBeLessThanOrEqual(width);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output length equals min(values.length, width)", () => {
    fcAssert(
      property(valuesArb, widthArb, (values, width) => {
        const result = sparkline(values, width);
        expect(result.length).toBe(Math.min(values.length, width));
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("all characters are valid sparkline characters", () => {
    fcAssert(
      property(valuesArb, widthArb, (values, width) => {
        const result = sparkline(values, width);
        for (const char of result) {
          expect(VALID_CHARS).toContain(char);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("all-zero input produces all scan-line characters", () => {
    fcAssert(
      property(integer({ min: 1, max: 50 }), widthArb, (len, width) => {
        const values = new Array<number>(len).fill(0);
        const result = sparkline(values, width);
        for (const char of result) {
          expect(char).toBe("⎽");
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("empty input returns empty string", () => {
    expect(sparkline([])).toBe("");
    expect(sparkline([], 10)).toBe("");
  });

  test("singleton positive value maps to top block", () => {
    fcAssert(
      property(integer({ min: 1, max: 10_000 }), (v) => {
        const result = sparkline([v]);
        expect(result).toBe("█");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("maximum value in array maps to top block", () => {
    fcAssert(
      property(valuesArb, (values) => {
        const max = Math.max(...values);
        if (max === 0) {
          return; // all-zero case tested separately
        }
        // When not downsampled (width >= values.length), max position → █
        const result = sparkline(values, values.length);
        const maxIdx = values.indexOf(max);
        expect(result[maxIdx]).toBe("█");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("monotonically increasing input produces non-decreasing block heights", () => {
    fcAssert(
      property(integer({ min: 2, max: 30 }), (len) => {
        // Build strictly increasing values
        const values = Array.from({ length: len }, (_, i) => i + 1);
        const result = sparkline(values, values.length);
        for (let i = 1; i < result.length; i++) {
          const prev = BLOCKS.indexOf(result[i - 1] ?? "");
          const curr = BLOCKS.indexOf(result[i] ?? "");
          expect(curr).toBeGreaterThanOrEqual(prev);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output is deterministic (same input → same output)", () => {
    fcAssert(
      property(valuesArb, widthArb, (values, width) => {
        const a = sparkline(values, width);
        const b = sparkline(values, width);
        expect(a).toBe(b);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
