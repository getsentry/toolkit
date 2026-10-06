/**
 * sentry agent-conversation list
 *
 * List recent agent conversations from Sentry projects.
 */

import type { SentryContext } from "../../context.js";
import { listConversations } from "../../lib/api-client.js";
import { validateLimit } from "../../lib/arg-parsing.js";
import {
  advancePaginationState,
  buildPaginationContextKey,
  hasPreviousPage,
  resolveCursor,
} from "../../lib/db/pagination.js";
import { ContextError } from "../../lib/errors.js";
import { formatConversationTable } from "../../lib/formatters/conversation.js";
import { filterFields } from "../../lib/formatters/json.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  buildListCommand,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  LIST_MIN_LIMIT,
  LIST_PERIOD_FLAG,
  PERIOD_ALIASES,
  paginationHint,
} from "../../lib/list-command.js";
import { withProgress } from "../../lib/polling.js";
import { resolveOrg } from "../../lib/resolve-target.js";
import {
  appendPeriodHint,
  serializeTimeRange,
  type TimeRange,
  timeRangeToApiParams,
} from "../../lib/time-range.js";
import {
  type ConversationListItem,
  ConversationListItemSchema,
} from "../../types/conversation.js";

type ListFlags = {
  readonly limit: number;
  readonly query?: string;
  readonly period: TimeRange;
  readonly json: boolean;
  readonly cursor?: string;
  readonly fresh: boolean;
  readonly fields?: string[];
};

type ConversationListResult = {
  conversations: ConversationListItem[];
  hasMore: boolean;
  hasPrev?: boolean;
  nextCursor?: string;
  org: string;
};

const COMMAND_NAME = "agent-conversation list";
const PAGINATION_KEY = "agent-conversation-list";
const DEFAULT_PERIOD = "7d";

function parseLimit(value: string): number {
  return validateLimit(value, LIST_MIN_LIMIT, LIST_MAX_LIMIT);
}

function formatListHuman(result: ConversationListResult): string {
  const { conversations, hasMore, org } = result;
  if (conversations.length === 0) {
    return hasMore
      ? "No conversations on this page."
      : "No agent conversations found.";
  }
  return `Agent conversations in ${org}:\n\n${formatConversationTable(conversations)}`;
}

function jsonTransform(
  result: ConversationListResult,
  fields?: string[]
): unknown {
  const items =
    fields && fields.length > 0
      ? result.conversations.map((c) => filterFields(c, fields))
      : result.conversations;

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

export const listCommand = buildListCommand("agent-conversation", {
  docs: {
    brief: "List recent agent conversations",
    fullDescription:
      "List recent agent conversations from a Sentry organization.\n\n" +
      "Examples:\n" +
      "  sentry agent-conversation list                # List recent conversations\n" +
      "  sentry agent-conversation list my-org         # Explicit org\n" +
      "  sentry agent-conversation list --limit 50     # Show more\n" +
      "  sentry agent-conversation list --period 24h   # Last 24 hours\n" +
      '  sentry agent-conversation list -q "has:errors" # Filter\n',
  },
  output: {
    human: formatListHuman,
    jsonTransform,
    schema: ConversationListItemSchema,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org",
          brief: "Organization slug",
          parse: String,
          optional: true,
        },
      ],
    },
    flags: {
      limit: {
        kind: "parsed",
        parse: parseLimit,
        brief: `Number of conversations (${LIST_MIN_LIMIT}-${LIST_MAX_LIMIT})`,
        default: String(LIST_DEFAULT_LIMIT),
      },
      query: {
        kind: "parsed",
        parse: String,
        brief: "Search query",
        optional: true,
      },
      period: LIST_PERIOD_FLAG,
    },
    aliases: {
      ...PERIOD_ALIASES,
      n: "limit",
      q: "query",
    },
  },
  async *func(this: SentryContext, flags: ListFlags, target?: string) {
    const { cwd } = this;

    const resolved = await resolveOrg({ org: target, cwd });
    if (!resolved) {
      throw new ContextError("Organization", `sentry ${COMMAND_NAME} <org>`);
    }
    const org = resolved.org;

    const contextKey = buildPaginationContextKey("agent-conversation", org, {
      q: flags.query,
      period: serializeTimeRange(flags.period),
    });
    const { cursor, direction } = resolveCursor(
      flags.cursor,
      PAGINATION_KEY,
      contextKey
    );

    const timeParams = timeRangeToApiParams(flags.period);

    const { data: conversations, nextCursor } = await withProgress(
      {
        message: `Fetching conversations (up to ${flags.limit})...`,
        json: flags.json,
      },
      () =>
        listConversations(org, {
          query: flags.query,
          limit: flags.limit,
          cursor,
          ...timeParams,
        })
    );

    advancePaginationState(PAGINATION_KEY, contextKey, direction, nextCursor);
    const hasPrev = hasPreviousPage(PAGINATION_KEY, contextKey);
    const hasMore = !!nextCursor;

    yield new CommandOutput<ConversationListResult>({
      conversations,
      hasMore,
      hasPrev,
      nextCursor,
      org,
    });

    const parts: string[] = [];
    if (flags.query) {
      parts.push(`-q "${flags.query}"`);
    }
    appendPeriodHint(parts, flags.period, DEFAULT_PERIOD);
    const flagSuffix = parts.length > 0 ? ` ${parts.join(" ")}` : "";

    return {
      hint: paginationHint({
        hasMore,
        hasPrev: !!hasPrev,
        nextHint: `sentry agent-conversation list ${org} -c next${flagSuffix}`,
        prevHint: `sentry agent-conversation list ${org} -c prev${flagSuffix}`,
      }),
    };
  },
});
