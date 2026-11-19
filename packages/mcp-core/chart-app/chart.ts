/**
 * Draws a render_sentry_chart result as SVG: one area (or line, when there
 * are several series) per series, a y grid, time labels, a hatched band over
 * buckets that are still filling, and a hover tooltip. Values come from an
 * untrusted tool result, so text only ever goes in through textContent.
 */
import type { ChartResult } from "../src/tools/support/chart/schema";

const SVG_NS = "http://www.w3.org/2000/svg";
const HEIGHT = 220;
const MARGIN = { top: 8, right: 8, bottom: 22, left: 48 };
export const SERIES_COLORS = [
  "#7553ff",
  "#f2b712",
  "#ff45a8",
  "#3fb68b",
  "#2ba1db",
];

const DURATION_MS: Record<string, number> = {
  nanosecond: 1e-6,
  microsecond: 1e-3,
  millisecond: 1,
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
};
const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatValue(value: number, chart: ChartResult): string {
  if (chart.valueType === "duration") {
    const ms = value * (DURATION_MS[chart.valueUnit ?? "millisecond"] ?? 1);
    if (Math.abs(ms) < 1000) return `${Number(ms.toFixed(1))}ms`;
    if (Math.abs(ms) < 60_000) return `${Number((ms / 1000).toFixed(2))}s`;
    return `${Number((ms / 60_000).toFixed(1))}min`;
  }
  if (chart.valueType === "percentage") {
    return `${Number((value * 100).toFixed(2))}%`;
  }
  if (chart.valueType === "size") {
    let size = value;
    let unit = 0;
    while (Math.abs(size) >= 1024 && unit < SIZE_UNITS.length - 1) {
      size /= 1024;
      unit++;
    }
    return `${Number(size.toFixed(1))} ${SIZE_UNITS[unit]}`;
  }
  return compact.format(value);
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  parent?: Element,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value));
  }
  parent?.appendChild(el);
  return el;
}

/** Round step for about `count` gridlines across `range`. */
function niceStep(range: number, count: number): number {
  const raw = range / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const factor = [1, 2, 2.5, 5, 10].find((f) => f * magnitude >= raw) ?? 10;
  return factor * magnitude;
}

export interface TimeFormat {
  locale: string | undefined;
  timeZone: string | undefined;
}

function timeFormatter(spanMs: number, format: TimeFormat) {
  return new Intl.DateTimeFormat(format.locale, {
    timeZone: format.timeZone,
    ...(spanMs <= 2 * 86_400_000
      ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
      : { month: "short", day: "numeric" }),
  });
}

export function formatTooltipTime(time: number, format: TimeFormat): string {
  return new Intl.DateTimeFormat(format.locale, {
    timeZone: format.timeZone,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(time);
}

export interface ValueScale {
  bottom: number;
  top: number;
  step: number;
}

/**
 * The y domain for `values`: round gridline steps from `bottom` to `top`,
 * always including 0 so the baseline is on the chart, whether the values
 * are positive, negative, or both.
 */
export function valueScale(values: readonly number[]): ValueScale {
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const step = max > min ? niceStep(max - min, 4) : 1;
  // `|| 0` turns -0 into 0, so the bottom label never reads "-0".
  const bottom = Math.floor(min / step) * step || 0;
  const top = Math.max(bottom + step, Math.ceil(max / step) * step);
  return { bottom, top, step };
}

/** Where `value` sits in `scale`: 0 at the bottom of the plot, 1 at the top. */
export function scaleFraction(scale: ValueScale, value: number): number {
  return (value - scale.bottom) / (scale.top - scale.bottom);
}

/** Renders the chart into `container`, replacing what was there. */
export function drawChart(
  container: HTMLElement,
  chart: ChartResult,
  format: TimeFormat,
): void {
  container.replaceChildren();
  const width = Math.max(container.clientWidth, 280);
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const times = chart.series[0]?.buckets.map((b) => Date.parse(b.time)) ?? [];
  const first = times[0] ?? 0;
  const last = times.at(-1) ?? first;
  const span = Math.max(last - first, 1);
  const scale = valueScale(
    chart.series.flatMap((s) => s.buckets.map((b) => b.value)),
  );
  const { bottom, top, step } = scale;
  const x = (time: number) =>
    MARGIN.left +
    (times.length > 1 ? ((time - first) / span) * plotWidth : plotWidth / 2);
  const y = (value: number) =>
    MARGIN.top + plotHeight - scaleFraction(scale, value) * plotHeight;

  const root = svg("svg", {
    viewBox: `0 0 ${width} ${HEIGHT}`,
    height: HEIGHT,
    role: "img",
    "aria-label": chart.title,
  });
  const defs = svg("defs", {}, root);
  const hatch = svg(
    "pattern",
    {
      id: "incomplete-hatch",
      width: 6,
      height: 6,
      patternUnits: "userSpaceOnUse",
      patternTransform: "rotate(45)",
    },
    defs,
  );
  svg("line", { x1: 0, y1: 0, x2: 0, y2: 6, "stroke-width": 2 }, hatch);

  const grid = svg("g", { class: "grid axis" }, root);
  const gridlines = Math.round((top - bottom) / step);
  for (let i = 0; i <= gridlines; i++) {
    const value = bottom + i * step;
    svg(
      "line",
      { x1: MARGIN.left, x2: width - MARGIN.right, y1: y(value), y2: y(value) },
      grid,
    );
    const label = svg(
      "text",
      { x: MARGIN.left - 6, y: y(value) + 4, "text-anchor": "end" },
      grid,
    );
    label.textContent = formatValue(value, chart);
  }

  const ticks = svg("g", { class: "axis" }, root);
  const tickFormat = timeFormatter(span, format);
  const tickCount = Math.min(
    times.length,
    Math.max(2, Math.floor(plotWidth / 90)),
  );
  for (let i = 0; i < tickCount; i++) {
    const time = first + (span * i) / Math.max(tickCount - 1, 1);
    const label = svg(
      "text",
      {
        x: x(time),
        y: HEIGHT - 6,
        "text-anchor":
          i === 0 ? "start" : i === tickCount - 1 ? "end" : "middle",
      },
      ticks,
    );
    label.textContent = tickFormat.format(time);
  }

  // Buckets still filling: a hatched band from the first one to the end.
  const firstFilling = chart.series[0]?.buckets.findIndex((b) => b.incomplete);
  if (firstFilling !== undefined && firstFilling >= 0) {
    const fillingStart = x(times[Math.max(firstFilling - 1, 0)] ?? last);
    svg(
      "rect",
      {
        class: "incomplete-band",
        x: fillingStart,
        y: MARGIN.top,
        width: Math.max(x(last) - fillingStart, 2),
        height: plotHeight,
      },
      root,
    );
  }
  svg(
    "line",
    {
      class: "baseline",
      x1: MARGIN.left,
      x2: width - MARGIN.right,
      y1: y(0),
      y2: y(0),
    },
    root,
  );

  const single = chart.series.length === 1;
  chart.series.forEach((series, index) => {
    const color = SERIES_COLORS[index % SERIES_COLORS.length] ?? "#7553ff";
    const points = series.buckets.map(
      (b) => [x(Date.parse(b.time)), y(b.value)] as const,
    );
    const split = series.buckets.findIndex((b) => b.incomplete);
    const settled = split < 0 ? points : points.slice(0, Math.max(split, 1));
    const filling = split < 0 ? [] : points.slice(Math.max(split - 1, 0));
    const path = (pts: readonly (readonly [number, number])[]) =>
      pts.map(([px, py], i) => `${i ? "L" : "M"}${px},${py}`).join("");
    if (single && points.length > 1) {
      svg(
        "path",
        {
          d: `${path(points)}L${points.at(-1)?.[0]},${y(0)}L${points[0]?.[0]},${y(0)}Z`,
          fill: color,
          "fill-opacity": 0.16,
        },
        root,
      );
    }
    svg(
      "path",
      { d: path(settled), fill: "none", stroke: color, "stroke-width": 2 },
      root,
    );
    if (points.length === 1) {
      const [px, py] = points[0] ?? [0, 0];
      svg("circle", { cx: px, cy: py, r: 4, fill: color }, root);
    }
    if (filling.length > 1) {
      svg(
        "path",
        {
          d: path(filling),
          fill: "none",
          stroke: color,
          "stroke-width": 2,
          "stroke-dasharray": "4 3",
        },
        root,
      );
    }
  });

  const crosshair = svg(
    "line",
    {
      class: "crosshair",
      y1: MARGIN.top,
      y2: MARGIN.top + plotHeight,
      visibility: "hidden",
    },
    root,
  );
  const markers = chart.series.map((_, index) =>
    svg(
      "circle",
      {
        r: 3.5,
        fill: SERIES_COLORS[index % SERIES_COLORS.length] ?? "#7553ff",
        visibility: "hidden",
      },
      root,
    ),
  );
  container.appendChild(root);

  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";
  tooltip.hidden = true;
  container.appendChild(tooltip);

  const hide = () => {
    tooltip.hidden = true;
    crosshair.setAttribute("visibility", "hidden");
    for (const marker of markers) marker.setAttribute("visibility", "hidden");
  };
  const showAt = (index: number) => {
    const time = times[index];
    if (time === undefined) return hide();
    const px = x(time);
    crosshair.setAttribute("x1", String(px));
    crosshair.setAttribute("x2", String(px));
    crosshair.setAttribute("visibility", "visible");
    const timeRow = document.createElement("div");
    timeRow.className = "time";
    const incomplete = chart.series[0]?.buckets[index]?.incomplete;
    timeRow.textContent = `${formatTooltipTime(time, format)}${incomplete ? " (still filling)" : ""}`;
    const rows = chart.series.map((series, s) => {
      const bucket = series.buckets[index];
      const marker = markers[s];
      if (bucket && marker) {
        marker.setAttribute("cx", String(px));
        marker.setAttribute("cy", String(y(bucket.value)));
        marker.setAttribute("visibility", "visible");
      }
      const row = document.createElement("div");
      row.className = "row";
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = SERIES_COLORS[s % SERIES_COLORS.length] ?? "";
      const label = document.createElement("span");
      label.textContent = series.label;
      const value = document.createElement("span");
      value.textContent = bucket ? formatValue(bucket.value, chart) : "–";
      row.append(swatch, label, value);
      return row;
    });
    tooltip.replaceChildren(timeRow, ...rows);
    tooltip.hidden = false;
    // The tooltip is HTML, so convert viewBox units to CSS pixels. They
    // differ when the container is narrower than the minimum viewBox width.
    const box = root.getBoundingClientRect();
    const toCss = box.width > 0 ? box.width / width : 1;
    const cssX = px * toCss;
    const tipWidth = tooltip.offsetWidth;
    const left = Math.min(cssX + 12, box.width - tipWidth - 4);
    tooltip.style.left = `${left < cssX && cssX - tipWidth - 12 > 0 ? cssX - tipWidth - 12 : Math.max(left, 0)}px`;
    tooltip.style.top = `${MARGIN.top * toCss}px`;
  };

  root.addEventListener("pointermove", (event) => {
    const box = root.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    if (px < MARGIN.left || px > width - MARGIN.right || times.length === 0) {
      return hide();
    }
    const time = first + ((px - MARGIN.left) / plotWidth) * span;
    let nearest = 0;
    times.forEach((t, i) => {
      if (Math.abs(t - time) < Math.abs((times[nearest] ?? 0) - time)) {
        nearest = i;
      }
    });
    showAt(nearest);
  });
  root.addEventListener("pointerleave", hide);
}
