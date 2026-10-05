/**
 * sentry dashboard view
 *
 * View a dashboard with rendered widget data (sparklines, tables, big numbers).
 * Supports --refresh for auto-refreshing live display.
 */

import type { SentryContext } from "../../context.js";
import { getDashboard, queryAllWidgets } from "../../lib/api-client.js";
import { parseOrgProjectArg } from "../../lib/arg-parsing.js";
import { openInBrowser } from "../../lib/browser.js";
import { buildCommand } from "../../lib/command.js";
import type { DashboardViewData } from "../../lib/formatters/dashboard.js";
import { createDashboardViewRenderer } from "../../lib/formatters/dashboard.js";
import { ClearScreen, CommandOutput } from "../../lib/formatters/output.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import { withProgress } from "../../lib/polling.js";
import { resolveOrgRegion } from "../../lib/region.js";
import { buildDashboardUrl } from "../../lib/sentry-urls.js";
import type { GraphicsRendererPreference } from "../../lib/sixel.js";
import {
  formatTimeRangeFlag,
  PERIOD_BRIEF,
  parsePeriod,
  TIME_RANGE_24H,
  type TimeRange,
  timeRangeToSeconds,
} from "../../lib/time-range.js";
import type {
  DashboardWidget,
  WidgetDataResult,
} from "../../types/dashboard.js";
import {
  enrichDashboardError,
  parseDashboardPositionalArgs,
  resolveDashboardId,
  resolveOrgFromTarget,
} from "./resolve.js";

/** Default auto-refresh interval in seconds */
const DEFAULT_REFRESH_INTERVAL = 60;

/** Minimum auto-refresh interval in seconds (avoid rate limiting) */
const MIN_REFRESH_INTERVAL = 10;

type ViewFlags = {
  readonly web: boolean;
  readonly fresh: boolean;
  readonly refresh?: number;
  readonly period?: TimeRange;
  readonly renderer: GraphicsRendererPreference;
  readonly "no-graphics-cap": boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

/**
 * Parse --refresh flag value.
 * Supports: -r (empty string → 60s default), -r 30 (explicit interval in seconds)
 */
function parseRefresh(value: string): number {
  if (value === "") {
    return DEFAULT_REFRESH_INTERVAL;
  }
  const num = Number.parseInt(value, 10);
  if (Number.isNaN(num) || num < MIN_REFRESH_INTERVAL) {
    throw new Error(
      `--refresh interval must be at least ${MIN_REFRESH_INTERVAL} seconds`
    );
  }
  return num;
}

/**
 * Sleep that resolves early when an AbortSignal fires.
 * Resolves (not rejects) on abort for clean generator shutdown.
 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Build the DashboardViewData from a dashboard and its widget query results.
 */
function buildViewData(
  dashboard: {
    id: string;
    title: string;
    dateCreated?: string;
    environment?: string[];
  },
  widgetResults: Map<number, WidgetDataResult>,
  widgets: DashboardWidget[],
  opts: {
    period: string;
    rendererPreference: GraphicsRendererPreference;
    graphicsCap: boolean;
    url: string;
  }
): DashboardViewData {
  return {
    id: dashboard.id,
    title: dashboard.title,
    period: opts.period,
    fetchedAt: new Date().toISOString(),
    url: opts.url,
    dateCreated: dashboard.dateCreated,
    environment: dashboard.environment,
    rendererPreference: opts.rendererPreference,
    graphicsCap: opts.graphicsCap,
    widgets: widgets.map((w, i) => ({
      title: w.title,
      displayType: w.displayType,
      widgetType: w.widgetType,
      description: (w as Record<string, unknown>).description as
        | string
        | undefined,
      layout: w.layout,
      queries: w.queries,
      data: widgetResults.get(i) ?? {
        type: "error" as const,
        message: "No data returned",
      },
    })),
  };
}

/**
 * Resolve the effective time range for a dashboard view.
 *
 * Priority: explicit --period flag > dashboard's saved period > 24h default.
 * Dashboard period is a raw string from the API that needs parsing.
 */
function resolveViewTimeRange(
  flagPeriod: TimeRange | undefined,
  dashboardPeriod: string | null | undefined
): TimeRange {
  if (flagPeriod) {
    return flagPeriod;
  }
  return dashboardPeriod ? parsePeriod(dashboardPeriod) : TIME_RANGE_24H;
}

export const viewCommand = buildCommand({
  docs: {
    brief: "View a dashboard",
    fullDescription:
      "View a Sentry dashboard with rendered widget data.\n\n" +
      "Fetches actual data for each widget and displays sparkline charts,\n" +
      "tables, and big numbers in the terminal.\n\n" +
      "The dashboard can be specified by numeric ID or title.\n\n" +
      "Examples:\n" +
      "  sentry dashboard view 12345\n" +
      "  sentry dashboard view 'My Dashboard'\n" +
      "  sentry dashboard view my-org 12345\n" +
      "  sentry dashboard view my-org 'My Dashboard'\n" +
      "  sentry dashboard view my-org/my-project 12345\n" +
      "  sentry dashboard view 12345 --json\n" +
      "  sentry dashboard view 12345 --period 7d\n" +
      "  sentry dashboard view 12345 --renderer sixel\n" +
      "  sentry dashboard view 12345 -r\n" +
      "  sentry dashboard view 12345 -r 30\n" +
      "  sentry dashboard view 12345 --web",
  },
  output: {
    human: createDashboardViewRenderer,
    jsonExclude: ["rendererPreference", "graphicsCap"],
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        placeholder: "org/project/dashboard",
        brief: "[<org/project>] <dashboard-id-or-title>",
        parse: String,
      },
    },
    flags: {
      web: {
        kind: "boolean",
        brief: "Open in browser",
        default: false,
      },
      fresh: FRESH_FLAG,
      refresh: {
        kind: "parsed",
        parse: parseRefresh,
        brief: "Auto-refresh interval in seconds (default: 60, min: 10)",
        optional: true,
        inferEmpty: true,
      },
      period: {
        kind: "parsed",
        parse: parsePeriod,
        brief: PERIOD_BRIEF,
        optional: true,
      },
      renderer: {
        kind: "enum",
        values: ["auto", "kitty", "sixel"],
        brief:
          "Graphics renderer (defaults to auto; falls back to auto when unavailable)",
        default: "auto",
      },
      "no-graphics-cap": {
        kind: "boolean",
        brief:
          "Use the terminal-native graphics width (may fall back to ASCII for very large dashboards)",
        default: false,
      },
    },
    aliases: {
      ...FRESH_ALIASES,
      w: "web",
      r: "refresh",
      t: "period",
    },
  },
  async *func(this: SentryContext, flags: ViewFlags, ...args: string[]) {
    applyFreshFlag(flags);
    const { cwd } = this;

    const { dashboardRef, targetArg } = parseDashboardPositionalArgs(args);
    const parsed = parseOrgProjectArg(targetArg);
    const orgSlug = await resolveOrgFromTarget(
      parsed,
      cwd,
      "sentry dashboard view <org>/ <id>"
    );
    const dashboardId = await resolveDashboardId(orgSlug, dashboardRef);
    const url = buildDashboardUrl(orgSlug, dashboardId);

    if (flags.web) {
      await openInBrowser(url, "dashboard");
      return;
    }

    // Fetch the dashboard definition (widget structure)
    const dashboard = await withProgress(
      { message: "Fetching dashboard...", json: flags.json },
      () => getDashboard(orgSlug, dashboardId)
    ).catch(async (error: unknown) =>
      enrichDashboardError(error, {
        orgSlug,
        dashboardId,
        operation: "view",
      })
    );

    const regionUrl = await resolveOrgRegion(orgSlug);
    const timeRange = resolveViewTimeRange(flags.period, dashboard.period);
    const periodSeconds = timeRangeToSeconds(timeRange);
    // WidgetQueryOptions uses `period` (not `statsPeriod`) for the relative field
    const widgetTimeOpts =
      timeRange.type === "relative"
        ? { period: timeRange.period }
        : { start: timeRange.start, end: timeRange.end };
    const widgets = dashboard.widgets ?? [];

    if (flags.refresh !== undefined) {
      // ── Refresh mode: poll and re-render ──
      const interval = flags.refresh;
      if (!flags.json) {
        logger.info(
          `Auto-refreshing dashboard every ${interval}s. Press Ctrl+C to stop.`
        );
      }

      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);

      // Library mode: honor external abort signal (e.g., consumer break)
      const externalSignal = (this.process as { abortSignal?: AbortSignal })
        ?.abortSignal;
      if (externalSignal) {
        externalSignal.addEventListener("abort", stop, { once: true });
      }

      let isFirstRender = true;

      try {
        while (!controller.signal.aborted) {
          const widgetData = await queryAllWidgets(
            regionUrl,
            orgSlug,
            dashboard,
            { ...widgetTimeOpts, periodSeconds }
          );

          // Build output data before clearing so clear→render is instantaneous
          const viewData = buildViewData(dashboard, widgetData, widgets, {
            period: formatTimeRangeFlag(timeRange),
            rendererPreference: flags.renderer,
            graphicsCap: !flags["no-graphics-cap"],
            url,
          });

          if (!isFirstRender) {
            yield new ClearScreen();
          }
          isFirstRender = false;

          yield new CommandOutput(viewData);

          await abortableSleep(interval * 1000, controller.signal);
        }
      } finally {
        process.removeListener("SIGINT", stop);
      }
      return;
    }

    // ── Single fetch mode ──
    const widgetData = await withProgress(
      { message: "Querying widget data...", json: flags.json },
      () =>
        queryAllWidgets(regionUrl, orgSlug, dashboard, {
          ...widgetTimeOpts,
          periodSeconds,
        })
    );

    yield new CommandOutput(
      buildViewData(dashboard, widgetData, widgets, {
        period: formatTimeRangeFlag(timeRange),
        rendererPreference: flags.renderer,
        graphicsCap: !flags["no-graphics-cap"],
        url,
      })
    );
    return { hint: `Dashboard: ${url}` };
  },
});
