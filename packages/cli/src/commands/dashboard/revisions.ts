/**
 * sentry dashboard revisions
 *
 * List revision history for a Sentry dashboard with cursor-based pagination.
 */

import type { SentryContext } from "../../context.js";
import { paginate } from "../../lib/api/infrastructure.js";
import { listDashboardRevisionsPaginated } from "../../lib/api-client.js";
import { parseOrgProjectArg } from "../../lib/arg-parsing.js";
import { buildCommand } from "../../lib/command.js";
import { parseOrgProjectTarget } from "../../lib/completion-target.js";
import {
  advancePaginationState,
  buildPaginationContextKey,
  hasPreviousPage,
  resolveCursor,
} from "../../lib/db/pagination.js";
import { filterFields } from "../../lib/formatters/json.js";
import { colorTag, escapeMarkdownCell } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { type Column, writeTable } from "../../lib/formatters/table.js";
import { formatRelativeTime } from "../../lib/formatters/time-utils.js";
import {
  buildListLimitFlag,
  LIST_CURSOR_FLAG,
  paginationHint,
} from "../../lib/list-command.js";
import { withProgress } from "../../lib/polling.js";
import { buildDashboardUrl } from "../../lib/sentry-web-urls.js";
import type { DashboardRevision } from "../../types/dashboard.js";
import type { Writer } from "../../types/index.js";
import {
  withDashboardErrors,
  parseDashboardPositionalArgs,
  resolveDashboardId,
  resolveOrgFromTarget,
} from "./resolve.js";

const PAGINATION_KEY = "dashboard-revisions";

type RevisionsFlags = {
  readonly limit: number;
  readonly cursor?: string;
  readonly json: boolean;
  readonly fields?: string[];
};

type RevisionsResult = {
  revisions: DashboardRevision[];
  orgSlug: string;
  dashboardId: string;
  hasMore: boolean;
  hasPrev?: boolean;
  nextCursor?: string;
};

function formatRevisionsHuman(result: RevisionsResult): string {
  if (result.revisions.length === 0) {
    return "No revisions found.";
  }

  type RevisionRow = {
    id: string;
    title: string;
    author: string;
    created: string;
  };

  const rows: RevisionRow[] = result.revisions.map((r) => ({
    id: r.id,
    title: escapeMarkdownCell(r.title),
    author: escapeMarkdownCell(
      r.createdBy?.name ?? r.createdBy?.email ?? r.createdBy?.id ?? "—",
    ),
    created: `${escapeMarkdownCell(formatRelativeTime(r.dateCreated))}\n${colorTag("muted", r.dateCreated)}`,
  }));

  const columns: Column<RevisionRow>[] = [
    { header: "ID", value: (r) => r.id },
    { header: "TITLE", value: (r) => r.title },
    { header: "AUTHOR", value: (r) => r.author },
    { header: "CREATED", value: (r) => r.created },
  ];

  const parts: string[] = [];
  const buffer: Writer = { write: (s: string) => parts.push(s) };
  writeTable(buffer, rows, columns);

  return parts.join("").trimEnd();
}

function jsonTransformRevisions(
  result: RevisionsResult,
  fields?: string[],
): unknown {
  const items =
    fields && fields.length > 0
      ? result.revisions.map((r) => filterFields(r, fields))
      : result.revisions;

  const envelope: Record<string, unknown> = {
    data: items,
    hasMore: result.hasMore,
    hasPrev: !!result.hasPrev,
  };
  if (result.nextCursor) {
    envelope.nextCursor = result.nextCursor;
  }
  return envelope;
}

export const revisionsCommand = buildCommand({
  docs: {
    brief: "List dashboard revisions",
    fullDescription:
      "List revision history for a Sentry dashboard.\n\n" +
      "Shows saved revisions with their IDs, titles, authors, and timestamps.\n" +
      "Use `sentry dashboard restore` to revert to a previous revision.",
    examples: [
      {
        description: "List revisions by dashboard title",
        command: "sentry dashboard revisions 'Frontend Performance'",
      },
      {
        description: "List revisions by dashboard ID",
        command: "sentry dashboard revisions 12345",
      },
      {
        description: "Pass the organization explicitly",
        command: "sentry dashboard revisions my-org 12345",
      },
      {
        description: "Fetch the next page",
        command: "sentry dashboard revisions my-org 12345 -c next",
      },
      {
        description: "Output as JSON",
        command: "sentry dashboard revisions my-org 12345 --json",
      },
    ],
  },
  output: {
    human: formatRevisionsHuman,
    jsonTransform: jsonTransformRevisions,
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        placeholder: "org/dashboard",
        brief: "[<org/project>] <dashboard-id-or-title>",
        parse: parseOrgProjectTarget,
      },
    },
    flags: {
      limit: buildListLimitFlag("revisions"),
      cursor: LIST_CURSOR_FLAG,
    },
    aliases: { n: "limit", c: "cursor" },
  },
  async *func(this: SentryContext, flags: RevisionsFlags, ...args: string[]) {
    const { cwd } = this;

    const { dashboardRef, targetArg } = parseDashboardPositionalArgs(args);
    const parsed = parseOrgProjectArg(targetArg);
    const orgSlug = await resolveOrgFromTarget(
      parsed,
      cwd,
      "sentry dashboard revisions <org>/ <id>",
    );
    const dashboardId = await resolveDashboardId(orgSlug, dashboardRef);

    const contextKey = buildPaginationContextKey(
      "dashboard-revisions",
      `${orgSlug}/${dashboardId}`,
      {},
    );
    const { cursor: rawCursor, direction } = resolveCursor(
      flags.cursor,
      PAGINATION_KEY,
      contextKey,
    );

    const { data: revisions, nextCursor } = await withDashboardErrors(
      {
        orgSlug,
        dashboardId,
        operation: "view",
      },
      () =>
        withProgress(
          { message: "Fetching revisions...", json: flags.json },
          () =>
            paginate(
              { limit: flags.limit, cursor: rawCursor },
              (perPage, pageCursor) =>
                listDashboardRevisionsPaginated(orgSlug, dashboardId, {
                  perPage,
                  cursor: pageCursor,
                }),
            ),
        ),
    );
    const hasMore = nextCursor !== undefined;

    advancePaginationState(PAGINATION_KEY, contextKey, direction, nextCursor);
    const hasPrev = hasPreviousPage(PAGINATION_KEY, contextKey);

    const outputData: RevisionsResult = {
      revisions,
      orgSlug,
      dashboardId,
      hasMore,
      hasPrev: hasPrev || undefined,
      nextCursor,
    };
    yield new CommandOutput(outputData);

    const url = buildDashboardUrl(orgSlug, dashboardId);
    const nav = paginationHint({
      hasPrev: !!hasPrev,
      hasMore,
      prevHint: `sentry dashboard revisions ${orgSlug}/ ${dashboardId} -c prev`,
      nextHint: `sentry dashboard revisions ${orgSlug}/ ${dashboardId} -c next`,
    });
    const navStr = nav ? ` ${nav}` : "";

    if (revisions.length === 0) {
      return { hint: nav ? `No revisions found.${navStr}` : undefined };
    }

    return {
      hint:
        `Showing ${revisions.length} revision(s) for dashboard ${dashboardId}.${navStr}\n` +
        `Restore: sentry dashboard restore ${orgSlug}/ ${dashboardId} --revision <revision-id>\n` +
        `Dashboard: ${url}`,
    };
  },
});
