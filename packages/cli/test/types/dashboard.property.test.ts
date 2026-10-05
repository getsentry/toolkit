/**
 * Property-Based Tests for Dashboard Auto-Layout
 *
 * Uses fast-check to verify invariants that should always hold for
 * assignDefaultLayout(), regardless of widget types, counts, or layout mode.
 */

import { array, constantFrom, assert as fcAssert, property } from "fast-check";
import { describe, expect, test } from "vitest";
import {
  assignDefaultLayout,
  type DashboardWidget,
  DISPLAY_TYPES,
  GRID_COLUMNS,
  type WidgetLayoutMode,
} from "../../src/types/dashboard.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary for a display type from the full set */
const displayTypeArb = constantFrom(...DISPLAY_TYPES);

/** Arbitrary for a widget without a layout */
const widgetArb = displayTypeArb.map(
  (dt): DashboardWidget => ({
    title: `Widget-${dt}`,
    displayType: dt,
  })
);

/** Arbitrary for layout mode */
const modeArb = constantFrom<WidgetLayoutMode>("sequential", "dense");

/**
 * Build a sequence of placed widgets by calling assignDefaultLayout
 * repeatedly, simulating sequential `widget add` calls.
 */
function buildPlacedSequence(
  widgets: DashboardWidget[],
  mode: WidgetLayoutMode
): DashboardWidget[] {
  const placed: DashboardWidget[] = [];
  for (const w of widgets) {
    placed.push(assignDefaultLayout(w, placed, mode));
  }
  return placed;
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("property: assignDefaultLayout", () => {
  test("always produces a layout within grid bounds (both modes)", () => {
    fcAssert(
      property(
        array(widgetArb, { minLength: 0, maxLength: 20 }),
        widgetArb,
        modeArb,
        (existing, newWidget, mode) => {
          const placed = buildPlacedSequence(existing, mode);
          const result = assignDefaultLayout(newWidget, placed, mode);

          expect(result.layout).toBeDefined();
          const l = result.layout!;
          expect(l.x).toBeGreaterThanOrEqual(0);
          expect(l.y).toBeGreaterThanOrEqual(0);
          expect(l.x + l.w).toBeLessThanOrEqual(GRID_COLUMNS);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("never overlaps any existing widget (both modes)", () => {
    fcAssert(
      property(
        array(widgetArb, { minLength: 1, maxLength: 15 }),
        widgetArb,
        modeArb,
        (existing, newWidget, mode) => {
          const placed = buildPlacedSequence(existing, mode);
          const result = assignDefaultLayout(newWidget, placed, mode);
          const n = result.layout!;

          for (const p of placed) {
            if (!p.layout) {
              continue;
            }
            const overlapX =
              n.x < p.layout.x + p.layout.w && n.x + n.w > p.layout.x;
            const overlapY =
              n.y < p.layout.y + p.layout.h && n.y + n.h > p.layout.y;
            expect(overlapX && overlapY).toBe(false);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("idempotent — widget with layout is returned unchanged (both modes)", () => {
    fcAssert(
      property(widgetArb, modeArb, (base, mode) => {
        const placed = assignDefaultLayout(base, [], mode);
        const again = assignDefaultLayout(placed, [], mode);
        expect(again.layout).toEqual(placed.layout);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("sequential mode: placements have non-decreasing y-coordinate", () => {
    fcAssert(
      property(array(widgetArb, { minLength: 2, maxLength: 20 }), (widgets) => {
        const placed = buildPlacedSequence(widgets, "sequential");
        for (let i = 1; i < placed.length; i++) {
          expect(placed[i]!.layout!.y).toBeGreaterThanOrEqual(
            placed[i - 1]!.layout!.y
          );
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
