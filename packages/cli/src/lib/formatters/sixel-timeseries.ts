/**
 * Timeseries → sixel chart renderer.
 *
 * Thin wrapper over the shared chart core (see {@link buildChartModel} and
 * {@link rasterizeChart}): builds the resolution-independent model, rasterizes
 * it at the caller's pixel resolution, then reuses the existing
 * {@link encodeImageToSixel} encoder for a terminal-ready DCS escape sequence.
 */

import type { TimeseriesResult } from "../../types/dashboard.js";
import { encodeImageToSixel } from "../sixel-image.js";
import { buildChartModel, rasterizeChart } from "./chart-core.js";

export type RenderSixelOpts = {
  /** Maximum pixel width of the rendered chart. */
  maxPixelWidth?: number;
  /** Maximum pixel height of the rendered chart. */
  maxPixelHeight?: number;
  /** Leave the background transparent instead of filling it. */
  backgroundTransparent?: boolean;
};

/** Default chart bitmap dimensions. */
const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 120;

/**
 * Render a timeseries result as an inline sixel image.
 *
 * Returns a DCS sixel escape sequence, or `undefined` when the data is empty
 * or the bitmap has no drawable pixels.
 */
export function renderTimeseriesAsSixel(
  data: TimeseriesResult,
  opts: RenderSixelOpts = {}
): string | undefined {
  const {
    maxPixelWidth = DEFAULT_WIDTH,
    maxPixelHeight = DEFAULT_HEIGHT,
    backgroundTransparent = true,
  } = opts;

  const model = buildChartModel(data);
  if (!model) {
    return;
  }

  const img = rasterizeChart(model, {
    width: maxPixelWidth,
    height: maxPixelHeight,
    backgroundTransparent,
  });
  if (!img) {
    return;
  }

  return encodeImageToSixel(img, img.width);
}
