/**
 * Property-Based Tests for shouldAutoCompact
 *
 * Verifies invariants of the terminal-height-based auto-compact heuristic.
 * Since shouldAutoCompact reads process.stdout.rows, tests save/restore the
 * property around each assertion.
 */

import { assert as fcAssert, integer, nat, property, tuple } from "fast-check";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { shouldAutoCompact } from "../../../src/lib/formatters/human.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

/** Lines per non-compact row (2 content + 1 separator). */
const LINES_PER_ROW = 3;

/** Fixed overhead: top border + header + header sep + bottom border − 1 (no trailing row sep). */
const OVERHEAD = 3;

/** Save original process.stdout.rows so we can restore it after each test. */
let originalRows: number | undefined;

beforeEach(() => {
  originalRows = process.stdout.rows;
});

afterEach(() => {
  Object.defineProperty(process.stdout, "rows", {
    value: originalRows,
    writable: true,
    configurable: true,
  });
});

/** Set process.stdout.rows for testing. */
function setTermHeight(rows: number | undefined): void {
  Object.defineProperty(process.stdout, "rows", {
    value: rows,
    writable: true,
    configurable: true,
  });
}

describe("property: shouldAutoCompact", () => {
  test("returns false when terminal height is undefined (non-TTY)", () => {
    fcAssert(
      property(nat(500), (rowCount) => {
        setTermHeight(undefined);
        expect(shouldAutoCompact(rowCount)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns false when terminal height is 0", () => {
    fcAssert(
      property(nat(500), (rowCount) => {
        setTermHeight(0);
        expect(shouldAutoCompact(rowCount)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("zero rows only triggers compact if overhead alone exceeds terminal", () => {
    fcAssert(
      property(integer({ min: 1, max: 500 }), (termHeight) => {
        setTermHeight(termHeight);
        // With 0 rows, estimated = OVERHEAD. Compact iff OVERHEAD > termHeight.
        expect(shouldAutoCompact(0)).toBe(OVERHEAD > termHeight);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns true when estimated height exceeds terminal height", () => {
    fcAssert(
      property(
        tuple(integer({ min: 1, max: 200 }), integer({ min: 5, max: 500 })),
        ([rowCount, termHeight]) => {
          const estimated = rowCount * LINES_PER_ROW + OVERHEAD;
          if (estimated > termHeight) {
            setTermHeight(termHeight);
            expect(shouldAutoCompact(rowCount)).toBe(true);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns false when estimated height fits within terminal", () => {
    fcAssert(
      property(
        tuple(integer({ min: 1, max: 200 }), integer({ min: 5, max: 2000 })),
        ([rowCount, termHeight]) => {
          const estimated = rowCount * LINES_PER_ROW + OVERHEAD;
          if (estimated <= termHeight) {
            setTermHeight(termHeight);
            expect(shouldAutoCompact(rowCount)).toBe(false);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("is monotonic: more rows never decreases compactness", () => {
    fcAssert(
      property(
        tuple(nat(100), nat(100), integer({ min: 10, max: 200 })),
        ([a, b, termHeight]) => {
          setTermHeight(termHeight);
          const smaller = Math.min(a, b);
          const larger = Math.max(a, b);
          const compactSmall = shouldAutoCompact(smaller);
          const compactLarge = shouldAutoCompact(larger);
          // If fewer rows triggers compact, more rows must also trigger compact
          if (compactSmall) {
            expect(compactLarge).toBe(true);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("is deterministic: same inputs produce same output", () => {
    fcAssert(
      property(
        tuple(nat(200), integer({ min: 1, max: 500 })),
        ([rowCount, termHeight]) => {
          setTermHeight(termHeight);
          const result1 = shouldAutoCompact(rowCount);
          const result2 = shouldAutoCompact(rowCount);
          expect(result1).toBe(result2);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
