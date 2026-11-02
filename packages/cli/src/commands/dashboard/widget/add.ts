/**
 * sentry dashboard widget add
 *
 * Add a widget to an existing dashboard using inline flags.
 */

import type { SentryContext } from "../../../context.js";
import { getDashboard, updateDashboard } from "../../../lib/api-client.js";
import { buildCommand, numberParser } from "../../../lib/command.js";
import {
  aggregateShorthandParser,
  choiceParser,
  DASHBOARD_TARGET,
  type DatasetCompletion,
  fieldParser,
  parseText,
} from "../../../lib/completion-target.js";
import { ValidationError } from "../../../lib/errors.js";
import { formatWidgetAdded } from "../../../lib/formatters/human.js";
import { CommandOutput } from "../../../lib/formatters/output.js";
import {
  type BoundArguments,
  boundArguments,
} from "../../../lib/positional-parse.js";
import { buildDashboardUrl } from "../../../lib/sentry-web-urls.js";
import {
  assignDefaultLayout,
  type DashboardDetail,
  type DashboardWidget,
  DEFAULT_WIDGET_TYPE,
  DISPLAY_TYPES,
  FALLBACK_LAYOUT,
  GRID_COLUMN_POSITIONS,
  GRID_WIDTHS,
  prepareDashboardForUpdate,
  validateWidgetLayout,
  WIDGET_LAYOUT_MODES,
  WIDGET_TYPES,
  type WidgetLayoutFlags,
  type WidgetLayoutMode,
} from "../../../types/dashboard.js";
import {
  type DashboardInput,
  parseDashboardInput,
  type ResolvedDashboard,
  resolveDashboardInput,
} from "../arguments.js";
import {
  buildWidgetFromFlags,
  withDashboardErrors,
  normalizeDataset,
  validateWidgetEnums,
  WIDGET_FIELD_COMPLETION,
  type WidgetQueryFlags,
} from "../resolve.js";

/** What `--query`, `--sort`, and `--group-by` complete: a spans widget's by default. */
const FIELD_COMPLETION: DatasetCompletion = {
  ...WIDGET_FIELD_COMPLETION,
  default: DEFAULT_WIDGET_TYPE,
};

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

const USAGE_HINT =
  "sentry dashboard widget add <org>/ <dashboard> <title> --display <type>";

/** `widget add` arguments: the dashboard, then the widget title. */
type WidgetAddInput = DashboardInput & { readonly title: string };

/** The arguments of `widget add`. */
type WidgetAddArguments = BoundArguments<WidgetAddInput, ResolvedDashboard>;

/**
 * Parse positional args for widget add.
 * Last arg is widget title, rest go to dashboard resolution.
 */
function parseAddPositionalArgs(args: readonly string[]): {
  dashboardArgs: readonly string[];
  title: string;
} {
  if (args.length < 2) {
    throw new ValidationError(
      "Widget title is required as a positional argument.\n\n" +
        "Example:\n" +
        '  sentry dashboard widget add <dashboard> "My Widget" --display line --query count',
      "title",
    );
  }
  if (args.length > 3) {
    throw new ValidationError(
      `Too many positional arguments (got ${args.length}, expected at most 3).\n\n` +
        "Usage: sentry dashboard widget add [<org/project>] <dashboard> <title>",
      "positional",
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
      "Query shorthand (--query flag):\n" +
      "  count          → count()         (bare name = no-arg aggregate)\n" +
      "  p95:span.duration → p95(span.duration)  (colon = function with arg)\n" +
      "  count()        → count()         (parens passthrough)\n\n" +
      "Sort shorthand (--sort flag):\n" +
      "  count          → count()         (ascending)\n" +
      "  -count         → -count()        (descending)\n\n" +
      "Layout flags (--col/-x, --row/-y, --width, --height) control widget position\n" +
      "and size in the 6-column dashboard grid. Omitted values use auto-layout.",
    examples: [
      {
        description: "Add a counter widget",
        command:
          "sentry dashboard widget add 'My Dashboard' \"Error Count\" --display big_number --query count",
      },
      {
        description: "Use a dashboard ID in an explicit organization",
        command:
          'sentry dashboard widget add my-org/12345 "Error Count" --display big_number --query count',
      },
      {
        description: "Line chart with group-by",
        command:
          "sentry dashboard widget add 'My Dashboard' \"Errors by Browser\" --display line --query count --group-by browser.name",
      },
      {
        description: "Table with multiple aggregates, sorted descending",
        command:
          "sentry dashboard widget add 'My Dashboard' \"Top Endpoints\" --display table --query count --query p95:span.duration --group-by transaction --sort -count --limit 10",
      },
      {
        description: "Bar chart with a search filter",
        command:
          'sentry dashboard widget add \'My Dashboard\' "Slow Requests" --display bar --query p95:span.duration --where "span.op:http.client" --group-by span.description',
      },
      {
        description: "P95 latency KPI",
        command:
          "sentry dashboard widget add 'My Dashboard' \"P95\" --display big_number --query p95:span.duration",
      },
      {
        description: "Throughput KPI",
        command:
          "sentry dashboard widget add 'My Dashboard' \"Throughput\" --display big_number --query epm",
      },
      {
        description: "Custom metric percentiles from the tracemetrics dataset",
        command:
          'sentry dashboard widget add \'My Dashboard\' "Latency" --display line --dataset tracemetrics --query "p50(value,completion.duration_ms,distribution,none)" --query "p90(value,completion.duration_ms,distribution,none)"',
      },
    ],
  },
  output: {
    human: formatWidgetAdded,
  },
  parameters: {
    positional: boundArguments({
      placeholder: "org/project/dashboard/title",
      brief: "[<org/project>] <dashboard> <title>",
      kind: DASHBOARD_TARGET,
      parse: (args): WidgetAddInput => {
        const { dashboardArgs, title } = parseAddPositionalArgs(args);
        return { ...parseDashboardInput(dashboardArgs, USAGE_HINT), title };
      },
      resolve: (input: WidgetAddInput, context: SentryContext) =>
        resolveDashboardInput(input, context.cwd, USAGE_HINT),
    }),
    flags: {
      display: {
        kind: "parsed",
        parse: choiceParser(DISPLAY_TYPES),
        brief:
          "Display type (big_number, line, area, bar, table, stacked_area, top_n, text, categorical_bar, details, wheel, rage_and_dead_clicks, server_tree, agents_traces_table)",
      },
      dataset: {
        kind: "parsed",
        parse: choiceParser(WIDGET_TYPES),
        brief:
          "Widget dataset (default: spans). Accepts canonical names and API synonyms: spans, error-events/errors, tracemetrics/metrics, logs, issue",
        optional: true,
      },
      query: {
        kind: "parsed",
        parse: aggregateShorthandParser(FIELD_COMPLETION),
        brief: "Aggregate expression (e.g. count, p95:span.duration)",
        variadic: true,
        optional: true,
      },
      where: {
        kind: "parsed",
        parse: parseText,
        brief: "Search conditions filter (e.g. is:unresolved)",
        optional: true,
      },
      "group-by": {
        kind: "parsed",
        parse: fieldParser(FIELD_COMPLETION),
        brief: "Group-by column (repeatable)",
        variadic: true,
        optional: true,
      },
      sort: {
        kind: "parsed",
        parse: aggregateShorthandParser(FIELD_COMPLETION),
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
        parse: choiceParser(GRID_COLUMN_POSITIONS, numberParser),
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
        parse: choiceParser(GRID_WIDTHS, numberParser),
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
        parse: choiceParser(WIDGET_LAYOUT_MODES),
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
  async *func(
    this: SentryContext,
    flags: AddFlags,
    target: WidgetAddArguments,
  ) {
    const { title } = target.parsed;

    // Resolve dataset aliases (e.g. "errors" → "error-events") once, up front.
    // Every downstream consumer — enum validation, dataset-aware aggregate
    // validation, the PUT body — must see the canonical name, so we thread
    // the normalized value and never reference flags.dataset below.
    const dataset = normalizeDataset(flags.dataset);

    // Validate enums before any network calls (fail fast)
    validateWidgetEnums(flags.display, dataset);

    const { orgSlug, dashboardId } = await target.resolved;

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
      !(WIDGET_LAYOUT_MODES as readonly string[]).includes(flags.layout)
    ) {
      throw new ValidationError(
        `Invalid --layout mode "${flags.layout}". Valid values: ${WIDGET_LAYOUT_MODES.join(", ")}`,
        "layout",
      );
    }
    const layoutMode: WidgetLayoutMode =
      flags.layout === "dense" ? "dense" : "sequential";

    // Validate individual layout flag ranges before any network calls
    // (catches --col -1, --width 7, etc. early without needing the dashboard)
    validateWidgetLayout(flags);

    // GET current dashboard → append widget with layout → PUT
    const current = await withDashboardErrors(
      {
        orgSlug,
        dashboardId,
        operation: "view",
      },
      () => getDashboard(orgSlug, dashboardId),
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
        finalLayout,
      );
    }

    updateBody.widgets.push(newWidget);

    const updated = await withDashboardErrors(
      {
        orgSlug,
        dashboardId,
        operation: "update",
      },
      () => updateDashboard(orgSlug, dashboardId, updateBody),
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
