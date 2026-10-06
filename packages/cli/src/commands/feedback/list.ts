/**
 * sentry feedback list
 *
 * List modern User Feedback from the organization issue index.
 */

import type { SentryContext } from "../../context.js";
import {
  type FeedbackStatus,
  getProject,
  listFeedback,
} from "../../lib/api-client.js";
import { validateLimit } from "../../lib/arg-parsing.js";
import {
  advancePaginationState,
  buildPaginationContextKey,
  hasPreviousPage,
  resolveCursor,
} from "../../lib/db/pagination.js";
import { toSearchQueryError } from "../../lib/errors.js";
import { formatFeedbackList } from "../../lib/formatters/feedback.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  appendQueryHint,
  buildListCommand,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  LIST_MIN_LIMIT,
  PERIOD_ALIASES,
  paginationHint,
  targetPatternExplanation,
} from "../../lib/list-command.js";
import { jsonTransformListResult } from "../../lib/org-list.js";
import { withProgress } from "../../lib/polling.js";
import {
  type ResolvedOrgOptionalTarget,
  resolveOrgOptionalFromArg,
  toNumericId,
} from "../../lib/resolve-target.js";
import { sanitizeQuery } from "../../lib/search-query.js";
import {
  appendPeriodHint,
  PERIOD_BRIEF,
  parsePeriod,
  serializeTimeRange,
  type TimeRange,
  timeRangeToApiParams,
} from "../../lib/time-range.js";
import {
  type FeedbackListResult,
  SentryFeedbackSchema,
} from "../../types/index.js";

const DEFAULT_PERIOD = "14d";
const DEFAULT_STATUS: FeedbackStatus = "unresolved";
const PAGINATION_KEY = "feedback-list";
const COMMAND_NAME = "feedback list";

type ListFlags = {
  readonly status: FeedbackStatus;
  readonly limit: number;
  readonly query?: string;
  readonly period: TimeRange;
  readonly json: boolean;
  readonly cursor?: string;
  readonly fresh: boolean;
  readonly fields?: string[];
};

function parseLimit(value: string): number {
  return validateLimit(value, LIST_MIN_LIMIT, LIST_MAX_LIMIT);
}

function formatScope(org: string, project?: string): string {
  return project ? `${org}/${project}` : `${org}/`;
}

async function projectIdFor(
  resolved: ResolvedOrgOptionalTarget
): Promise<number | undefined> {
  if (!resolved.project) {
    return;
  }
  const project =
    resolved.projectData ?? (await getProject(resolved.org, resolved.project));
  return toNumericId(project.id);
}

function appendFeedbackFlags(
  base: string,
  flags: Pick<ListFlags, "status" | "limit" | "query" | "period">
): string {
  const parts: string[] = [];
  if (flags.status !== DEFAULT_STATUS) {
    parts.push(`--status ${flags.status}`);
  }
  if (flags.limit !== LIST_DEFAULT_LIMIT) {
    parts.push(`--limit ${flags.limit}`);
  }
  appendQueryHint(parts, flags.query);
  appendPeriodHint(parts, flags.period, DEFAULT_PERIOD);
  return parts.length > 0 ? `${base} ${parts.join(" ")}` : base;
}

function pageHint(
  direction: "next" | "prev",
  org: string,
  project: string | undefined,
  flags: Pick<ListFlags, "status" | "limit" | "query" | "period">
): string {
  return appendFeedbackFlags(
    `sentry feedback list ${formatScope(org, project)} -c ${direction}`,
    flags
  );
}

function jsonTransformFeedbackList(
  result: FeedbackListResult,
  fields?: string[]
): unknown {
  return jsonTransformListResult(
    {
      items: result.feedback,
      hasMore: result.hasMore,
      hasPrev: result.hasPrev,
      nextCursor: result.nextCursor,
    },
    fields
  );
}

export const listCommand = buildListCommand("feedback", {
  docs: {
    brief: "List and search User Feedback",
    fullDescription:
      "List modern User Feedback captured by Sentry. Feedback is queried from the issue index with a mandatory category filter.\n\n" +
      "Target patterns:\n" +
      "  sentry feedback list              # auto-detect organization\n" +
      "  sentry feedback list <org>/       # all projects in an organization\n" +
      "  sentry feedback list <org>/<proj> # one project\n" +
      "  sentry feedback list <project>    # find project across organizations\n\n" +
      `${targetPatternExplanation()}\n\n` +
      "Mailboxes:\n" +
      "  unresolved  Inbox feedback (default)\n" +
      "  resolved    Resolved feedback\n" +
      "  spam        Feedback marked as spam\n" +
      "  all         All feedback statuses",
  },
  output: {
    human: formatFeedbackList,
    jsonTransform: jsonTransformFeedbackList,
    schema: SentryFeedbackSchema,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/project",
          brief: "<org>/, <org>/<project>, or <project> (search)",
          parse: String,
          optional: true,
        },
      ],
    },
    flags: {
      status: {
        kind: "enum",
        values: ["unresolved", "resolved", "spam", "all"],
        brief: "Mailbox: unresolved, resolved, spam, or all",
        default: DEFAULT_STATUS,
      },
      limit: {
        kind: "parsed",
        parse: parseLimit,
        brief: `Number of feedback items (${LIST_MIN_LIMIT}-${LIST_MAX_LIMIT})`,
        default: String(LIST_DEFAULT_LIMIT),
      },
      query: {
        kind: "parsed",
        parse: sanitizeQuery,
        brief: "Search query (Sentry issue search syntax)",
        optional: true,
      },
      period: {
        kind: "parsed",
        parse: parsePeriod,
        brief: PERIOD_BRIEF,
        default: DEFAULT_PERIOD,
      },
    },
    aliases: {
      ...PERIOD_ALIASES,
      n: "limit",
      q: "query",
    },
  },
  async *func(this: SentryContext, flags: ListFlags, target?: string) {
    const resolved = await resolveOrgOptionalFromArg(
      target,
      this.cwd,
      COMMAND_NAME
    );
    const projectId = await projectIdFor(resolved);
    const contextKey = buildPaginationContextKey(
      "feedback",
      formatScope(resolved.org, resolved.project),
      {
        status: flags.status,
        limit: String(flags.limit),
        q: flags.query,
        period: serializeTimeRange(flags.period),
      }
    );
    const { cursor, direction } = resolveCursor(
      flags.cursor,
      PAGINATION_KEY,
      contextKey
    );

    const { feedback, nextCursor } = await withProgress(
      {
        message: `Fetching feedback (up to ${flags.limit})...`,
        json: flags.json,
      },
      () =>
        listFeedback(resolved.org, resolved.project ?? "", {
          limit: flags.limit,
          status: flags.status,
          query: flags.query,
          cursor,
          projectId,
          ...timeRangeToApiParams(flags.period),
        }).catch((error: unknown): never => {
          throw toSearchQueryError(error, flags.query);
        })
    );

    advancePaginationState(PAGINATION_KEY, contextKey, direction, nextCursor);
    const hasPrev = hasPreviousPage(PAGINATION_KEY, contextKey);
    const hasMore = Boolean(nextCursor);
    const nav = paginationHint({
      hasPrev,
      hasMore,
      prevHint: pageHint("prev", resolved.org, resolved.project, flags),
      nextHint: pageHint("next", resolved.org, resolved.project, flags),
    });

    let hint: string | undefined;
    if (feedback.length === 0 && nav) {
      hint = `No feedback on this page. ${nav}`;
    } else if (feedback.length > 0) {
      const count = `Showing ${feedback.length} feedback item${feedback.length === 1 ? "" : "s"}.`;
      const first = feedback[0];
      const viewHint = first
        ? `Use 'sentry feedback view ${resolved.org}/${first.shortId}' for details.`
        : undefined;
      hint = nav
        ? `${count} ${nav}`
        : [count, viewHint].filter(Boolean).join(" ");
    }

    yield new CommandOutput({
      feedback,
      hasMore,
      hasPrev,
      nextCursor,
      org: resolved.org,
      project: resolved.project,
    });
    return { hint };
  },
});
