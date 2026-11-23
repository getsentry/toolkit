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
import { chartOutputSchema } from "../support/chart/schema";
import {
  filtersToIssues,
  formatInterval,
  type PlottedSeries,
  resolveTimeRange,
  seriesTotal,
  type TimeSeries,
  timeRangeResult,
  toChart,
} from "../support/chart/series";
import { toStructuredIngestion } from "../support/ingestion";

/** Top groups plotted when the chart is split by an attribute. */
const MAX_CHART_SERIES = 5;
const DEFAULT_PERIOD = "24h";

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

/**
 * The plotted series in Sentry's rank order, each with its group's event
 * count when `countYAxis` fetched one.
 */
function plottedSeries(
  response: EventsTimeSeriesResponse,
  yAxis: string,
  countYAxis: string | null,
): PlottedSeries[] {
  const counts = new Map(
    response.timeSeries
      .filter((entry) => countYAxis !== yAxis && entry.yAxis === countYAxis)
      .map((entry) => [seriesLabel(entry), seriesTotal(entry)]),
  );
  return response.timeSeries
    .filter((entry) => entry.yAxis === yAxis)
    .map((entry) => {
      const label = seriesLabel(entry);
      return { label, entry, count: counts.get(label) };
    });
}

export default defineTool({
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
      .describe(
        "Chart heading, such as `Checkout errors`; defaults to the aggregate. Leave out the time range: the chart shows it, and the user can change it.",
      ),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: chartOutputSchema,
  _meta: uiToolMeta(CHART_UI_RESOURCE),
  async handler(params, context: ServerContext) {
    const timeParams = resolveTimeRange(params, DEFAULT_PERIOD);
    if (filtersToIssues(params.query)) {
      throw new UserInputError(
        "To chart an issue, use `render_issue_chart`; it reads the dataset that holds the issue's events. An `issue:` or `issue.id:` filter here can return all-zero buckets.",
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
      tool: "render_sentry_chart",
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
      timeRange: timeRangeResult(timeParams),
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
      ...toChart(plottedSeries(response, params.yAxis, countYAxis)),
      ingestion: toStructuredIngestion(response.meta?.ingestion),
    });
  },
});
