/**
 * sentry dashboard widget delete
 *
 * Remove a widget from an existing dashboard.
 *
 * Uses `buildDeleteCommand` — auto-injects `--yes`/`--force`/`--dry-run`
 * flags. Non-interactive guard is disabled (`noNonInteractiveGuard`) because
 * widget deletion is reversible (re-add the widget). `--yes`/`--force` are
 * accepted but have no effect today (no confirmation prompt); `--dry-run`
 * shows which widget would be removed without modifying the dashboard.
 */

import type { SentryContext } from "../../../context.js";
import { getDashboard, updateDashboard } from "../../../lib/api-client.js";
import { parseOrgProjectArg } from "../../../lib/arg-parsing.js";
import { numberParser } from "../../../lib/command.js";
import { ValidationError } from "../../../lib/errors.js";
import { formatWidgetDeleted } from "../../../lib/formatters/human.js";
import { CommandOutput } from "../../../lib/formatters/output.js";
import { buildDeleteCommand } from "../../../lib/mutate-command.js";
import { buildDashboardUrl } from "../../../lib/sentry-urls.js";
import {
  type DashboardDetail,
  prepareDashboardForUpdate,
} from "../../../types/dashboard.js";
import {
  enrichDashboardError,
  parseDashboardPositionalArgs,
  resolveDashboardId,
  resolveOrgFromTarget,
  resolveWidgetIndex,
} from "../resolve.js";

type DeleteFlags = {
  readonly index?: number;
  readonly title?: string;
  readonly yes: boolean;
  readonly force: boolean;
  readonly "dry-run": boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

type DeleteResult = {
  dashboard: DashboardDetail;
  widgetTitle: string;
  url: string;
  dryRun?: boolean;
};

export const deleteCommand = buildDeleteCommand(
  {
    docs: {
      brief: "Delete a widget from a dashboard",
      fullDescription:
        "Remove a widget from an existing Sentry dashboard.\n\n" +
        "The dashboard can be specified by numeric ID or title.\n" +
        "Identify the widget by --index (0-based) or --title.\n\n" +
        "Examples:\n" +
        "  sentry dashboard widget delete 12345 --index 0\n" +
        "  sentry dashboard widget delete 'My Dashboard' --title 'Error Rate'\n" +
        "  sentry dashboard widget delete 12345 --index 0 --dry-run",
    },
    output: {
      human: formatWidgetDeleted,
      jsonTransform: (result: DeleteResult) => {
        if (result.dryRun) {
          return {
            dryRun: true,
            widgetTitle: result.widgetTitle,
            widgetCount: result.dashboard.widgets?.length ?? 0,
            url: result.url,
          };
        }
        return {
          deleted: true,
          widgetTitle: result.widgetTitle,
          widgetCount: result.dashboard.widgets?.length ?? 0,
          url: result.url,
        };
      },
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
        index: {
          kind: "parsed",
          parse: numberParser,
          brief: "Widget index (0-based)",
          optional: true,
        },
        title: {
          kind: "parsed",
          parse: String,
          brief: "Widget title to match",
          optional: true,
        },
      },
      aliases: { i: "index", t: "title" },
    },
    async *func(this: SentryContext, flags: DeleteFlags, ...args: string[]) {
      const { cwd } = this;

      if (flags.index === undefined && !flags.title) {
        throw new ValidationError(
          "Specify --index or --title to identify the widget to delete.",
          "index"
        );
      }

      const { dashboardRef, targetArg } = parseDashboardPositionalArgs(args);
      const parsed = parseOrgProjectArg(targetArg);
      const orgSlug = await resolveOrgFromTarget(
        parsed,
        cwd,
        "sentry dashboard widget delete <org>/ <id> (--index <n> | --title <name>)"
      );
      const dashboardId = await resolveDashboardId(orgSlug, dashboardRef);

      // GET current dashboard → find widget
      const current = await getDashboard(orgSlug, dashboardId).catch(
        async (error: unknown) =>
          enrichDashboardError(error, {
            orgSlug,
            dashboardId,
            operation: "view",
          })
      );
      const widgets = current.widgets ?? [];

      const widgetIndex = resolveWidgetIndex(widgets, flags.index, flags.title);
      const widgetTitle = widgets[widgetIndex]?.title;
      const url = buildDashboardUrl(orgSlug, dashboardId);

      // Dry-run mode: show what would be removed without removing it
      if (flags["dry-run"]) {
        yield new CommandOutput({
          dashboard: current,
          widgetTitle,
          url,
          dryRun: true,
        } as DeleteResult);
        return { hint: `Dashboard: ${url}` };
      }

      // Splice the widget and PUT the updated dashboard
      const updateBody = prepareDashboardForUpdate(current);
      updateBody.widgets.splice(widgetIndex, 1);

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

      yield new CommandOutput({
        dashboard: updated,
        widgetTitle,
        url,
      } as DeleteResult);
      return { hint: `Dashboard: ${url}` };
    },
  },
  { noNonInteractiveGuard: true }
);
