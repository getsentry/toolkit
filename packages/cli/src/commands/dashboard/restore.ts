/**
 * sentry dashboard restore
 *
 * Restore a dashboard to a previous revision.
 */

import type { SentryContext } from "../../context.js";
import { restoreDashboardRevision } from "../../lib/api-client.js";
import { parseOrgProjectArg } from "../../lib/arg-parsing.js";
import { buildCommand } from "../../lib/command.js";
import { ValidationError } from "../../lib/errors.js";
import { colorTag, escapeMarkdownCell } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { formatRelativeTime } from "../../lib/formatters/time-utils.js";
import { withProgress } from "../../lib/polling.js";
import { buildDashboardUrl } from "../../lib/sentry-urls.js";
import type { DashboardDetail } from "../../types/dashboard.js";
import {
  enrichDashboardError,
  parseDashboardPositionalArgs,
  resolveDashboardId,
  resolveOrgFromTarget,
} from "./resolve.js";

type RestoreFlags = {
  readonly revision: string;
  readonly json: boolean;
  readonly fields?: string[];
};

type RestoreResult = {
  dashboard: DashboardDetail;
  orgSlug: string;
  revisionId: string;
};

function formatRestoreHuman(result: RestoreResult): string {
  const d = result.dashboard;
  const url = buildDashboardUrl(result.orgSlug, d.id);
  const widgetCount = d.widgets?.length ?? 0;
  const created = formatRelativeTime(d.dateCreated);

  return (
    `Restored dashboard **${escapeMarkdownCell(d.title)}** to revision ${result.revisionId}.\n\n` +
    "| Field | Value |\n" +
    "|-------|-------|\n" +
    `| ID | ${d.id} |\n` +
    `| Title | ${escapeMarkdownCell(d.title)} |\n` +
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
      "Use `sentry dashboard revisions` to list available revisions first.\n\n" +
      "Examples:\n" +
      "  sentry dashboard restore 12345 --revision 42\n" +
      "  sentry dashboard restore my-org 12345 --revision 42\n" +
      "  sentry dashboard restore 'My Dashboard' --revision 42\n" +
      "  sentry dashboard restore 12345 --revision 42 --json",
  },
  output: {
    human: formatRestoreHuman,
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        placeholder: "org/dashboard",
        brief: "[<org/project>] <dashboard-id-or-title>",
        parse: String,
      },
    },
    flags: {
      revision: {
        kind: "parsed",
        parse: (value: string) => {
          const revision = value.trim();
          if (!revision) {
            throw new ValidationError(
              "--revision must be a non-empty revision ID.",
              "revision"
            );
          }
          return revision;
        },
        brief: "Revision ID to restore",
      },
    },
    aliases: { r: "revision" },
  },
  async *func(this: SentryContext, flags: RestoreFlags, ...args: string[]) {
    const { cwd } = this;

    const { dashboardRef, targetArg } = parseDashboardPositionalArgs(args);
    const parsed = parseOrgProjectArg(targetArg);
    const orgSlug = await resolveOrgFromTarget(
      parsed,
      cwd,
      "sentry dashboard restore <org>/ <id> --revision <rev>"
    );
    const dashboardId = await resolveDashboardId(orgSlug, dashboardRef);

    const dashboard = await withProgress(
      { message: `Restoring revision ${flags.revision}...`, json: flags.json },
      () => restoreDashboardRevision(orgSlug, dashboardId, flags.revision)
    ).catch(async (error: unknown) =>
      enrichDashboardError(error, {
        orgSlug,
        dashboardId,
        operation: "update",
      })
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
