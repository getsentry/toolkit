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
import { numberParser } from "../../../lib/command.js";
import { parseText } from "../../../lib/completion-target.js";
import { ValidationError } from "../../../lib/errors.js";
import { formatWidgetDeleted } from "../../../lib/formatters/human.js";
import { CommandOutput } from "../../../lib/formatters/output.js";
import { buildDeleteCommand } from "../../../lib/mutate-command.js";
import { buildDashboardUrl } from "../../../lib/sentry-web-urls.js";
import {
  type DashboardWidgetDeleteOutput,
  prepareDashboardForUpdate,
} from "../../../types/dashboard.js";
import { type DashboardArguments, dashboardArguments } from "../arguments.js";
import { withDashboardErrors, resolveWidgetIndex } from "../resolve.js";
import { DashboardWidgetDeleteOutputSchema } from "../../../generated/output-schemas/dashboard.js";
import { sentry } from "../../../lib/app-identity.js";

type DeleteFlags = {
  readonly index?: number;
  readonly title?: string;
  readonly yes: boolean;
  readonly force: boolean;
  readonly "dry-run": boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

export const deleteCommand = buildDeleteCommand(
  {
    docs: {
      brief: "Delete a widget from a dashboard",
      fullDescription:
        "Remove a widget from an existing Sentry dashboard.\n\n" +
        "The dashboard can be specified by numeric ID or title.\n" +
        "Identify the widget by --index (0-based) or --title.",
      examples: [
        {
          description: "Delete a widget by title",
          run: "dashboard widget delete 'My Dashboard' --title 'Error Rate'",
        },
        {
          description: "Delete a widget by index",
          run: "dashboard widget delete 12345 --index 0",
        },
        {
          description: "Preview the deletion",
          run: "dashboard widget delete 12345 --index 0 --dry-run",
        },
      ],
    },
    output: {
      human: formatWidgetDeleted,
      schema: DashboardWidgetDeleteOutputSchema,
    },
    parameters: {
      positional: dashboardArguments({
        placeholder: "org/project/dashboard",
        usageHint: () =>
          sentry`dashboard widget delete <org>/ <id> (--index <n> | --title <name>)`,
      }),
      flags: {
        index: {
          kind: "parsed",
          parse: numberParser,
          brief: "Widget index (0-based)",
          optional: true,
        },
        title: {
          kind: "parsed",
          parse: parseText,
          brief: "Widget title to match",
          optional: true,
        },
      },
      aliases: { i: "index", t: "title" },
    },
    async *func(
      this: SentryContext,
      flags: DeleteFlags,
      target: DashboardArguments,
    ) {
      if (flags.index === undefined && !flags.title) {
        throw new ValidationError(
          "Specify --index or --title to identify the widget to delete.",
          "index",
        );
      }

      const { orgSlug, dashboardId } = await target.resolved;

      // GET current dashboard → find widget
      const current = await withDashboardErrors(
        {
          orgSlug,
          dashboardId,
          operation: "view",
        },
        () => getDashboard(orgSlug, dashboardId),
      );
      const widgets = current.widgets ?? [];

      const widgetIndex = resolveWidgetIndex(widgets, flags.index, flags.title);
      const widgetTitle = widgets[widgetIndex]?.title ?? "";
      const url = buildDashboardUrl(orgSlug, dashboardId);

      // Dry-run mode: show what would be removed without removing it
      if (flags["dry-run"]) {
        yield new CommandOutput({
          dryRun: true,
          widgetTitle,
          widgetCount: widgets.length,
          url,
        });
        return { hint: `Dashboard: ${url}` };
      }

      // Splice the widget and PUT the updated dashboard
      const updateBody = prepareDashboardForUpdate(current);
      updateBody.widgets.splice(widgetIndex, 1);

      const updated = await withDashboardErrors(
        {
          orgSlug,
          dashboardId,
          operation: "update",
        },
        () => updateDashboard(orgSlug, dashboardId, updateBody),
      );

      yield new CommandOutput({
        deleted: true,
        widgetTitle,
        widgetCount: updated.widgets?.length ?? 0,
        url,
      });
      return { hint: `Dashboard: ${url}` };
    },
  },
  { noNonInteractiveGuard: true },
);
