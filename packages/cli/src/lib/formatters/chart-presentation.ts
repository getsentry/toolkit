/**
 * Shared chart presentation for terminal graphics.
 *
 * Composes the existing bar rasterizer with axes, caller-formatted labels, and
 * a series legend. Data conversion, units, and time zones belong to the caller.
 */

import type { DecodedImage } from "../sixel-image.js";
import {
  type ChartModel,
  hexToRgb,
  rasterizeChart,
  seriesColor,
} from "./chart-core.js";
import {
  blitPixelImage,
  createPixelCanvas,
  drawPixelRect,
  drawPixelText,
  type Rgb,
} from "./pixel-canvas.js";

/** Muted axes that remain visible on light and dark terminal backgrounds. */
const FRAME_COLOR: Rgb = [128, 128, 128];

/** The same text color used by the dashboard compositor. */
const TEXT_COLOR: Rgb = [224, 224, 224];

/** Aggregate function and its simple arguments in a raw query expression. */
const AGGREGATE_LABEL_RE = /^([a-z][a-z0-9_]*)\(([^()]*)\)/i;

/** Presentation and fitting options for a chart with axes and a legend. */
export type ChartPresentationOptions = {
  /** Total canvas width in pixels, including the value-axis gutter. */
  width: number;
  /** Total canvas height in pixels, including time labels and the legend. */
  height: number;
  /** Width of one terminal text cell in pixels. */
  cellWidth: number;
  /** Height of one terminal text cell in pixels. */
  cellHeight: number;
  /** Number of text cells reserved for the value axis; zero hides that axis. */
  gutterColumns: number;
  /** Value-axis maximum already formatted with the caller's units/precision. */
  maximumLabel: string;
  /** First x-axis label; omitted values leave that label empty. */
  firstLabel?: string;
  /** Last x-axis label; omitted values leave that label empty. */
  lastLabel?: string;
  /** Minimum single-series bar height in pixels; nulls stay empty. Default: 0. */
  minBarHeight?: number;
  /** Allow the core's numeric bucket averaging to fit the plot. Default: true. */
  allowDownsampling?: boolean;
};

/**
 * Render a chart, its axes, and a colored legend into one transparent canvas.
 * Returns undefined when the plot cannot fit or disallowed averaging is needed.
 * Labels and legend use the dashboard's existing height-based visibility rules.
 */
export function renderChartWithLabels(
  model: ChartModel,
  options: ChartPresentationOptions,
): DecodedImage | undefined {
  const { cellWidth, cellHeight, gutterColumns } = options;
  const width = Math.floor(options.width);
  const height = Math.floor(options.height);
  const contentRows = Math.max(1, Math.floor(height / cellHeight));
  const hasLegend = contentRows >= 4;
  const hasAxisLabels = contentRows >= 5;
  const gutterWidth = gutterColumns * cellWidth;
  const footerHeight =
    (hasLegend ? 1 : 0) * cellHeight + (hasAxisLabels ? 1 : 0) * cellHeight;
  // Axes occupy their own pixels so a zero/tiny-value tick never covers a gap.
  const plotX = gutterWidth + (gutterColumns > 0 ? 1 : 0);
  const plotWidth = Math.floor(width - plotX);
  const plotHeight = Math.floor(height - footerHeight - 1);
  if (
    plotWidth < 16 ||
    plotHeight < 8 ||
    (options.allowDownsampling === false &&
      model.kind === "timeseries" &&
      model.buckets > Math.floor(plotWidth / 2))
  ) {
    return;
  }
  const chart = rasterizeChart(model, {
    width: plotWidth,
    height: plotHeight,
    backgroundTransparent: true,
    minBarHeight: options.minBarHeight,
  });
  if (!chart) {
    return;
  }

  const image = createPixelCanvas({ width, height });
  blitPixelImage(image, chart, plotX, 0);
  drawPixelRect(image, {
    x: gutterWidth,
    y: plotHeight,
    width: width - gutterWidth,
    height: 1,
    color: FRAME_COLOR,
  });
  if (gutterColumns > 0) {
    drawPixelRect(image, {
      x: gutterWidth,
      y: 0,
      width: 1,
      height: plotHeight + 1,
      color: FRAME_COLOR,
    });
    drawPixelText(image, options.maximumLabel, {
      x: 0,
      y: 0,
      cellWidth,
      cellHeight,
      maxColumns: gutterColumns,
      color: FRAME_COLOR,
    });
    drawPixelText(image, "0", {
      x: 0,
      y: plotHeight - cellHeight,
      cellWidth,
      cellHeight,
      maxColumns: gutterColumns,
      color: FRAME_COLOR,
    });
  }

  let footerY = plotHeight + 1;
  if (hasAxisLabels) {
    drawChartLabels(image, {
      first: options.firstLabel ?? "",
      last: options.lastLabel ?? "",
      x: plotX,
      y: footerY,
      width: plotWidth,
      cellWidth,
      cellHeight,
    });
    footerY += cellHeight;
  }
  if (hasLegend) {
    drawLegend(image, {
      series: model.series,
      x: 0,
      y: footerY,
      width,
      cellWidth,
      cellHeight,
    });
  }
  return image;
}

/** Draw concise first/last labels without interpreting the caller's data. */
function drawChartLabels(
  image: DecodedImage,
  options: {
    first: string;
    last: string;
    x: number;
    y: number;
    width: number;
    cellWidth: number;
    cellHeight: number;
  },
): void {
  const columns = Math.max(1, Math.floor(options.width / options.cellWidth));
  drawPixelText(image, options.first, {
    x: options.x,
    y: options.y,
    cellWidth: options.cellWidth,
    cellHeight: options.cellHeight,
    maxColumns: Math.max(1, Math.floor(columns / 2)),
    color: FRAME_COLOR,
  });
  const lastColumns = Math.min(Math.floor(columns / 2), options.last.length);
  drawPixelText(image, options.last, {
    x: options.x + Math.max(0, columns - lastColumns) * options.cellWidth,
    y: options.y,
    cellWidth: options.cellWidth,
    cellHeight: options.cellHeight,
    maxColumns: Math.max(1, lastColumns),
    color: FRAME_COLOR,
  });
}

/** Draw colored series keys and labels, clipping safely to the widget width. */
function drawLegend(
  image: ReturnType<typeof createPixelCanvas>,
  options: {
    series: { label: string }[];
    x: number;
    y: number;
    width: number;
    cellWidth: number;
    cellHeight: number;
  },
): void {
  let column = 0;
  const maxColumns = Math.max(1, Math.floor(options.width / options.cellWidth));
  for (let index = 0; index < options.series.length; index += 1) {
    const series = options.series[index];
    if (!series || column >= maxColumns) {
      break;
    }
    const availableColumns = maxColumns - column - 2;
    const { text: label } = formatLegendLabel(series.label, availableColumns);
    const requiredColumns = Math.min(maxColumns, label.length + 2);
    if (column + requiredColumns > maxColumns) {
      break;
    }
    drawPixelRect(image, {
      x: options.x + column * options.cellWidth,
      y: options.y + Math.max(1, Math.floor(options.cellHeight / 3)),
      width: Math.max(2, Math.floor(options.cellWidth / 2)),
      height: Math.max(2, Math.floor(options.cellHeight / 3)),
      color: hexToRgb(seriesColor(series.label, index)),
    });
    drawPixelText(image, label, {
      x: options.x + (column + 1) * options.cellWidth,
      y: options.y,
      cellWidth: options.cellWidth,
      cellHeight: options.cellHeight,
      maxColumns: Math.min(label.length, maxColumns - column - 1),
      color: TEXT_COLOR,
    });
    column += requiredColumns;
  }
}

/** A fitted legend label and whether a caption must retain its full expression. */
export type ChartLegendLabel = {
  /** Text drawn next to the series color key. */
  text: string;
  /** True when arguments, expression terms, or clipped characters are omitted. */
  abbreviated: boolean;
};

/** Compact and fit a legend label, tracking information lost beyond punctuation. */
export function formatLegendLabel(
  label: string,
  availableColumns = 18,
): ChartLegendLabel {
  let text = label;
  let abbreviated = false;
  const aggregate = AGGREGATE_LABEL_RE.exec(label);
  if (aggregate) {
    const operation = aggregate[1] ?? label;
    const arguments_ =
      aggregate[2]?.split(",").map((argument) => argument.trim()) ?? [];
    const metric = arguments_[0] === "value" ? arguments_[1] : arguments_[0];
    text = metric ? `${operation} ${metric}` : operation;
    abbreviated =
      aggregate[0] !== label ||
      arguments_.length > 1 ||
      arguments_[0] === "value";
  } else if (label.startsWith("equation|")) {
    text = "equation";
    abbreviated = true;
  }
  const fitted = truncateLegendLabel(text, Math.min(18, availableColumns));
  return { text: fitted, abbreviated: abbreviated || fitted !== text };
}

/** Clip a legend label without leaving a partial aggregate expression. */
function truncateLegendLabel(label: string, maxColumns: number): string {
  if (label.length <= maxColumns) {
    return label;
  }
  if (maxColumns <= 3) {
    return label.slice(0, Math.max(0, maxColumns));
  }
  return `${label.slice(0, maxColumns - 3)}...`;
}
