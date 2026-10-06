/**
 * Property tests for terminal-height option windowing in the Ink prompt UI.
 */

import { assert as fcAssert, integer, property } from "fast-check";
import { describe, expect, test } from "vitest";
import { getOptionWindow } from "../../../../src/lib/init/ui/ink-app.js";
import { DEFAULT_NUM_RUNS } from "../../../model-based/helpers.js";

describe("property: Ink prompt option window", () => {
  test("stays bounded and always contains the highlighted option", () => {
    fcAssert(
      property(
        integer({ min: 0, max: 500 }),
        integer({ min: -1000, max: 1000 }),
        integer({ min: -50, max: 200 }),
        (totalCount, highlighted, maxVisible) => {
          const [start, end] = getOptionWindow(
            totalCount,
            highlighted,
            maxVisible
          );
          const expectedSize = Math.min(totalCount, Math.max(1, maxVisible));

          expect(start).toBeGreaterThanOrEqual(0);
          expect(end).toBeLessThanOrEqual(totalCount);
          expect(end - start).toBe(expectedSize);

          if (totalCount > 0) {
            const normalizedHighlight = Math.min(
              totalCount - 1,
              Math.max(0, highlighted)
            );
            expect(start).toBeLessThanOrEqual(normalizedHighlight);
            expect(end).toBeGreaterThan(normalizedHighlight);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
