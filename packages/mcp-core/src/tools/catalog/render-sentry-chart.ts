import { z } from "zod";
import type { EventsTimeSeriesResponse } from "../../api-client/schema";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamPeriod,
  ParamProjectSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { CHART_UI_RESOURCE, uiToolMeta } from "../../ui-resources";
import { PUBLIC_EVENTS_DATASETS } from "../../utils/events-datasets";
import {
  type ChartResult,
  renderSentryChartOutputSchema,
} from "../support/chart/schema";
import { toStructuredIngestion } from "../support/ingestion";

/** Top groups plotted when the chart is split by an attribute. */
const MAX_CHART_SERIES = 5;
const DEFAULT_PERIOD = "24h";

const INTERVAL_UNITS: [unit: string, ms: number][] = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
];

function formatInterval(ms: number): string {
  for (const [unit, unitMs] of INTERVAL_UNITS) {
    if (ms % unitMs === 0) return `${ms / unitMs}${unit}`;
  }
  return `${ms / 1000}s`;
}

type TimeSeries = EventsTimeSeriesResponse["timeSeries"][number];

function seriesLabel(series: TimeSeries): string {
  if (!series.groupBy?.length) return series.yAxis;
  return series.groupBy
    .map(({ value }) => (value === null || value === "" ? "(none)" : value))
    .join(", ");
}

/**
 * The aggregate that counts the events behind `yAxis`, used to pick the top
 * groups by volume. Ranking by `yAxis` itself would pick the groups with the
 * most extreme value, such as a p95 from one event. Trace metric aggregates
 * name their metric (`fn(value,name,type,unit)`), so its count must too; null
 * when the metric cannot be read from `yAxis`.
 */
function countAggregate(dataset: string, yAxis: string): string | null {
  if (dataset !== "metrics") return "count()";
  const args = /^\w+\((value,[^,()]+,[^,()]+,[^,()]+)\)$/.exec(yAxis)?.[1];
  return args ? `count(${args})` : null;
}

const isCount = (yAxis: string) => /^count\(/i.test(yAxis);
const isAdditive = (yAxis: string) => isCount(yAxis) || /^sum\(/i.test(yAxis);

/** A bucket value as a number, or null where the bucket has no data. */
function bucketValue(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  // Date-typed aggregates such as max(timestamp) return ISO datetime strings.
  const parsed = Number(raw);
  const value = Number.isNaN(parsed) ? Date.parse(String(raw)) : parsed;
  if (!Number.isFinite(value)) return null;
  // Drops float noise such as 6234.500000001 to keep the result compact.
  return Number.isInteger(value) ? value : Number(value.toPrecision(8));
}

function sum(values: readonly (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function indexesWhere<T>(items: readonly T[], test: (item: T) => boolean) {
  return items.flatMap((item, index) => (test(item) ? [index] : []));
}

/**
 * Turns the response into one shared time axis and one value array per
 * series. `countYAxis` names the series that counts each group's events,
 * when the response has one.
 */
function toChart(
  response: EventsTimeSeriesResponse,
  yAxis: string,
  countYAxis: string | null,
): Pick<
  ChartResult,
  "times" | "incomplete" | "outsideRetention" | "series" | "peak"
> {
  // Sentry returns top groups in rank order.
  const plotted = response.timeSeries.filter((entry) => entry.yAxis === yAxis);
  const counts = new Map(
    response.timeSeries
      .filter((entry) => countYAxis !== yAxis && entry.yAxis === countYAxis)
      .map((entry) => [
        seriesLabel(entry),
        sum(entry.values.map((b) => bucketValue(b.value))),
      ]),
  );
  const buckets = plotted[0]?.values ?? [];
  const outsideRetention = (b: (typeof buckets)[number]) =>
    b.incomplete && b.incompleteReason === "OUTSIDE_RETENTION";
  const incomplete = indexesWhere(
    buckets,
    (b) => b.incomplete && !outsideRetention(b),
  );
  const additive = isAdditive(yAxis);
  const series = plotted.map((entry) => {
    const label = seriesLabel(entry);
    const values = entry.values.map((b) => bucketValue(b.value));
    const total = additive ? sum(values) : null;
    return {
      label,
      count: counts.get(label) ?? (isCount(yAxis) ? total : null),
      total,
      values,
    };
  });

  // Only a single-series chart has a peak. Across groups, any one bucket
  // would headline a single group, which reads as the chart's peak.
  let peak: ChartResult["peak"] = null;
  const only = series.length === 1 ? series[0] : undefined;
  for (const [index, value] of (only?.values ?? []).entries()) {
    const bucket = buckets[index];
    if (!only || value === null || !bucket || incomplete.includes(index)) {
      continue;
    }
    if (!peak || value > peak.value) {
      peak = {
        series: only.label,
        time: new Date(bucket.timestamp).toISOString(),
        value,
      };
    }
  }

  return {
    times: buckets.map((b) => new Date(b.timestamp).toISOString()),
    incomplete,
    outsideRetention: indexesWhere(buckets, outsideRetention),
    series,
    peak,
  };
}

export default defineTool({
  // MCP Apps views ship to experimental sessions first.
  experimental: true,
  includeInSkillDefinitions: false,
  name: "render_sentry_chart",
  title: "Render Sentry Chart",
  skills: ["inspect", "triage", "seer"],
  requiredScopes: ["event:read"],
  description:
    "Chart a count, rate, duration, or other aggregate of Sentry errors, logs, spans, metrics, or profiles over time, optionally split by one attribute into the 5 values with the most events. Returns every bucket of each series, with each group's event count when split, and MCP Apps hosts show it as an interactive chart. To find individual events, use the dataset search tools.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    dataset: z.enum(PUBLIC_EVENTS_DATASETS).describe("Data to chart."),
    query: z
      .string()
      .trim()
      .default("")
      .describe(
        "Sentry search syntax filter, such as `level:error environment:production`. Empty matches everything.",
      ),
    yAxis: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Aggregate to plot, such as `count()`, `p95(span.duration)`, or `count_unique(user)`.",
      ),
    groupBy: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .default(null)
      .describe(
        "Attribute to split by, such as `release` or `transaction`; plots its 5 values with the most events. Not supported for profiles.",
      ),
    projectSlug: ParamProjectSlug.nullable().default(null),
    period: ParamPeriod.nullable()
      .default(null)
      .describe(
        "Relative time window, e.g. `1h`, `24h`, `7d`; defaults to 24h. Do not combine with start and end.",
      ),
    start: z
      .string()
      .trim()
      .nullable()
      .default(null)
      .describe("Absolute start, ISO 8601; requires end."),
    end: z
      .string()
      .trim()
      .nullable()
      .default(null)
      .describe("Absolute end, ISO 8601; requires start."),
    interval: z
      .string()
      .trim()
      .regex(/^\d+[mhd]$/, "Use a bucket size like `5m`, `1h`, or `1d`.")
      .nullable()
      .default(null)
      .describe("Bucket size such as 5m or 1h. Omit to let Sentry pick."),
    title: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .default(null)
      .describe("Chart heading; defaults to the aggregate."),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: renderSentryChartOutputSchema,
  _meta: uiToolMeta(CHART_UI_RESOURCE),
  async handler(params, context: ServerContext) {
    if ((params.start === null) !== (params.end === null)) {
      throw new UserInputError("Pass both `start` and `end`, or neither.");
    }
    if (params.start !== null && params.period !== null) {
      throw new UserInputError(
        "Pass either `period` or `start` and `end`, not both.",
      );
    }
    if (params.groupBy !== null && params.dataset === "profiles") {
      throw new UserInputError(
        "Sentry cannot split profile charts by an attribute. Remove `groupBy`.",
      );
    }

    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;
    setTargetTagsAndAttributes({
      organizationSlug,
      projectSlug: params.projectSlug ?? undefined,
    });

    // Without a project, Sentry only charts projects whose teams the user
    // belongs to. `-1` covers every project the user can access, as the UI's
    // "All Projects" does.
    let projectId = "-1";
    if (params.projectSlug) {
      const project = await apiService.getProject({
        organizationSlug,
        projectSlugOrId: params.projectSlug,
      });
      projectId = String(project.id);
    }

    const timeParams: { statsPeriod?: string; start?: string; end?: string } =
      params.start !== null && params.end !== null
        ? { start: params.start, end: params.end }
        : { statsPeriod: params.period ?? DEFAULT_PERIOD };
    const countYAxis = params.groupBy
      ? countAggregate(params.dataset, params.yAxis)
      : null;
    // "Open in Sentry" ranks groups the same way the chart does.
    const rankBy = countYAxis ?? params.yAxis;
    const linkAggregates =
      rankBy === params.yAxis ? [params.yAxis] : [params.yAxis, rankBy];
    const response = await apiService.getEventsTimeSeries({
      organizationSlug,
      query: params.query,
      yAxis: params.yAxis,
      interval: params.interval ?? undefined,
      projectId,
      dataset: params.dataset,
      ...timeParams,
      topEvents: params.groupBy
        ? {
            groupBy: params.groupBy,
            limit: MAX_CHART_SERIES,
            rankBy: countYAxis ?? undefined,
          }
        : undefined,
    });

    const meta = response.timeSeries.find(
      (entry) => entry.yAxis === params.yAxis,
    )?.meta;
    if (meta?.valueType === "string") {
      throw new UserInputError(
        `\`${params.yAxis}\` returns text, which cannot be charted. Use a numeric aggregate such as \`count()\`.`,
      );
    }

    return structuredResult({
      title:
        params.title ??
        (params.groupBy
          ? `${params.yAxis} by ${params.groupBy}`
          : params.yAxis),
      dataset: params.dataset,
      query: params.query,
      yAxis: params.yAxis,
      groupBy: params.groupBy,
      valueType: meta?.valueType ?? null,
      valueUnit: meta?.valueUnit ?? null,
      interval: meta
        ? formatInterval(meta.interval)
        : (params.interval ?? "auto"),
      timeRange: {
        statsPeriod: timeParams.statsPeriod ?? null,
        start: timeParams.start ?? null,
        end: timeParams.end ?? null,
      },
      url: apiService.getEventsExplorerUrl(
        organizationSlug,
        params.query,
        projectId,
        params.dataset,
        // Discover reads group-by columns from `field`, so list it first.
        params.groupBy ? [params.groupBy, ...linkAggregates] : linkAggregates,
        `-${rankBy}`,
        linkAggregates,
        params.groupBy ? [params.groupBy] : [],
        timeParams.statsPeriod,
        timeParams.start,
        timeParams.end,
      ),
      ...toChart(response, params.yAxis, countYAxis),
      ingestion: toStructuredIngestion(response.meta?.ingestion),
    });
  },
});
