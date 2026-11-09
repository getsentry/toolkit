/**
 * sentry issue events
 *
 * List events for a specific Sentry issue.
 */

import type { SentryContext } from "../../context.js";
import { listIssueEvents } from "../../lib/api-client.js";
import { sentry } from "../../lib/app-identity.js";
import { issueSelectorHelp } from "../../lib/arg-parsing.js";
import {
  advancePaginationState,
  buildPaginationContextKey,
  hasPreviousPage,
  resolveCursor,
} from "../../lib/db/pagination.js";
import { toSearchQueryError } from "../../lib/errors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { buildListCommand, paginationHint } from "../../lib/list-command.js";
import { withProgress } from "../../lib/polling.js";
import {
  serializeTimeRange,
  timeRangeToApiParams,
} from "../../lib/time-range.js";
import {
  appendEventsFlags,
  EVENTS_ALIASES,
  EVENTS_FLAGS,
  type EventsFlags,
  formatEventsHuman,
  jsonTransformEvents,
} from "../event/shared-events.js";
import { type IssueTarget, issuePositional } from "./positional.js";
import { IssueEventSchema } from "../../generated/output-schemas/event.js";

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
  flags: Pick<EventsFlags, "query" | "full" | "period">,
): string {
  return appendEventsFlags(sentry`issue events ${issueArg} -c next`, flags);
}

/** Build the CLI hint for fetching the previous page, preserving active flags. */
function prevPageHint(
  issueArg: string,
  flags: Pick<EventsFlags, "query" | "full" | "period">,
): string {
  return appendEventsFlags(sentry`issue events ${issueArg} -c prev`, flags);
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
      issueSelectorHelp() +
      "  <org>/ID         - Explicit org: sentry/EXTENSION-7\n" +
      "  <project>-suffix - Project + suffix: cli-G\n" +
      "  ID               - Short ID: CLI-G\n" +
      "  numeric          - Numeric ID: 123456789",
    examples: [
      {
        description: "List recent events for an issue",
        run: "issue events FRONT-ABC",
      },
      {
        description: "List events for the most recent issue",
        run: "issue events @latest --limit 50",
      },
      {
        description: "Filter events by search query",
        run: 'issue events FRONT-ABC --query "browser:Chrome"',
      },
      {
        description: "Show full event details",
        run: "issue events FRONT-ABC --full",
      },
      {
        description: "Limit results and filter by time period",
        run: "issue events FRONT-ABC --limit 50 --period 24h",
      },
      {
        description: "Fetch the next page",
        run: "issue events FRONT-ABC -c next",
      },
      {
        description: "Output as JSON",
        run: "issue events FRONT-ABC --json",
      },
    ],
  },
  output: {
    human: formatEventsHuman,
    jsonTransform: jsonTransformEvents,
    schema: IssueEventSchema,
  },
  parameters: {
    positional: issuePositional({ command: COMMAND_NAME }),
    flags: EVENTS_FLAGS,
    aliases: EVENTS_ALIASES,
  },
  async *func(this: SentryContext, flags: EventsFlags, target: IssueTarget) {
    const issueArg = target.raw ?? "";
    const timeRange = flags.period;

    // Resolve issue using shared resolution logic (supports @latest, short IDs, etc.)
    const { org, issue } = await target.resolved;

    // Build context key for pagination (keyed by issue ID + query-varying params)
    const contextKey = buildPaginationContextKey(
      "issue-events",
      `${org}/${issue.id}`,
      { q: flags.query, period: serializeTimeRange(timeRange) },
    );
    const { cursor, direction } = resolveCursor(
      flags.cursor,
      PAGINATION_KEY,
      contextKey,
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
        }),
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
        : `${countText} Use '${sentry`event view <EVENT_ID>`}' to view full event details.`;
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
