/**
 * sentry dashboard widget add
 *
 * Add a widget to an existing dashboard using inline flags.
 */

import type { SentryContext } from "../../../context.js";
import { getDashboard, updateDashboard } from "../../../lib/api-client.js";
import { parseOrgProjectArg } from "../../../lib/arg-parsing.js";
import { buildCommand, numberParser } from "../../../lib/command.js";
import { ValidationError } from "../../../lib/errors.js";
import { formatWidgetAdded } from "../../../lib/formatters/human.js";
import { CommandOutput } from "../../../lib/formatters/output.js";
import { buildDashboardUrl } from "../../../lib/sentry-urls.js";
import {
  assignDefaultLayout,
  type DashboardDetail,
  type DashboardWidget,
  FALLBACK_LAYOUT,
  prepareDashboardForUpdate,
  validateWidgetLayout,
  type WidgetLayoutFlags,
  type WidgetLayoutMode,
} from "../../../types/dashboard.js";
import {
  buildWidgetFromFlags,
  enrichDashboardError,
  normalizeDataset,
  parseDashboardPositionalArgs,
  resolveDashboardId,
  resolveOrgFromTarget,
  validateWidgetEnums,
  type WidgetQueryFlags,
} from "../resolve.js";

type AddFlags = WidgetQueryFlags &
  WidgetLayoutFlags & {
    readonly display: string;
    readonly layout: string;
    readonly json: boolean;
    readonly fields?: string[];
  };

type AddResult = {
  dashboard: DashboardDetail;
  widget: DashboardWidget;
  url: string;
};

/**
 * Parse positional args for widget add.
 * Last arg is widget title, rest go to dashboard resolution.
 */
function parseAddPositionalArgs(args: string[]): {
  dashboardArgs: string[];
  title: string;
} {
  if (args.length < 2) {
    throw new ValidationError(
      "Widget title is required as a positional argument.\n\n" +
        "Example:\n" +
        '  sentry dashboard widget add <dashboard> "My Widget" --display line --query count',
      "title"
    );
  }
  if (args.length > 3) {
    throw new ValidationError(
      `Too many positional arguments (got ${args.length}, expected at most 3).\n\n` +
        "Usage: sentry dashboard widget add [<org/project>] <dashboard> <title>",
      "positional"
    );
  }

  const title = args.at(-1) as string;
  const dashboardArgs = args.slice(0, -1);
  return { dashboardArgs, title };
}

export const addCommand = buildCommand({
  docs: {
    brief: "Add a widget to a dashboard",
    fullDescription:
      "Add a widget to an existing Sentry dashboard.\n\n" +
      "The dashboard can be specified by numeric ID or title.\n\n" +
      "Examples:\n" +
      "  sentry dashboard widget add 'My Dashboard' \"Error Count\" \\\n" +
      "    --display big_number --query count\n\n" +
      "  sentry dashboard widget add 'My Dashboard' \"Errors by Browser\" \\\n" +
      "    --display line --query count --group-by browser.name\n\n" +
      "  sentry dashboard widget add 'My Dashboard' \"Top Endpoints\" \\\n" +
      "    --display table --query count --query p95:span.duration \\\n" +
      "    --group-by transaction --sort -count --limit 10\n\n" +
      "Query shorthand (--query flag):\n" +
      "  count          → count()         (bare name = no-arg aggregate)\n" +
      "  p95:span.duration → p95(span.duration)  (colon = function with arg)\n" +
      "  count()        → count()         (parens passthrough)\n\n" +
      "Sort shorthand (--sort flag):\n" +
      "  count          → count()         (ascending)\n" +
      "  -count         → -count()        (descending)\n\n" +
      "Layout flags (--col/-x, --row/-y, --width, --height) control widget position\n" +
      "and size in the 6-column dashboard grid. Omitted values use auto-layout.",
  },
  output: {
    human: formatWidgetAdded,
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        placeholder: "org/project/dashboard/title",
        brief: "[<org/project>] <dashboard> <title>",
        parse: String,
      },
    },
    flags: {
      display: {
        kind: "parsed",
        parse: String,
        brief:
          "Display type (big_number, line, area, bar, table, stacked_area, top_n, text, categorical_bar, details, wheel, rage_and_dead_clicks, server_tree, agents_traces_table)",
      },
      dataset: {
        kind: "parsed",
        parse: String,
        brief:
          "Widget dataset (default: spans). Accepts canonical names and API synonyms: spans, error-events/errors, tracemetrics/metrics, logs, issue",
        optional: true,
      },
      query: {
        kind: "parsed",
        parse: String,
        brief: "Aggregate expression (e.g. count, p95:span.duration)",
        variadic: true,
        optional: true,
      },
      where: {
        kind: "parsed",
        parse: String,
        brief: "Search conditions filter (e.g. is:unresolved)",
        optional: true,
      },
      "group-by": {
        kind: "parsed",
        parse: String,
        brief: "Group-by column (repeatable)",
        variadic: true,
        optional: true,
      },
      sort: {
        kind: "parsed",
        parse: String,
        brief: "Order by (prefix - for desc, e.g. -count)",
        optional: true,
      },
      limit: {
        kind: "parsed",
        parse: numberParser,
        brief: "Result limit",
        optional: true,
      },
      col: {
        kind: "parsed",
        parse: numberParser,
        brief: "Grid column position (0-based, 0–5)",
        optional: true,
      },
      row: {
        kind: "parsed",
        parse: numberParser,
        brief: "Grid row position (0-based)",
        optional: true,
      },
      width: {
        kind: "parsed",
        parse: numberParser,
        brief: "Widget width in grid columns (1–6)",
        optional: true,
      },
      height: {
        kind: "parsed",
        parse: numberParser,
        brief: "Widget height in grid rows (min 1)",
        optional: true,
      },
      layout: {
        kind: "parsed",
        parse: String,
        brief: "Layout mode: sequential (append in order) or dense (fill gaps)",
        default: "sequential",
      },
    },
    aliases: {
      d: "display",
      q: "query",
      w: "where",
      g: "group-by",
      s: "sort",
      n: "limit",
      l: "layout",
      x: "col",
      y: "row",
    },
  },
  async *func(this: SentryContext, flags: AddFlags, ...args: string[]) {
    const { cwd } = this;

    const { dashboardArgs, title } = parseAddPositionalArgs(args);

    // Resolve dataset aliases (e.g. "errors" → "error-events") once, up front.
    // Every downstream consumer — enum validation, dataset-aware aggregate
    // validation, the PUT body — must see the canonical name, so we thread
    // the normalized value and never reference flags.dataset below.
    const dataset = normalizeDataset(flags.dataset);

    // Validate enums before any network calls (fail fast)
    validateWidgetEnums(flags.display, dataset);

    const { dashboardRef, targetArg } =
      parseDashboardPositionalArgs(dashboardArgs);
    const parsed = parseOrgProjectArg(targetArg);
    const orgSlug = await resolveOrgFromTarget(
      parsed,
      cwd,
      "sentry dashboard widget add <org>/ <dashboard> <title> --display <type>"
    );
    const dashboardId = await resolveDashboardId(orgSlug, dashboardRef);

    let newWidget = buildWidgetFromFlags({
      title,
      display: flags.display,
      dataset,
      query: flags.query,
      where: flags.where,
      groupBy: flags["group-by"],
      sort: flags.sort,
      limit: flags.limit,
    });

    // Validate layout mode before any network calls
    if (
      flags.layout &&
      flags.layout !== "sequential" &&
      flags.layout !== "dense"
    ) {
      throw new ValidationError(
        `Invalid --layout mode "${flags.layout}". Valid values: sequential, dense`,
        "layout"
      );
    }
    const layoutMode: WidgetLayoutMode =
      flags.layout === "dense" ? "dense" : "sequential";

    // Validate individual layout flag ranges before any network calls
    // (catches --col -1, --width 7, etc. early without needing the dashboard)
    validateWidgetLayout(flags);

    // GET current dashboard → append widget with layout → PUT
    const current = await getDashboard(orgSlug, dashboardId).catch(
      async (error: unknown) =>
        enrichDashboardError(error, { orgSlug, dashboardId, operation: "view" })
    );
    const updateBody = prepareDashboardForUpdate(current);

    // Always run auto-layout first to get default position and dimensions,
    // then override with any explicit user flags.
    newWidget = assignDefaultLayout(newWidget, updateBody.widgets, layoutMode);

    const hasExplicitLayout =
      flags.col !== undefined ||
      flags.row !== undefined ||
      flags.width !== undefined ||
      flags.height !== undefined;

    if (hasExplicitLayout) {
      const baseLayout = newWidget.layout ?? FALLBACK_LAYOUT;
      newWidget = {
        ...newWidget,
        layout: {
          ...baseLayout,
          ...(flags.col !== undefined && { x: flags.col }),
          ...(flags.row !== undefined && { y: flags.row }),
          ...(flags.width !== undefined && { w: flags.width }),
          ...(flags.height !== undefined && { h: flags.height }),
        },
      };
      // Re-validate the merged layout to catch cross-dimensional overflow
      // (e.g., --col 5 on a table widget with auto-width 6 → 5+6=11 > 6)
      const finalLayout = newWidget.layout ?? baseLayout;
      validateWidgetLayout(
        { col: finalLayout.x, width: finalLayout.w },
        finalLayout
      );
    }

    updateBody.widgets.push(newWidget);

    const updated = await updateDashboard(
      orgSlug,
      dashboardId,
      updateBody
    ).catch(async (error: unknown) =>
      enrichDashboardError(error, {
        orgSlug,
        dashboardId,
        operation: "update",
      })
    );
    const url = buildDashboardUrl(orgSlug, dashboardId);

    yield new CommandOutput({
      dashboard: updated,
      widget: newWidget,
      url,
    } as AddResult);
    return { hint: `Dashboard: ${url}` };
  },
});
