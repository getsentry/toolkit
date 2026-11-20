/**
 * The render_sentry_chart view. The host sends the tool's arguments and
 * result; the range picker calls the tool again through the host and redraws
 * in place.
 */
import type { ChartResult } from "../src/tools/support/chart/schema";
import {
  type CallToolResult,
  connect,
  type Host,
  type HostContext,
} from "./bridge";
import {
  drawChart,
  formatCount,
  formatTooltipTime,
  formatValue,
  SERIES_COLORS,
  shortLabel,
  type TimeFormat,
} from "./chart";
import { parseChartResult } from "./parse";

const TOOL_NAME = "render_sentry_chart";
const RANGES = ["1h", "24h", "7d", "14d"] as const;
const UNIT_NAMES: Record<string, string> = {
  m: "minute",
  h: "hour",
  d: "day",
  w: "week",
};

type View =
  | { kind: "waiting" }
  | { kind: "ready"; chart: ChartResult }
  | { kind: "error"; message: string; chart: ChartResult | null };

let view: View = { kind: "waiting" };
let toolArgs: Record<string, unknown> = {};
let pendingRange: string | null = null;
let format: TimeFormat = { locale: undefined, timeZone: undefined };

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const title = el("h1", undefined, "Sentry chart");
const subtitle = el("div", "subtitle");
const ranges = el("div", "ranges");
const openButton = el("button", "open", "Open in Sentry");
const stats = el("div", "stats");
const chartBox = el("div", "chart");
const legend = el("div", "legend");
const note = el("div", "note");
const state = el("div", "state", "Loading chart…");
const rangeButtons = RANGES.map((range) => {
  const button = el("button", undefined, range);
  button.type = "button";
  button.addEventListener("click", () => void changeRange(range));
  ranges.appendChild(button);
  return button;
});

const header = el("header");
const heading = el("div");
heading.append(title, subtitle);
const controls = el("div", "controls");
controls.append(ranges, openButton);
header.append(heading, controls);
const main = el("main");
main.append(header, stats, chartBox, legend, note, state);
document.body.appendChild(main);

function rangeLabel(chart: ChartResult): string {
  const { statsPeriod, start, end } = chart.timeRange;
  const match = statsPeriod ? /^(\d+)([mhdw])$/.exec(statsPeriod) : null;
  if (match?.[1] && match[2]) {
    const count = Number(match[1]);
    const unit = UNIT_NAMES[match[2]] ?? match[2];
    return `Last ${count === 1 ? unit : `${count} ${unit}s`}`;
  }
  if (start && end) {
    return `${formatTooltipTime(Date.parse(start), format)} – ${formatTooltipTime(Date.parse(end), format)}`;
  }
  return statsPeriod ?? "";
}

function stat(label: string, value: string): HTMLElement {
  const item = el("span", undefined, `${label} `);
  item.appendChild(el("strong", undefined, value));
  return item;
}

// Self-hosted Sentry can serve plain http, including localhost.
function isWebUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function render(): void {
  const chart = view.kind === "waiting" ? null : view.chart;
  const busy = pendingRange !== null;
  chartBox.dataset["loading"] = String(busy);
  for (const [index, button] of rangeButtons.entries()) {
    const range = RANGES[index];
    button.disabled = busy || chart === null;
    button.setAttribute(
      "aria-pressed",
      String((pendingRange ?? chart?.timeRange.statsPeriod) === range),
    );
  }
  openButton.disabled = !isWebUrl(chart?.url);

  if (view.kind === "error") {
    state.hidden = false;
    state.className = "state error";
    state.textContent = view.message;
  }
  if (!chart) {
    if (view.kind === "waiting") state.hidden = false;
    stats.replaceChildren();
    legend.replaceChildren();
    chartBox.replaceChildren();
    note.textContent = "";
    return;
  }

  title.textContent = chart.title;
  subtitle.replaceChildren(
    `${chart.dataset} · `,
    el("code", undefined, chart.query || "all events"),
    ` · ${rangeLabel(chart)}`,
  );

  const hasData = chart.series.some((series) =>
    series.values.some((value) => value !== null),
  );
  if (view.kind === "ready") {
    state.className = "state";
    state.hidden = hasData;
    state.textContent = "No data for this query in this range.";
  }

  const single = chart.series.length === 1 ? chart.series[0] : undefined;
  const items: HTMLElement[] = [];
  if (single?.total != null) {
    items.push(stat("Total", formatValue(single.total, chart)));
  }
  if (chart.peak) {
    items.push(
      stat(
        "Peak",
        `${formatValue(chart.peak.value, chart)}${single ? "" : ` (${shortLabel(chart.peak.series)})`} at ${formatTooltipTime(Date.parse(chart.peak.time), format)}`,
      ),
    );
  }
  if (hasData) items.push(stat("Interval", chart.interval));
  stats.replaceChildren(...items);

  legend.replaceChildren(
    ...(single
      ? []
      : chart.series.map((series, index) => {
          const item = el("span", "item");
          const swatch = el("span", "swatch");
          swatch.style.background =
            SERIES_COLORS[index % SERIES_COLORS.length] ?? "";
          // The event count shows when a series rests on a handful of events.
          const count =
            series.count === null
              ? ""
              : ` · ${formatCount(series.count)} ${series.count === 1 ? "event" : "events"}`;
          item.title = series.label;
          item.append(swatch, `${shortLabel(series.label)}${count}`);
          return item;
        })),
  );

  const filling = chart.incomplete.length > 0;
  const ingestion =
    chart.ingestion && chart.ingestion.status !== "healthy"
      ? ` Ingestion is ${chart.ingestion.status}.`
      : "";
  note.textContent = hasData
    ? `${filling ? "Hatched area: buckets still receiving data." : ""}${ingestion}`.trim()
    : "";

  if (hasData) {
    drawChart(chartBox, chart, format);
  } else {
    chartBox.replaceChildren();
  }
}

function errorText(result: CallToolResult): string {
  const text = result.content.find((block) => block.type === "text")?.text;
  return text ?? "The chart could not load.";
}

function showResult(result: CallToolResult): void {
  const previous = view.kind === "waiting" ? null : view.chart;
  if (result.isError) {
    view = { kind: "error", message: errorText(result), chart: previous };
    return;
  }
  const chart = parseChartResult(result.structuredContent);
  view = chart
    ? { kind: "ready", chart }
    : {
        kind: "error",
        message: "The chart data was not in the expected shape.",
        chart: previous,
      };
}

let host: Host | null = null;

async function changeRange(range: string): Promise<void> {
  const args: Record<string, unknown> = {
    ...toolArgs,
    period: range,
    start: null,
    end: null,
  };
  // A fixed bucket size may not fit the new range, so let Sentry pick.
  delete args["interval"];
  if (!host) return;
  pendingRange = range;
  render();
  try {
    const result = await host.callTool(TOOL_NAME, args);
    if (!result.isError) toolArgs = args;
    showResult(result);
  } catch (error) {
    view = {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
      chart: view.kind === "waiting" ? null : view.chart,
    };
  } finally {
    pendingRange = null;
    render();
  }
}

function applyHostContext(context: HostContext): void {
  const root = document.documentElement;
  if (context.theme === "light" || context.theme === "dark") {
    root.dataset["theme"] = context.theme;
    root.style.colorScheme = context.theme;
  }
  for (const [name, value] of Object.entries(context.styles?.variables ?? {})) {
    if (name.startsWith("--") && typeof value === "string") {
      root.style.setProperty(name, value);
    }
  }
  if (context.locale || context.timeZone) {
    format = {
      locale: context.locale ?? format.locale,
      timeZone: context.timeZone ?? format.timeZone,
    };
  }
  render();
}

openButton.addEventListener("click", () => {
  const chart = view.kind === "waiting" ? null : view.chart;
  if (chart && isWebUrl(chart.url)) void host?.openLink(chart.url);
});

let lastWidth = 0;
new ResizeObserver(([entry]) => {
  const width = Math.round(entry?.contentRect.width ?? 0);
  if (width !== lastWidth && view.kind !== "waiting") {
    lastWidth = width;
    render();
  }
}).observe(main);

render();
void connect(
  { name: "Sentry chart", version: "1.0.0" },
  {
    toolInput: (args) => {
      toolArgs = { ...args };
    },
    toolResult: (result) => {
      showResult(result);
      render();
    },
    toolCancelled: () => {
      view = {
        kind: "error",
        message: "The chart request was cancelled.",
        chart: view.kind === "waiting" ? null : view.chart,
      };
      pendingRange = null;
      render();
    },
    hostContext: applyHostContext,
  },
).then((connected) => {
  host = connected;
});
