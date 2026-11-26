import { z } from "zod";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import {
  assertIssueWithinProjectConstraint,
  isErrorIssue,
  parseIssueParams,
} from "../../internal/tool-helpers/issue";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamIssueShortId,
  ParamIssueUrl,
  ParamOrganizationSlug,
  ParamPeriod,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { CHART_UI_RESOURCE, uiToolMeta } from "../../ui-resources";
import { chartOutputSchema } from "../support/chart/schema";
import {
  formatInterval,
  type PlottedSeries,
  resolveTimeRange,
  type TimeRange,
  timeRangeResult,
  toChart,
} from "../support/chart/series";
import { toStructuredIngestion } from "../support/ingestion";

/** The issue page's default range (`DEFAULT_STATS_PERIOD`). */
const DEFAULT_PERIOD = "14d";
const EVENTS = "count()";
const USERS = "count_unique(user)";

const MINUTE_UNITS: Record<string, number> = {
  m: 1,
  h: 60,
  d: 1440,
  w: 10_080,
};

/**
 * Bucket size by range in minutes, from the issue page's fidelity ladder
 * (`issuesFidelityLadder` in Sentry's `components/charts/utils.tsx`): 4h
 * for 14 days, so about 85 buckets instead of the 337 that Sentry picks.
 */
const ISSUE_INTERVALS: [minMinutes: number, interval: string][] = [
  [86_400, "1d"],
  [43_200, "12h"],
  [20_160, "4h"],
  [10_080, "2h"],
  [2880, "1h"],
  [1440, "20m"],
  [360, "5m"],
  [180, "2m"],
  [0, "1m"],
];

function rangeMinutes(range: TimeRange): number {
  if (range.start !== undefined && range.end !== undefined) {
    const ms = Date.parse(range.end) - Date.parse(range.start);
    if (!(ms > 0)) {
      throw new UserInputError(
        "`start` and `end` must be ISO 8601 timestamps, with `start` first.",
      );
    }
    return ms / 60_000;
  }
  const match = /^(\d+)([mhdw])$/.exec(range.statsPeriod ?? DEFAULT_PERIOD);
  return Number(match?.[1]) * (MINUTE_UNITS[match?.[2] ?? ""] ?? 0);
}

function issueInterval(range: TimeRange): string {
  const minutes = rangeMinutes(range);
  return (
    ISSUE_INTERVALS.find(([minMinutes]) => minutes >= minMinutes)?.[1] ?? "1m"
  );
}

export default defineTool({
  includeInSkillDefinitions: false,
  name: "render_issue_chart",
  title: "Render Issue Chart",
  skills: ["inspect", "triage", "seer"],
  requiredScopes: ["event:read"],
  description:
    "Chart a Sentry issue's events and affected users over time, like the graph on the issue page. Returns every bucket of both series, and MCP Apps hosts show it as an interactive chart.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    issueId: ParamIssueShortId.optional(),
    issueUrl: ParamIssueUrl.optional(),
    period: ParamPeriod.nullable()
      .default(null)
      .describe("Relative time window, e.g. `24h`, `7d`; defaults to 14d."),
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
    const interval = issueInterval(timeParams);
    const { organizationSlug, issueId } = parseIssueParams({
      issueUrl: params.issueUrl,
      issueId: params.issueId,
      organizationSlug:
        params.organizationSlug ?? context.constraints.organizationSlug,
    });

    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? context.constraints.regionUrl ?? undefined,
    });
    setTargetTagsAndAttributes({ organizationSlug, issueId });

    const issue = await apiService.getIssue({ organizationSlug, issueId });
    assertIssueWithinProjectConstraint({
      issue,
      projectSlug: context.constraints.projectSlug,
    });

    // As the issue page does: the errors dataset holds only error issues, so
    // any other issue would chart as all zeros there.
    const dataset = isErrorIssue(issue) ? "errors" : "issuePlatform";
    const query = `issue.id:${issue.id}`;
    const response = await apiService.getEventsTimeSeries({
      organizationSlug,
      query,
      yAxis: [EVENTS, USERS],
      interval,
      projectId: String(issue.project.id),
      dataset,
      ...timeParams,
    });

    const plotted = (
      [
        ["Events", EVENTS],
        ["Users", USERS],
      ] as const
    ).flatMap(([label, yAxis]): PlottedSeries[] => {
      const entry = response.timeSeries.find((s) => s.yAxis === yAxis);
      return entry ? [{ label, entry }] : [];
    });
    const meta = plotted[0]?.entry.meta;

    const url = new URL(
      apiService.getIssueUrl(organizationSlug, issue.shortId),
    );
    for (const [key, value] of Object.entries(timeParams)) {
      url.searchParams.set(key, value);
    }

    return structuredResult({
      tool: "render_issue_chart",
      title: `${issue.shortId}: ${issue.title}`,
      dataset,
      query,
      yAxis: `${EVENTS}, ${USERS}`,
      groupBy: null,
      valueType: meta?.valueType ?? null,
      valueUnit: meta?.valueUnit ?? null,
      interval: meta ? formatInterval(meta.interval) : interval,
      timeRange: timeRangeResult(timeParams),
      url: url.toString(),
      ...toChart(plotted, "Events"),
      ingestion: toStructuredIngestion(response.meta?.ingestion),
    });
  },
});
