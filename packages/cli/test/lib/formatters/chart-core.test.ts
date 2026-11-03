/**
 * Shared chart core tests.
 */

import { describe, expect, test } from "vitest";
import {
  buildCategoricalChartModel,
  buildChartModel,
  fadeIncompleteColor,
  hexToRgb,
  rasterizeChart,
  SERIES_PALETTE,
  seriesColor,
} from "../../../src/lib/formatters/chart-core.js";
import type { TimeseriesResult } from "../../../src/types/dashboard.js";

function makeTimeseries(
  overrides: Partial<TimeseriesResult> = {},
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

describe("seriesColor", () => {
  test("returns muted gray for the Other bucket", () => {
    expect(seriesColor("Other", 3)).toBe("#888888");
  });

  test("cycles through the palette by index", () => {
    expect(seriesColor("a", 0)).toBe(SERIES_PALETTE[0]);
    expect(seriesColor("a", SERIES_PALETTE.length)).toBe(SERIES_PALETTE[0]);
    expect(seriesColor("a", 1)).toBe(SERIES_PALETTE[1]);
  });
});

describe("hexToRgb", () => {
  test("parses six-digit hex", () => {
    expect(hexToRgb("#7553FF")).toEqual([0x75, 0x53, 0xff]);
  });

  test("parses shorthand three-digit hex", () => {
    expect(hexToRgb("#0f8")).toEqual([0x00, 0xff, 0x88]);
  });
});

describe("fadeIncompleteColor", () => {
  test("blends halfway toward gray", () => {
    expect(fadeIncompleteColor([0, 128, 255])).toEqual([64, 128, 192]);
  });
});

describe("incomplete buckets", () => {
  /** Read the RGB of a pixel from an RGBA canvas. */
  function pixel(
    img: { width: number; data: Uint8Array | Buffer },
    x: number,
    y: number,
  ): [number, number, number] {
    const i = (y * img.width + x) * 4;
    return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0];
  }

  test("buildChartModel carries per-bucket incomplete flags", () => {
    const data = makeTimeseries();
    data.series[0]!.values[3] = {
      timestamp: 1_700_000_180,
      value: 30,
      incomplete: true,
    };
    const model = buildChartModel(data);
    expect(model?.series[0]?.incomplete).toEqual([false, false, false, true]);
  });

  test("buildChartModel omits the flags when every bucket is complete", () => {
    const model = buildChartModel(makeTimeseries());
    expect(model?.series[0]?.incomplete).toBeUndefined();
  });

  test("single-series bars fade incomplete columns", () => {
    const data = makeTimeseries();
    data.series[0]!.values[3] = {
      timestamp: 1_700_000_180,
      value: 30,
      incomplete: true,
    };
    const model = buildChartModel(data);
    const img = rasterizeChart(model!, { width: 64, height: 32 });
    expect(img).toBeDefined();
    // 4 buckets on a 64px canvas: gap 2, bar width 14, last bar starts at 48.
    const full = hexToRgb(seriesColor("count()", 0));
    expect(pixel(img!, 0, 31)).toEqual(full);
    expect(pixel(img!, 48, 31)).toEqual(fadeIncompleteColor(full));
  });

  test("stacked columns fade incomplete buckets per series", () => {
    const data = makeTimeseries({
      series: [
        {
          label: "a",
          values: [
            { timestamp: 1, value: 10 },
            { timestamp: 2, value: 10, incomplete: true },
          ],
        },
        {
          label: "b",
          values: [
            { timestamp: 1, value: 10 },
            { timestamp: 2, value: 10, incomplete: true },
          ],
        },
      ],
    });
    const model = buildChartModel(data);
    const img = rasterizeChart(model!, { width: 32, height: 16 });
    expect(img).toBeDefined();
    // 2 buckets on 32px: gap 2, bar width 15, second column starts at 17.
    const bottom = hexToRgb(seriesColor("a", 0));
    expect(pixel(img!, 0, 15)).toEqual(bottom);
    expect(pixel(img!, 17, 15)).toEqual(fadeIncompleteColor(bottom));
  });

  test("downsampling keeps an incomplete tail flagged", () => {
    const values = Array.from({ length: 40 }, (_, i) => ({
      timestamp: i,
      value: 1,
      ...(i === 39 ? { incomplete: true } : {}),
    }));
    const model = buildChartModel(
      makeTimeseries({ series: [{ label: "c", values }] }),
    );
    // 40 buckets on a 16px canvas must be averaged down to 8 columns.
    const img = rasterizeChart(model!, { width: 16, height: 8 });
    expect(img).toBeDefined();
    const full = hexToRgb(seriesColor("c", 0));
    expect(pixel(img!, 0, 7)).toEqual(full);
    expect(pixel(img!, 14, 7)).toEqual(fadeIncompleteColor(full));
  });
});

describe("buildChartModel", () => {
  test("returns undefined for empty series", () => {
    expect(buildChartModel(makeTimeseries({ series: [] }))).toBeUndefined();
  });

  test("returns undefined when every series is empty", () => {
    const model = buildChartModel(
      makeTimeseries({
        series: [
          { label: "a", values: [] },
          { label: "b", values: [] },
        ],
      }),
    );
    expect(model).toBeUndefined();
  });

  test("builds a single-series, non-stacked model with peak maxVal", () => {
    const model = buildChartModel(makeTimeseries());
    expect(model).toBeDefined();
    expect(model?.stacked).toBe(false);
    expect(model?.kind).toBe("timeseries");
    expect(model?.buckets).toBe(4);
    expect(model?.maxVal).toBe(30);
  });

  test("builds a stacked model with per-bucket totals as maxVal", () => {
    const model = buildChartModel(
      makeTimeseries({
        series: [
          {
            label: "alpha",
            values: [
              { timestamp: 1, value: 10 },
              { timestamp: 2, value: 20 },
            ],
          },
          {
            label: "beta",
            values: [
              { timestamp: 1, value: 5 },
              { timestamp: 2, value: 10 },
            ],
          },
        ],
      }),
    );
    expect(model?.stacked).toBe(true);
    expect(model?.buckets).toBe(2);
    // Largest per-bucket total is 20 + 10 = 30.
    expect(model?.maxVal).toBe(30);
  });
});

describe("buildCategoricalChartModel", () => {
  test("sorts category bars while keeping Other last and out of the scale", () => {
    const model = buildCategoricalChartModel(
      makeTimeseries({
        series: [
          { label: "Other", values: [{ timestamp: 1, value: 1000 }] },
          { label: "US", values: [{ timestamp: 1, value: 20 }] },
          { label: "GB", values: [{ timestamp: 1, value: 10 }] },
        ],
      }),
    );

    expect(model?.kind).toBe("categorical");
    expect(model?.series.map((series) => series.label)).toEqual([
      "US",
      "GB",
      "Other",
    ]);
    expect(model?.maxVal).toBe(20);
  });
});

describe("rasterizeChart", () => {
  test("declines dense nullable buckets instead of averaging across gaps", () => {
    const model = buildChartModel(makeTimeseries())!;
    model.series[0]!.values = [10, null, 20, 30, 40, 50, 60, 70, 80];
    model.buckets = 9;

    expect(rasterizeChart(model, { width: 16, height: 8 })).toBeUndefined();
  });

  test("returns a canvas at the requested resolution", () => {
    const model = buildChartModel(makeTimeseries());
    const img = rasterizeChart(model!, { width: 64, height: 32 });
    expect(img).toBeDefined();
    expect(img?.width).toBe(64);
    expect(img?.height).toBe(32);
    expect(img?.data.length).toBe(64 * 32 * 4);
  });

  test("clamps resolution to a minimum size", () => {
    const model = buildChartModel(makeTimeseries());
    const img = rasterizeChart(model!, { width: 1, height: 1 });
    expect(img?.width).toBe(16);
    expect(img?.height).toBe(8);
  });

  test("draws opaque pixels for bars", () => {
    const model = buildChartModel(makeTimeseries());
    const img = rasterizeChart(model!, { width: 64, height: 32 });
    let opaque = 0;
    for (let i = 3; i < (img?.data.length ?? 0); i += 4) {
      if ((img?.data[i] ?? 0) > 0) {
        opaque += 1;
      }
    }
    expect(opaque).toBeGreaterThan(0);
  });

  test("fills the background when transparency is off", () => {
    const model = buildChartModel(makeTimeseries());
    const img = rasterizeChart(model!, {
      width: 32,
      height: 16,
      backgroundTransparent: false,
    });
    // Top-left pixel is above the bars, so it shows the background fill.
    expect(img?.data[3]).toBe(255);
  });

  test("downsamples dense series so late buckets stay on canvas", () => {
    // Far more buckets than half the canvas width: without downsampling the
    // rising tail would be clipped off the right edge. Put all the signal in
    // the last quarter of the range so a clipped render would be near-empty.
    const values = Array.from({ length: 400 }, (_, i) => ({
      timestamp: 1_700_000_000 + i * 60,
      value: i < 300 ? 0 : i,
    }));
    const model = buildChartModel(
      makeTimeseries({ series: [{ label: "c", values }] }),
    );
    const width = 64;
    const img = rasterizeChart(model!, { width, height: 32 });

    // Count opaque pixels in the right quarter — the tail must survive.
    let rightOpaque = 0;
    const data = img?.data ?? new Uint8Array();
    for (let y = 0; y < 32; y++) {
      for (let x = Math.floor(width * 0.75); x < width; x++) {
        if ((data[(y * width + x) * 4 + 3] ?? 0) > 0) {
          rightOpaque += 1;
        }
      }
    }
    expect(rightOpaque).toBeGreaterThan(0);
  });

  test("draws independent categorical bars instead of a stacked column", () => {
    const model = buildCategoricalChartModel(
      makeTimeseries({
        series: [
          { label: "alpha", values: [{ timestamp: 1, value: 10 }] },
          { label: "beta", values: [{ timestamp: 1, value: 20 }] },
        ],
      }),
    );
    const image = rasterizeChart(model!, { width: 40, height: 20 });
    const data = image?.data ?? new Uint8Array();
    const leftBarAlpha = data[(19 * 40 + 0) * 4 + 3] ?? 0;
    const rightBarAlpha = data[(19 * 40 + 21) * 4 + 3] ?? 0;
    const gapAlpha = data[(19 * 40 + 19) * 4 + 3] ?? 0;

    expect(leftBarAlpha).toBe(255);
    expect(rightBarAlpha).toBe(255);
    expect(gapAlpha).toBe(0);
  });
});
