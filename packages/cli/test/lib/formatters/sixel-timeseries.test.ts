/**
 * Timeseries → sixel renderer tests.
 */

import { describe, expect, test } from "vitest";
import { renderTimeseriesAsSixel } from "../../../src/lib/formatters/sixel-timeseries.js";
import type { TimeseriesResult } from "../../../src/types/dashboard.js";

const ESC = "\x1b";

function makeTimeseries(
  overrides: Partial<TimeseriesResult> = {}
): TimeseriesResult {
  return {
    type: "timeseries",
    series: [
      {
        label: "count()",
        values: [
          { timestamp: 1_700_000_000, value: 10 },
          { timestamp: 1_700_000_060, value: 20 },
          { timestamp: 1_700_000_120, value: 15 },
          { timestamp: 1_700_000_180, value: 30 },
        ],
      },
    ],
    ...overrides,
  };
}

describe("renderTimeseriesAsSixel", () => {
  test("returns undefined when there are no series", () => {
    const data = makeTimeseries({ series: [] });
    expect(renderTimeseriesAsSixel(data)).toBeUndefined();
  });

  test("returns undefined when all series are empty", () => {
    const data = makeTimeseries({
      series: [
        { label: "a", values: [] },
        { label: "b", values: [] },
      ],
    });
    expect(renderTimeseriesAsSixel(data)).toBeUndefined();
  });

  test("emits a DCS sixel sequence for a single series", () => {
    const data = makeTimeseries();
    const sixel = renderTimeseriesAsSixel(data, {
      maxPixelWidth: 64,
      maxPixelHeight: 32,
    });
    expect(sixel).toBeDefined();
    expect(sixel).toContain(`${ESC}P`);
    expect(sixel).toContain(`${ESC}\\`);
  });

  test("emits a DCS sixel sequence for stacked multi-series", () => {
    const data = makeTimeseries({
      series: [
        {
          label: "alpha",
          values: [
            { timestamp: 1_700_000_000, value: 10 },
            { timestamp: 1_700_000_060, value: 20 },
          ],
        },
        {
          label: "beta",
          values: [
            { timestamp: 1_700_000_000, value: 5 },
            { timestamp: 1_700_000_060, value: 10 },
          ],
        },
      ],
    });
    const sixel = renderTimeseriesAsSixel(data, {
      maxPixelWidth: 64,
      maxPixelHeight: 32,
    });
    expect(sixel).toBeDefined();
    expect(sixel).toContain(`${ESC}P`);
    expect(sixel).toContain(`${ESC}\\`);
  });

  test("applies background fill when requested", () => {
    const data = makeTimeseries();
    const transparent = renderTimeseriesAsSixel(data, {
      maxPixelWidth: 32,
      maxPixelHeight: 16,
      backgroundTransparent: true,
    });
    const opaque = renderTimeseriesAsSixel(data, {
      maxPixelWidth: 32,
      maxPixelHeight: 16,
      backgroundTransparent: false,
    });
    expect(transparent).toBeDefined();
    expect(opaque).toBeDefined();
  });

  test("uses sensible defaults for missing options", () => {
    const data = makeTimeseries();
    const sixel = renderTimeseriesAsSixel(data);
    expect(sixel).toBeDefined();
    expect(sixel).toContain(`${ESC}P`);
    expect(sixel).toContain(`${ESC}\\`);
  });
});
