/**
 * Explore's adapter to the shared raster engine. Each aggregate keeps its own
 * scale; missing and incomplete buckets keep their positions as gaps. Decline
 * graphics when the engine would need to average buckets or change their meaning.
 */

import type { EventsTimeSeriesResponse } from "../api/explore.js";
import { encodeImageToKitty } from "../kitty-image.js";
import {
  graphicsCellSize,
  selectGraphicsFormat,
  terminalPixelWidth,
  tmuxKittyPlacement,
} from "../sixel.js";
import { encodeImageToSixel } from "../sixel-image.js";
import { renderChartWithLabels } from "./chart-presentation.js";
import { formatCellValue } from "./meta-table.js";
import { appendUnitSuffix } from "./numbers.js";
import { isPlainOutput } from "./plain-detect.js";
import { formatUtcTimestamp } from "./time-utils.js";

type TimeSeries = EventsTimeSeriesResponse["timeSeries"][number];

/** Render a single aggregate using terminal graphics, or defer to its table. */
export function formatExploreTimeSeriesChart(
  series: TimeSeries,
): string | undefined {
  const columns = process.stdout.columns;
  if (isPlainOutput() || !columns || columns < 1) {
    return;
  }
  const format = selectGraphicsFormat();
  const cell = graphicsCellSize();
  if (!format || !cell) {
    return;
  }
  const width = Math.floor(
    Math.min(terminalPixelWidth(columns) ?? columns * cell.cellWidth, 2560),
  );
  const height = Math.floor(Math.min(cell.cellHeight * 8, 240));
  const { values, meta } = series;
  const first = values[0];
  const last = values.at(-1);
  if (
    !first ||
    !last ||
    width < 16 ||
    height < 8 ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(meta.interval) ||
    meta.interval <= 0 ||
    values.some(
      (bucket, index) =>
        !Number.isFinite(bucket.timestamp) ||
        bucket.timestamp !== first.timestamp + index * meta.interval ||
        (bucket.value !== null &&
          (typeof bucket.value !== "number" ||
            !Number.isFinite(bucket.value) ||
            bucket.value < 0)),
    )
  ) {
    return;
  }
  const plotted = values.map((bucket) =>
    bucket.incomplete || typeof bucket.value !== "number" ? null : bucket.value,
  );
  const complete = plotted.filter((value) => value !== null);
  if (complete.length === 0) {
    return;
  }
  const maximum = Math.max(...complete);
  const maximumLabel = formatMaximum(maximum, series);
  const firstLabel = `${formatUtcTimestamp(first.timestamp)} UTC`;
  const lastLabel = `${formatUtcTimestamp(last.timestamp)} UTC`;
  const gutterColumns = Math.max(5, maximumLabel.length + 1);
  const plotWidth = width - gutterColumns * cell.cellWidth - 1;
  // Keep the full value scale and UTC labels readable; a clipped date or unit
  // is less useful than the table on narrow or unusually tall-cell terminals.
  if (
    plotWidth <
      2 * Math.max(firstLabel.length, lastLabel.length) * cell.cellWidth ||
    height < 5 * cell.cellHeight
  ) {
    return;
  }
  const image = renderChartWithLabels(
    {
      kind: "timeseries",
      series: [{ label: series.yAxis, values: plotted }],
      buckets: values.length,
      maxVal: maximum || 1,
      stacked: false,
    },
    {
      width,
      height,
      ...cell,
      gutterColumns,
      maximumLabel,
      firstLabel,
      lastLabel,
      minBarHeight: 1,
      // Percentiles and unique counts cannot be averaged when axes reduce the
      // plot width. Let the shared renderer decline graphics in that case.
      allowDownsampling: false,
    },
  );
  if (!image) {
    return;
  }
  return (
    (format === "kitty"
      ? encodeImageToKitty(image, width, true, tmuxKittyPlacement(columns))
      : encodeImageToSixel(image, width, true)) || undefined
  );
}

function formatMaximum(value: number, series: TimeSeries): string {
  const { valueType, valueUnit } = series.meta;
  // The table formatter rounds to two decimals. Keep a sub-centesimal scale
  // legible instead of labelling a nonzero chart maximum as zero.
  if (value > 0 && value < 0.01) {
    if (valueType === "percentage") {
      return `${value * 100}%`;
    }
    return valueType === "duration" || valueType === "size"
      ? appendUnitSuffix(String(value), valueUnit)
      : String(value);
  }
  return formatCellValue(value, valueType, valueUnit);
}
