/**
 * sentry issue events
 *
 * List events for a specific Sentry issue.
 */

import type { SentryContext } from "../../context.js";
import { listIssueEvents } from "../../lib/api-client.js";
import {
  advancePaginationState,
  buildPaginationContextKey,
  hasPreviousPage,
  resolveCursor,
} from "../../lib/db/pagination.js";
import { ContextError, toSearchQueryError } from "../../lib/errors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { buildListCommand, paginationHint } from "../../lib/list-command.js";
import { withProgress } from "../../lib/polling.js";
import {
  serializeTimeRange,
  timeRangeToApiParams,
} from "../../lib/time-range.js";
import { IssueEventSchema } from "../../types/index.js";
import {
  appendEventsFlags,
  EVENTS_ALIASES,
  EVENTS_FLAGS,
  type EventsFlags,
  formatEventsHuman,
  jsonTransformEvents,
} from "../event/shared-events.js";
import { buildCommandHint, issueIdPositional, resolveIssue } from "./utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Command name used in issue resolution error messages */
const COMMAND_NAME = "events";

/** Command key for pagination cursor storage */
export const PAGINATION_KEY = "issue-events";

// ---------------------------------------------------------------------------
// Pagination hints
// ---------------------------------------------------------------------------

/** Build the CLI hint for fetching the next page, preserving active flags. */
function nextPageHint(
  issueArg: string,
  flags: Pick<EventsFlags, "query" | "full" | "period">
): string {
  return appendEventsFlags(`sentry issue events ${issueArg} -c next`, flags);
}

/** Build the CLI hint for fetching the previous page, preserving active flags. */
function prevPageHint(
  issueArg: string,
  flags: Pick<EventsFlags, "query" | "full" | "period">
): string {
  return appendEventsFlags(`sentry issue events ${issueArg} -c prev`, flags);
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export const eventsCommand = buildListCommand("issue", {
  docs: {
    brief: "List events for a specific issue",
    fullDescription:
      "List events belonging to a Sentry issue.\n\n" +
      "Issue formats:\n" +
      "  @latest          - Most recent unresolved issue\n" +
      "  @most_frequent   - Issue with highest event frequency\n" +
      "  <org>/ID         - Explicit org: sentry/EXTENSION-7\n" +
      "  <project>-suffix - Project + suffix: cli-G\n" +
      "  ID               - Short ID: CLI-G\n" +
      "  numeric          - Numeric ID: 123456789\n\n" +
      "Examples:\n" +
      "  sentry issue events CLI-G\n" +
      "  sentry issue events @latest --limit 50\n" +
      "  sentry issue events 123456789 --full\n" +
      '  sentry issue events CLI-G -q "user.email:foo@bar.com"\n' +
      "  sentry issue events CLI-G --json",
  },
  output: {
    human: formatEventsHuman,
    jsonTransform: jsonTransformEvents,
    schema: IssueEventSchema,
  },
  parameters: {
    positional: issueIdPositional,
    flags: EVENTS_FLAGS,
    aliases: EVENTS_ALIASES,
  },
  async *func(this: SentryContext, flags: EventsFlags, issueArg: string) {
    const { cwd } = this;
    const timeRange = flags.period;

    // Resolve issue using shared resolution logic (supports @latest, short IDs, etc.)
    const { org, issue } = await resolveIssue({
      issueArg,
      cwd,
      command: COMMAND_NAME,
    });

    // Org is required for region-routed events endpoint
    if (!org) {
      throw new ContextError(
        "Organization",
        buildCommandHint(COMMAND_NAME, issueArg)
      );
    }

    // Build context key for pagination (keyed by issue ID + query-varying params)
    const contextKey = buildPaginationContextKey(
      "issue-events",
      `${org}/${issue.id}`,
      { q: flags.query, period: serializeTimeRange(timeRange) }
    );
    const { cursor, direction } = resolveCursor(
      flags.cursor,
      PAGINATION_KEY,
      contextKey
    );

    const { data: events, nextCursor } = await withProgress(
      {
        message: `Fetching events for ${issue.shortId} (up to ${flags.limit})...`,
        json: flags.json,
      },
      () =>
        listIssueEvents(org, issue.id, {
          limit: flags.limit,
          query: flags.query,
          full: flags.full,
          cursor,
          ...timeRangeToApiParams(timeRange),
        }).catch((error: unknown): never => {
          // An unparseable user --query is a user input mistake, not a CLI bug.
          throw toSearchQueryError(error, flags.query);
        })
    );

    // Update pagination state (handles both advance and truncation)
    advancePaginationState(PAGINATION_KEY, contextKey, direction, nextCursor);
    const hasPrev = hasPreviousPage(PAGINATION_KEY, contextKey);

    const hasMore = !!nextCursor;

    // Build footer hint based on result state
    const nav = paginationHint({
      hasMore,
      hasPrev,
      prevHint: prevPageHint(issueArg, flags),
      nextHint: nextPageHint(issueArg, flags),
    });
    let hint: string | undefined;
    if (events.length === 0 && nav) {
      hint = `No events on this page. ${nav}`;
    } else if (events.length > 0) {
      const countText = `Showing ${events.length} event${events.length === 1 ? "" : "s"}.`;
      hint = nav
        ? `${countText} ${nav}`
        : `${countText} Use 'sentry event view <EVENT_ID>' to view full event details.`;
    }

    yield new CommandOutput({
      events,
      hasMore,
      hasPrev,
      nextCursor,
      issueShortId: issue.shortId,
      issueId: issue.id,
    });
    return { hint };
  },
});
