/**
 * sentry dashboard restore
 *
 * Restore a dashboard to a previous revision.
 */

import { tableCell } from "@sentry/toolkit-core/markdown";
import type { SentryContext } from "../../context.js";
import { restoreDashboardRevision } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { textParser } from "../../lib/completion-target.js";
import { ValidationError } from "../../lib/errors.js";
import { colorTag } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { formatRelativeTime } from "../../lib/formatters/time-utils.js";
import { withProgress } from "../../lib/polling.js";
import { buildDashboardUrl } from "../../lib/sentry-web-urls.js";
import { DashboardRestoreOutputSchema } from "../../generated/output-schemas/dashboard.js";
import type { DashboardRestoreOutput } from "../../output-schemas/dashboard.js";
import { type DashboardArguments, dashboardArguments } from "./arguments.js";
import { withDashboardErrors } from "./resolve.js";
import { sentry } from "../../lib/app-identity.js";

type RestoreFlags = {
  readonly revision: string;
  readonly json: boolean;
  readonly fields?: string[];
};

type RestoreResult = DashboardRestoreOutput;

function formatRestoreHuman(result: RestoreResult): string {
  const d = result.dashboard;
  const url = buildDashboardUrl(result.orgSlug, d.id);
  const widgetCount = d.widgets?.length ?? 0;
  const created = formatRelativeTime(d.dateCreated);

  return (
    `Restored dashboard **${tableCell(d.title)}** to revision ${result.revisionId}.\n\n` +
    "| Field | Value |\n" +
    "|-------|-------|\n" +
    `| ID | ${d.id} |\n` +
    `| Title | ${tableCell(d.title)} |\n` +
    `| Widgets | ${widgetCount} |\n` +
    `| Created | ${created} |\n` +
    `| URL | ${colorTag("muted", url)} |`
  );
}

export const restoreCommand = buildCommand({
  docs: {
    brief: "Restore a dashboard revision",
    fullDescription:
      "Restore a Sentry dashboard to a previous revision.\n\n" +
      "Use `sentry dashboard revisions` to list available revisions first.",
    examples: [
      {
        description: "Restore by dashboard title and revision number",
        run: "dashboard restore 'Frontend Performance' --revision 3",
      },
      {
        description: "Restore by dashboard ID",
        run: "dashboard restore 12345 --revision 42",
      },
      {
        description: "Pass the organization explicitly",
        run: "dashboard restore my-org/ 12345 --revision 42",
      },
      {
        description: "Output the restored dashboard as JSON",
        run: "dashboard restore 12345 --revision 42 --json",
      },
    ],
  },
  output: {
    human: formatRestoreHuman,
    schema: DashboardRestoreOutputSchema,
  },
  parameters: {
    positional: dashboardArguments({
      placeholder: "org/dashboard",
      usageHint: () => sentry`dashboard restore <org>/ <id> --revision <rev>`,
    }),
    flags: {
      revision: {
        kind: "parsed",
        parse: textParser((value: string) => {
          const revision = value.trim();
          if (!revision) {
            throw new ValidationError(
              "--revision must be a non-empty revision ID.",
              "revision",
            );
          }
          return revision;
        }),
        brief: "Revision ID to restore",
      },
    },
    aliases: { r: "revision" },
  },
  async *func(
    this: SentryContext,
    flags: RestoreFlags,
    target: DashboardArguments,
  ) {
    const { orgSlug, dashboardId } = await target.resolved;

    const dashboard = await withDashboardErrors(
      {
        orgSlug,
        dashboardId,
        operation: "update",
      },
      () =>
        withProgress(
          {
            message: `Restoring revision ${flags.revision}...`,
            json: flags.json,
          },
          () => restoreDashboardRevision(orgSlug, dashboardId, flags.revision),
        ),
    );

    const outputData: RestoreResult = {
      dashboard,
      orgSlug,
      revisionId: flags.revision,
    };
    yield new CommandOutput(outputData);

    const url = buildDashboardUrl(orgSlug, dashboardId);
    return {
      hint: `Dashboard restored. View: ${url}`,
    };
  },
});
