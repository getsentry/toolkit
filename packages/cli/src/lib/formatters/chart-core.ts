/**
 * Shared timeseries chart core.
 *
 * Turns a {@link TimeseriesResult} into a resolution-independent
 * {@link ChartModel}, then rasterizes that model into an RGBA pixel canvas.
 * Both the sixel renderer (pixel resolution) and the ASCII renderer
 * (character-cell resolution) consume this single core so the two paths
 * agree on layout, palette, and stacking. The output resolution is chosen by
 * the target and fed in upfront via {@link rasterizeChart}.
 */

import type { TimeseriesResult } from "../../types/dashboard.js";
import type { DecodedImage } from "../sixel-image.js";
import { createPixelCanvas, drawPixelRect } from "./pixel-canvas.js";
import { downsample } from "./sparkline.js";

/**
 * Chart color palette based on Sentry's categorical chart hues.
 *
 * Derived from sentry/static/app/utils/theme/scraps/tokens/color.tsx
 * (categorical.dark / categorical.light), adjusted to a mid-luminance range
 * so every color achieves ≥3:1 contrast on both dark (#1e1e1e) and light
 * (#f0f0f0) terminal backgrounds. "Other" always gets muted gray.
 */
export const SERIES_PALETTE = [
  "#7553FF", // blurple (Sentry primary)
  "#F0369A", // pink
  "#C06F20", // orange  (darkened from #FF9838)
  "#3D8F09", // green   (darkened from #67C800)
  "#8B6AC8", // purple  (lightened from #5D3EB2)
  "#E45560", // salmon  (darkened from #FA6769)
  "#B82D90", // magenta
  "#9E8B18", // yellow  (darkened from #FFD00E)
  "#228A83", // teal    (fills hue gap)
  "#7B50D0", // indigo  (lightened from #50219C)
] as const;

/** Muted gray for the "Other" bucket. */
export const OTHER_COLOR = "#888888";

/** Get the hex color for a series by index. "Other" gets muted gray. */
export function seriesColor(label: string, index: number): string {
  if (label === "Other") {
    return OTHER_COLOR;
  }
  return SERIES_PALETTE[index % SERIES_PALETTE.length] ?? SERIES_PALETTE[0];
}

/** Parse an RGB hex color into a 3-tuple. */
export function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  if (normalized.length === 3) {
    const r0 = normalized[0];
    const g0 = normalized[1];
    const b0 = normalized[2];
    if (r0 && g0 && b0) {
      return [
        Number.parseInt(r0 + r0, 16),
        Number.parseInt(g0 + g0, 16),
        Number.parseInt(b0 + b0, 16),
      ];
    }
  }
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

/** One series in a chart model: a label plus its per-bucket values. */
export type ChartSeries = {
  label: string;
  values: number[];
};

/** Heatmap grid model: categories (rows) × time buckets (columns). */
export type HeatmapModel = {
  kind: "heatmap";
  /** Row labels (category/series names). */
  labels: string[];
  /** 2-D grid: rows[category][bucket] intensity value. */
  rows: number[][];
  /** Global maximum across the entire grid (for normalization). */
  maxVal: number;
  /** Number of time buckets (columns). */
  buckets: number;
};

/**
 * Resolution-independent chart description.
 *
 * `buckets` is the number of time buckets (columns). `maxVal` is the
 * axis maximum: the largest single value for a single series, or the largest
 * per-bucket total for a stacked chart. `stacked` records whether the columns
 * are drawn as stacked segments (multi-series) or as plain bars (single).
 */
export type ChartModel = {
  /** Source shape: timeseries buckets or independently sized categories. */
  kind: "timeseries" | "categorical";
  series: ChartSeries[];
  buckets: number;
  maxVal: number;
  stacked: boolean;
};

/** Build a resolution-independent chart model from a timeseries result. */
export function buildChartModel(
  data: TimeseriesResult
): ChartModel | undefined {
  if (
    data.series.length === 0 ||
    data.series.every((s) => s.values.length === 0)
  ) {
    return;
  }

  const series: ChartSeries[] = data.series.map((s) => ({
    label: s.label,
    values: s.values.map((v) => v.value),
  }));
  const buckets = Math.max(...series.map((s) => s.values.length));
  const stacked = series.length > 1;

  const maxVal = stacked
    ? Math.max(...bucketTotals(series, buckets), 1)
    : Math.max(...(series[0]?.values ?? []), 1);

  return { kind: "timeseries", series, buckets, maxVal, stacked };
}

/** Build a bar-per-category model from a categorical timeseries result. */
export function buildCategoricalChartModel(
  data: TimeseriesResult
): ChartModel | undefined {
  const series = data.series
    .map((item) => ({
      label: item.label,
      values: [item.values.reduce((total, value) => total + value.value, 0)],
    }))
    .sort((a, b) => {
      if (a.label === "Other") {
        return 1;
      }
      if (b.label === "Other") {
        return -1;
      }
      return (b.values[0] ?? 0) - (a.values[0] ?? 0);
    });
  if (series.length === 0) {
    return;
  }

  // "Other" can dwarf every real category. Match the text renderer by scaling
  // against real categories first and clipping Other to the chart height.
  const nonOther = series.filter((item) => item.label !== "Other");
  const scaleSeries = nonOther.length > 0 ? nonOther : series;
  const maxVal = Math.max(...scaleSeries.map((item) => item.values[0] ?? 0), 1);
  return {
    kind: "categorical",
    series,
    buckets: series.length,
    maxVal,
    stacked: false,
  };
}

/** Build a heatmap grid model from grouped timeseries data. */
export function buildHeatmapModel(
  data: TimeseriesResult
): HeatmapModel | undefined {
  if (data.series.length === 0) {
    return;
  }
  const labels = data.series.map((s) => s.label);
  const buckets = Math.max(0, ...data.series.map((s) => s.values.length));
  if (buckets === 0) {
    return;
  }
  const rows = data.series.map((s) => {
    const vals = s.values.map((v) => v.value);
    // pad shorter rows so every row has exactly `buckets` columns
    return vals.length < buckets
      ? [...vals, ...new Array(buckets - vals.length).fill(0)]
      : vals;
  });
  const maxVal = Math.max(1, ...rows.flat());
  return { kind: "heatmap", labels, rows, maxVal, buckets };
}

/** Sum each bucket across every series. */
function bucketTotals(series: ChartSeries[], buckets: number): number[] {
  const totals = new Array<number>(buckets).fill(0);
  for (const s of series) {
    for (let i = 0; i < buckets; i++) {
      const total = totals[i];
      const value = s.values[i];
      if (total !== undefined && value !== undefined) {
        totals[i] = total + value;
      }
    }
  }
  return totals;
}

/** RGB for the default background when transparency is off. */
const BACKGROUND_RGB: [number, number, number] = [30, 30, 30];

/** Options for {@link rasterizeChart}. */
export type RasterizeOpts = {
  /** Target canvas width in pixels. */
  width: number;
  /** Target canvas height in pixels. */
  height: number;
  /** Leave the background transparent instead of filling it. */
  backgroundTransparent?: boolean;
};

/**
 * Rasterize a chart model into an RGBA pixel canvas at the given resolution.
 *
 * This is the pixel core: the resolution is chosen by the caller for its
 * output target (sixel cell pixels, or an ASCII cell-grid multiple). Returns
 * `undefined` when the model has no buckets to draw.
 */
export function rasterizeChart(
  model: ChartModel,
  opts: RasterizeOpts
): DecodedImage | undefined {
  const width = Math.max(16, Math.floor(opts.width));
  const height = Math.max(8, Math.floor(opts.height));
  if (model.buckets === 0) {
    return;
  }

  // Each column needs at least a 1px bar plus a 1px gap, so more buckets than
  // ~half the canvas width would push later columns off-canvas and clip them.
  // Downsample to fit, mirroring what the ASCII sparkline path already does.
  const fitted = fitModelToWidth(model, width);

  const transparent = opts.backgroundTransparent ?? true;
  const img = createPixelCanvas({
    width,
    height,
    background: transparent ? undefined : BACKGROUND_RGB,
  });
  const layout = computeBarLayout(width, fitted.buckets);

  if (fitted.kind === "categorical") {
    drawCategoricalBars(img, fitted, height, layout);
  } else if (fitted.stacked) {
    drawStackedColumns(img, fitted, height, layout);
  } else {
    drawBars(img, fitted, height, layout);
  }

  return img;
}

/**
 * Downsample a model's series so the bucket count fits the canvas: with a 1px
 * bar and 1px gap each column needs ~2px, so cap buckets at `width / 2`.
 * Returns the model unchanged when it already fits.
 */
function fitModelToWidth(model: ChartModel, width: number): ChartModel {
  const maxBuckets = Math.max(1, Math.floor(width / 2));
  if (model.buckets <= maxBuckets || model.kind === "categorical") {
    return model;
  }
  const series = model.series.map((s) => ({
    label: s.label,
    values: downsample(s.values, maxBuckets),
  }));
  const buckets = Math.max(...series.map((s) => s.values.length));
  return { ...model, series, buckets };
}

/** Gap and bar width for evenly distributed columns. */
type BarLayout = {
  gap: number;
  barWidth: number;
};

/** Compute the gap and width for evenly distributed bars. */
function computeBarLayout(width: number, count: number): BarLayout {
  const gap = Math.max(1, Math.floor(width / count / 8));
  const barWidth = Math.max(1, Math.floor((width - (count - 1) * gap) / count));
  return { gap, barWidth };
}

/** Draw single-series bars into the canvas. */
function drawBars(
  img: DecodedImage,
  model: ChartModel,
  height: number,
  layout: BarLayout
): void {
  const series = model.series[0];
  if (!series) {
    return;
  }
  const color = hexToRgb(seriesColor(series.label, 0));

  for (let i = 0; i < series.values.length; i++) {
    const value = series.values[i] ?? 0;
    const h = Math.round((value / model.maxVal) * height);
    const x0 = i * (layout.barWidth + layout.gap);
    drawPixelRect(img, {
      x: x0,
      y: height - h,
      width: layout.barWidth,
      height: h,
      color,
    });
  }
}

/** Draw stacked multi-series columns into the canvas. */
function drawStackedColumns(
  img: DecodedImage,
  model: ChartModel,
  height: number,
  layout: BarLayout
): void {
  for (let b = 0; b < model.buckets; b++) {
    const x0 = b * (layout.barWidth + layout.gap);
    let yBottom = height;

    for (let s = 0; s < model.series.length; s++) {
      const series = model.series[s];
      if (!series) {
        continue;
      }
      const value = series.values[b] ?? 0;
      if (value <= 0 || yBottom <= 0) {
        continue;
      }

      const segmentHeight = Math.min(
        yBottom,
        Math.max(1, Math.round((value / model.maxVal) * height))
      );
      const yTop = Math.max(0, yBottom - segmentHeight);
      drawPixelRect(img, {
        x: x0,
        y: yTop,
        width: layout.barWidth,
        height: yBottom - yTop,
        color: hexToRgb(seriesColor(series.label, s)),
      });
      yBottom = yTop;
    }
  }
}

/** Draw one independently scaled bar for every category. */
function drawCategoricalBars(
  image: DecodedImage,
  model: ChartModel,
  height: number,
  layout: BarLayout
): void {
  for (let index = 0; index < model.series.length; index += 1) {
    const series = model.series[index];
    if (!series) {
      continue;
    }
    const value = series.values[0] ?? 0;
    const barHeight = Math.min(
      height,
      Math.max(0, Math.round((value / model.maxVal) * height))
    );
    drawPixelRect(image, {
      x: index * (layout.barWidth + layout.gap),
      y: height - barHeight,
      width: layout.barWidth,
      height: barHeight,
      color: hexToRgb(seriesColor(series.label, index)),
    });
  }
}

/**
 * Blue→red gradient for the 5 heatmap intensity buckets (matches the ASCII
 * color ramp). Index 0 is the empty/zero cell.
 */
const HEATMAP_EMPTY_COLOR: [number, number, number] = [60, 60, 80];
const HEATMAP_CELL_COLORS: [number, number, number][] = [
  HEATMAP_EMPTY_COLOR,
  [80, 120, 200],
  [120, 180, 120],
  [220, 160, 60],
  [220, 60, 60],
];

/** Rasterize a heatmap grid into a pixel canvas (one colored cell per bucket). */
export function rasterizeHeatmap(
  model: HeatmapModel,
  opts: RasterizeOpts
): DecodedImage | undefined {
  if (model.buckets === 0 || model.rows.length === 0) {
    return;
  }
  const width = Math.max(16, Math.floor(opts.width));
  const height = Math.max(8, Math.floor(opts.height));
  const transparent = opts.backgroundTransparent ?? true;
  const img = createPixelCanvas({
    width,
    height,
    background: transparent ? undefined : BACKGROUND_RGB,
  });

  const rows = model.rows.length;
  const cols = model.buckets;
  const cellW = Math.max(1, Math.floor(width / cols));
  const cellH = Math.max(1, Math.floor(height / rows));

  for (let r = 0; r < rows; r += 1) {
    const rowVals = model.rows[r] ?? [];
    for (let c = 0; c < cols; c += 1) {
      const norm = (rowVals[c] ?? 0) / model.maxVal;
      // reuse the same 5-bucket intensity mapping as the ASCII renderer
      const bucket = Math.min(4, Math.floor(norm * 5));
      drawPixelRect(img, {
        x: c * cellW,
        y: r * cellH,
        width: cellW,
        height: cellH,
        color: HEATMAP_CELL_COLORS[bucket] ?? HEATMAP_EMPTY_COLOR,
      });
    }
  }
  return img;
}
