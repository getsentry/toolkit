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
import { summarizeSeries } from "../support/search-events/formatters";

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

function seriesLabel(
  series: EventsTimeSeriesResponse["timeSeries"][number],
): string {
  if (!series.groupBy?.length) return series.yAxis;
  return series.groupBy
    .map(({ value }) => (value === null || value === "" ? "(none)" : value))
    .join(", ");
}

function toChartSeries(
  response: EventsTimeSeriesResponse,
  yAxis: string,
): { series: ChartResult["series"]; peak: ChartResult["peak"] } {
  let peak: ChartResult["peak"] = null;
  const series = response.timeSeries.map((entry) => {
    const label = seriesLabel(entry);
    const summary = summarizeSeries(entry, yAxis);
    if (summary.peak && (!peak || summary.peak.value > peak.value)) {
      peak = {
        series: label,
        time: new Date(summary.peak.timestamp).toISOString(),
        value: summary.peak.value,
      };
    }
    return {
      label,
      total: summary.total,
      buckets: summary.points.map((point) => ({
        time: new Date(point.timestamp).toISOString(),
        value: point.value,
        incomplete: point.filling,
        outsideRetention: point.outsideRetention,
      })),
    };
  });
  return { series, peak };
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
    "Chart a count, rate, duration, or other aggregate of Sentry errors, logs, spans, metrics, or profiles over time, optionally split into the top 5 values of one attribute. Returns every bucket of each series, and MCP Apps hosts show it as an interactive chart. To find individual events, use the dataset search tools.",
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
        "Attribute to split by, such as `release` or `transaction`; plots its top 5 values. Not supported for profiles.",
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
    const response = await apiService.getEventsTimeSeries({
      organizationSlug,
      query: params.query,
      yAxis: params.yAxis,
      interval: params.interval ?? undefined,
      projectId,
      dataset: params.dataset,
      ...timeParams,
      topEvents: params.groupBy
        ? { groupBy: params.groupBy, limit: MAX_CHART_SERIES }
        : undefined,
    });

    const meta = response.timeSeries[0]?.meta;
    if (meta?.valueType === "string") {
      throw new UserInputError(
        `\`${params.yAxis}\` returns text, which cannot be charted. Use a numeric aggregate such as \`count()\`.`,
      );
    }
    const { series, peak } = toChartSeries(response, params.yAxis);

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
        params.groupBy ? [params.groupBy, params.yAxis] : [params.yAxis],
        `-${params.yAxis}`,
        [params.yAxis],
        params.groupBy ? [params.groupBy] : [],
        timeParams.statsPeriod,
        timeParams.start,
        timeParams.end,
      ),
      series,
      peak,
      ingestion: toStructuredIngestion(response.meta?.ingestion),
    });
  },
});
