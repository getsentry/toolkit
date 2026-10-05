/**
 * Full-dashboard sixel compositor.
 *
 * A sixel sequence advances the terminal cursor, so individual images cannot
 * safely participate in the character framebuffer. This module rasterizes the
 * complete dashboard grid into one positioned image instead. Every widget is
 * therefore rendered by the same sixel output path, including neighboring
 * widgets on the same grid row.
 */

import type { WidgetDataResult } from "../../types/dashboard.js";
import { type DecodedImage, encodeImageToSixel } from "../sixel-image.js";
import {
  buildCategoricalChartModel,
  buildChartModel,
  buildHeatmapModel,
  hexToRgb,
  rasterizeChart,
  rasterizeHeatmap,
  seriesColor,
} from "./chart-core.js";
import {
  blitPixelImage,
  createPixelCanvas,
  drawPixelRect,
  drawPixelText,
  type Rgb,
} from "./pixel-canvas.js";

/** Number of dashboard grid columns. */
const GRID_COLUMNS = 6;

/** Terminal rows occupied by one dashboard grid-height unit. */
const LINES_PER_GRID_UNIT = 6;

/** Prevent a pathological dashboard from producing an unbounded DCS payload. */
const MAX_CANVAS_PIXELS = 8_000_000;

/** Muted frame color that works on light and dark terminal backgrounds. */
const FRAME_COLOR: Rgb = [128, 128, 128];

/** Default text color for title, tables, and other non-chart content. */
const TEXT_COLOR: Rgb = [224, 224, 224];

/** ANSI CSI, OSC, and DCS escape sequences emitted by text formatters. */
const TERMINAL_ESCAPE_RE = new RegExp(
  `${String.fromCharCode(27)}(?:\\[[0-?]*[ -/]*[@-~]|\\][\\s\\S]*?(?:${String.fromCharCode(7)}|${String.fromCharCode(27)}\\\\)|P[\\s\\S]*?${String.fromCharCode(27)}\\\\)`,
  "g"
);

/** Aggregate function and its simple arguments in a raw query expression. */
const AGGREGATE_LABEL_RE = /^([a-z][a-z0-9_]*)\(([^()]*)\)/i;

/** A widget layout used by the dashboard grid. */
export type SixelWidgetLayout = {
  /** Left grid column. */
  x: number;
  /** Top grid row. */
  y: number;
  /** Width in grid columns. */
  w: number;
  /** Height in grid units. */
  h: number;
};

/** Minimum dashboard widget fields needed by the sixel compositor. */
export type SixelDashboardWidget = {
  /** Widget title displayed in the top frame line. */
  title: string;
  /** Sentry display type, used to distinguish categorical bars. */
  displayType: string;
  /** Grid position when supplied by the dashboard API. */
  layout?: SixelWidgetLayout;
  /** Fully resolved query result. */
  data: WidgetDataResult;
};

/** Minimum dashboard fields needed by the sixel compositor. */
export type SixelDashboardData = {
  /** Resolved widgets to compose. */
  widgets: SixelDashboardWidget[];
};

/** Options supplied by the terminal capability layer and dashboard formatter. */
export type RenderSixelDashboardOptions = {
  /** Complete dashboard width in device pixels. */
  pixelWidth: number;
  /** Width of one terminal cell in device pixels. */
  cellWidth: number;
  /** Height of one terminal cell in device pixels. */
  cellHeight: number;
  /** Render text-only widget content in terminal-cell lines. */
  renderTextContent: (
    widget: SixelDashboardWidget,
    innerWidth: number,
    contentHeight: number
  ) => string[];
  /**
   * Encode the finished RGBA canvas to a terminal graphics escape string.
   * Defaults to sixel; callers pass a kitty encoder on kitty-capable terminals.
   */
  encodeImage?: (image: DecodedImage) => string | undefined;
};

/** A widget paired with the layout used for the final composite. */
type PositionedWidget = {
  widget: SixelDashboardWidget;
  layout: SixelWidgetLayout;
};

/** Result of composing the dashboard image, including a safe fallback reason. */
export type RenderSixelDashboardResult =
  | { output: string }
  | { reason: string };

/** Render every dashboard widget into one terminal-positioned sixel image. */
export function renderDashboardAsSixel(
  data: SixelDashboardData,
  options: RenderSixelDashboardOptions
): RenderSixelDashboardResult {
  const widgets = positionWidgets(data.widgets);
  if (widgets.length === 0) {
    return { reason: "no dashboard widgets" };
  }

  const pixelWidth = Math.max(1, Math.floor(options.pixelWidth));
  const gridHeight = Math.max(
    ...widgets.map((item) => item.layout.y + item.layout.h)
  );
  const pixelHeight = gridHeight * LINES_PER_GRID_UNIT * options.cellHeight;
  const canvasPixels = pixelWidth * pixelHeight;
  if (canvasPixels > MAX_CANVAS_PIXELS) {
    return {
      reason:
        `canvas ${pixelWidth}x${pixelHeight} ` +
        `(${(canvasPixels / 1_000_000).toFixed(2)}M pixels) exceeds the ` +
        `${MAX_CANVAS_PIXELS / 1_000_000}M pixel limit`,
    };
  }

  const image = createPixelCanvas({ width: pixelWidth, height: pixelHeight });
  for (const positioned of widgets) {
    drawWidget(image, positioned, options);
  }
  // The canvas is already bounded by MAX_CANVAS_PIXELS and must match the
  // terminal width exactly to preserve the dashboard grid.
  const encode =
    options.encodeImage ?? ((img) => encodeImageToSixel(img, img.width, true));
  const output = encode(image);
  return output
    ? { output }
    : { reason: "graphics encoder produced no output" };
}

/** Place layout-less widgets beneath the explicit dashboard grid. */
function positionWidgets(widgets: SixelDashboardWidget[]): PositionedWidget[] {
  let nextY = Math.max(
    0,
    ...widgets.flatMap((widget) =>
      widget.layout ? [widget.layout.y + widget.layout.h] : []
    )
  );

  return widgets.map((widget) => {
    if (widget.layout) {
      return { widget, layout: widget.layout };
    }
    const layout = { x: 0, y: nextY, w: GRID_COLUMNS, h: 1 };
    nextY += layout.h;
    return { widget, layout };
  });
}

/** Draw one fully-contained dashboard widget into the composite canvas. */
function drawWidget(
  image: ReturnType<typeof createPixelCanvas>,
  positioned: PositionedWidget,
  options: RenderSixelDashboardOptions
): void {
  const { widget, layout } = positioned;
  const x = Math.floor((layout.x / GRID_COLUMNS) * image.width);
  const y = layout.y * LINES_PER_GRID_UNIT * options.cellHeight;
  const width = Math.max(
    1,
    Math.floor((layout.w / GRID_COLUMNS) * image.width)
  );
  const height = Math.max(
    1,
    layout.h * LINES_PER_GRID_UNIT * options.cellHeight
  );
  drawFrame(image, { x, y, width, height, title: widget.title, options });

  const contentX = x + options.cellWidth;
  const contentY = y + options.cellHeight;
  const contentWidth = Math.max(1, width - 2 * options.cellWidth);
  const contentHeight = Math.max(1, height - 2 * options.cellHeight);

  if (widget.data.type === "timeseries") {
    drawChartContent(image, {
      data: widget.data,
      categorical: widget.displayType === "categorical_bar",
      heatmap: widget.displayType === "heatmap",
      x: contentX,
      y: contentY,
      width: contentWidth,
      height: contentHeight,
      cellWidth: options.cellWidth,
      cellHeight: options.cellHeight,
    });
    return;
  }

  const innerWidth = Math.max(1, Math.floor(contentWidth / options.cellWidth));
  const lineCount = Math.max(1, Math.floor(contentHeight / options.cellHeight));
  const lines = options.renderTextContent(widget, innerWidth, lineCount);
  for (let row = 0; row < Math.min(lineCount, lines.length); row += 1) {
    drawPixelText(image, stripTerminalEscapes(lines[row] ?? ""), {
      x: contentX,
      y: contentY + row * options.cellHeight,
      cellWidth: options.cellWidth,
      cellHeight: options.cellHeight,
      maxColumns: innerWidth,
      color: TEXT_COLOR,
    });
  }
}

/** Draw a single-pixel widget frame and its title. */
function drawFrame(
  image: ReturnType<typeof createPixelCanvas>,
  options: {
    x: number;
    y: number;
    width: number;
    height: number;
    title: string;
    options: RenderSixelDashboardOptions;
  }
): void {
  const { x, y, width, height, title } = options;
  drawPixelRect(image, { x, y, width, height: 1, color: FRAME_COLOR });
  drawPixelRect(image, {
    x,
    y: y + height - 1,
    width,
    height: 1,
    color: FRAME_COLOR,
  });
  drawPixelRect(image, { x, y, width: 1, height, color: FRAME_COLOR });
  drawPixelRect(image, {
    x: x + width - 1,
    y,
    width: 1,
    height,
    color: FRAME_COLOR,
  });
  drawPixelText(image, title, {
    x: x + options.options.cellWidth,
    y,
    cellWidth: options.options.cellWidth,
    cellHeight: options.options.cellHeight,
    maxColumns: Math.max(1, Math.floor(width / options.options.cellWidth) - 2),
    color: TEXT_COLOR,
  });
}

/** Early-out for empty data or heatmap (which has its own rasterizer). */
function tryRenderSpecialChart(
  image: ReturnType<typeof createPixelCanvas>,
  options: Parameters<typeof drawChartContent>[1]
): boolean {
  if (options.data.series.length === 0) {
    const label = "NO DATA";
    const maxColumns = Math.max(
      1,
      Math.floor(options.width / options.cellWidth)
    );
    const labelColumns = Math.min(label.length, maxColumns);
    drawPixelText(image, label, {
      x:
        options.x +
        Math.max(
          0,
          Math.floor((options.width - labelColumns * options.cellWidth) / 2)
        ),
      y:
        options.y +
        Math.max(0, Math.floor((options.height - options.cellHeight) / 2)),
      cellWidth: options.cellWidth,
      cellHeight: options.cellHeight,
      maxColumns,
      color: FRAME_COLOR,
    });
    return true;
  }
  if (options.heatmap) {
    const hm = buildHeatmapModel(options.data);
    if (hm) {
      const chart = rasterizeHeatmap(hm, {
        width: options.width,
        height: options.height,
        backgroundTransparent: true,
      });
      if (chart) {
        blitPixelImage(image, chart, options.x, options.y);
        return true;
      }
    }
  }
  return false;
}

/** Draw chart bars, axes, and a series legend into a widget's content region. */
function drawChartContent(
  image: ReturnType<typeof createPixelCanvas>,
  options: {
    data: Extract<WidgetDataResult, { type: "timeseries" }>;
    categorical: boolean;
    heatmap: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    cellWidth: number;
    cellHeight: number;
  }
): void {
  if (tryRenderSpecialChart(image, options)) {
    return;
  }
  const model = options.categorical
    ? buildCategoricalChartModel(options.data)
    : buildChartModel(options.data);
  if (!model) {
    return;
  }
  const contentRows = Math.max(
    1,
    Math.floor(options.height / options.cellHeight)
  );
  const hasLegend = contentRows >= 4;
  const hasAxisLabels = contentRows >= 5;
  const gutterColumns = options.width >= options.cellWidth * 12 ? 5 : 0;
  const gutterWidth = gutterColumns * options.cellWidth;
  const footerHeight =
    (hasLegend ? 1 : 0) * options.cellHeight +
    (hasAxisLabels ? 1 : 0) * options.cellHeight;
  const chartX = options.x + gutterWidth;
  const chartWidth = options.width - gutterWidth;
  const chartHeight = options.height - footerHeight;
  // rasterizeChart enforces a 16x8 minimum, which must never escape this
  // widget's allocated rectangle on exceptionally narrow terminals.
  if (chartWidth < 16 || chartHeight < 8) {
    return;
  }
  const chart = rasterizeChart(model, {
    width: chartWidth,
    height: chartHeight,
    backgroundTransparent: true,
  });
  if (!chart) {
    return;
  }

  blitPixelImage(image, chart, chartX, options.y);
  drawPixelRect(image, {
    x: chartX,
    y: options.y + chartHeight - 1,
    width: chartWidth,
    height: 1,
    color: FRAME_COLOR,
  });
  if (gutterWidth > 0) {
    drawPixelRect(image, {
      x: chartX,
      y: options.y,
      width: 1,
      height: chartHeight,
      color: FRAME_COLOR,
    });
    drawPixelText(
      image,
      formatChartValue(model.maxVal, options.data.series[0]?.unit),
      {
        x: options.x,
        y: options.y,
        cellWidth: options.cellWidth,
        cellHeight: options.cellHeight,
        maxColumns: gutterColumns,
        color: FRAME_COLOR,
      }
    );
    drawPixelText(image, "0", {
      x: options.x,
      y: options.y + chartHeight - options.cellHeight,
      cellWidth: options.cellWidth,
      cellHeight: options.cellHeight,
      maxColumns: gutterColumns,
      color: FRAME_COLOR,
    });
  }

  let footerY = options.y + chartHeight;
  if (hasAxisLabels) {
    drawChartLabels(image, {
      modelKind: model.kind,
      series: model.series,
      data: options.data,
      x: chartX,
      y: footerY,
      width: chartWidth,
      cellWidth: options.cellWidth,
      cellHeight: options.cellHeight,
    });
    footerY += options.cellHeight;
  }
  if (hasLegend) {
    drawLegend(image, {
      series: model.series,
      x: options.x,
      y: footerY,
      width: options.width,
      cellWidth: options.cellWidth,
      cellHeight: options.cellHeight,
    });
  }
}

/** Draw a concise first/last x-axis label for time and categorical charts. */
function drawChartLabels(
  image: ReturnType<typeof createPixelCanvas>,
  options: {
    modelKind: "timeseries" | "categorical";
    series: { label: string; values: number[] }[];
    data: Extract<WidgetDataResult, { type: "timeseries" }>;
    x: number;
    y: number;
    width: number;
    cellWidth: number;
    cellHeight: number;
  }
): void {
  const columns = Math.max(1, Math.floor(options.width / options.cellWidth));
  const firstTimestamp = options.data.series[0]?.values[0]?.timestamp;
  const lastTimestamp = options.data.series[0]?.values.at(-1)?.timestamp;
  const spanDays =
    typeof firstTimestamp === "number" && typeof lastTimestamp === "number"
      ? (lastTimestamp - firstTimestamp) / (24 * 60 * 60)
      : 0;
  const first =
    options.modelKind === "categorical"
      ? options.series[0]?.label
      : formatTimestamp(firstTimestamp, spanDays);
  const last =
    options.modelKind === "categorical"
      ? options.series.at(-1)?.label
      : formatTimestamp(lastTimestamp, spanDays);
  drawPixelText(image, first ?? "", {
    x: options.x,
    y: options.y,
    cellWidth: options.cellWidth,
    cellHeight: options.cellHeight,
    maxColumns: Math.max(1, Math.floor(columns / 2)),
    color: FRAME_COLOR,
  });
  const lastColumns = Math.min(Math.floor(columns / 2), (last ?? "").length);
  drawPixelText(image, last ?? "", {
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
    series: { label: string; values: number[] }[];
    x: number;
    y: number;
    width: number;
    cellWidth: number;
    cellHeight: number;
  }
): void {
  let column = 0;
  const maxColumns = Math.max(1, Math.floor(options.width / options.cellWidth));
  for (let index = 0; index < options.series.length; index += 1) {
    const series = options.series[index];
    if (!series || column >= maxColumns) {
      break;
    }
    const availableColumns = maxColumns - column - 2;
    const label = truncateLegendLabel(
      formatLegendLabel(series.label),
      Math.min(18, availableColumns)
    );
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

/** Turn raw aggregate expressions into concise, readable legend labels. */
export function formatLegendLabel(label: string): string {
  const aggregate = AGGREGATE_LABEL_RE.exec(label);
  if (aggregate) {
    const operation = aggregate[1] ?? label;
    const arguments_ =
      aggregate[2]?.split(",").map((argument) => argument.trim()) ?? [];
    const metric = arguments_[0] === "value" ? arguments_[1] : arguments_[0];
    return metric ? `${operation} ${metric}` : operation;
  }
  if (label.startsWith("equation|")) {
    return "equation";
  }
  return label;
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

/** Format a number compactly enough for the chart-axis gutter. */
function formatChartValue(
  value: number,
  unit: string | null | undefined
): string {
  const formatted = new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

/** Format timestamps using the same span-aware form as the character dashboard. */
export function formatTimestamp(
  timestamp: number | undefined,
  spanDays: number
): string {
  if (timestamp === undefined) {
    return "";
  }
  const date = new Date(timestamp * 1000);
  if (spanDays < 2) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  if (spanDays <= 30) {
    return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
  }
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[date.getMonth()] ?? "???"} ${date.getDate()}`;
}

/** Remove terminal formatting sequences before drawing text into a bitmap. */
function stripTerminalEscapes(value: string): string {
  return value.replace(TERMINAL_ESCAPE_RE, "");
}
