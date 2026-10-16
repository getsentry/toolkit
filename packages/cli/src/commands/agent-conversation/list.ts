/**
 * sentry agent-conversation list
 *
 * List recent agent conversations from Sentry projects.
 */

import type { SentryContext } from "../../context.js";
import { getProject, listConversations } from "../../lib/api-client.js";
import { validateLimit } from "../../lib/arg-parsing.js";
import {
  advancePaginationState,
  buildPaginationContextKey,
  hasPreviousPage,
  resolveCursor,
} from "../../lib/db/pagination.js";
import { formatConversationTable } from "../../lib/formatters/conversation.js";
import { filterFields } from "../../lib/formatters/json.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  appendQueryHint,
  appendSortHint,
  buildListCommand,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  LIST_MIN_LIMIT,
  LIST_PERIOD_FLAG,
  LIST_TARGET_POSITIONAL,
  PERIOD_ALIASES,
  paginationHint,
  targetPatternExplanation,
} from "../../lib/list-command.js";
import { withProgress } from "../../lib/polling.js";
import {
  resolveOrgOptionalFromArg,
  toNumericId,
} from "../../lib/resolve-target.js";
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

const CONVERSATION_SORT_FIELDS = [
  "conversation.age",
  "conversation.timeSpan",
  "conversation.generationDuration",
  "conversation.errors",
  "conversation.llmCalls",
  "conversation.toolCalls",
  "conversation.toolErrors",
  "conversation.inputTokens",
  "conversation.outputTokens",
  "conversation.totalTokens",
  "conversation.totalCost",
] as const;

type ConversationSortField = (typeof CONVERSATION_SORT_FIELDS)[number];
type ConversationSort = ConversationSortField | `-${ConversationSortField}`;

const CONVERSATION_SORT_VALUES = CONVERSATION_SORT_FIELDS.flatMap(
  (field): ConversationSort[] => [field, `-${field}`],
);

type ListFlags = {
  readonly limit: number;
  readonly query?: string;
  readonly sort?: ConversationSort;
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
  project?: string;
};

const COMMAND_NAME = "agent-conversation list";
const PAGINATION_KEY = "agent-conversation-list";
const DEFAULT_PERIOD = "7d";

function parseLimit(value: string): number {
  return validateLimit(value, LIST_MIN_LIMIT, LIST_MAX_LIMIT);
}

function formatListHuman(result: ConversationListResult): string {
  const { conversations, hasMore, org, project } = result;
  if (conversations.length === 0) {
    return hasMore
      ? "No conversations on this page."
      : "No agent conversations found.";
  }
  const scope = project ? `${org}/${project}` : `${org} (all projects)`;
  return `Agent conversations in ${scope}:\n\n${formatConversationTable(conversations)}`;
}

function jsonTransform(
  result: ConversationListResult,
  fields?: string[],
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
      "List recent agent conversations from Sentry projects.\n\n" +
      "Sort by one canonical conversation.* field. Prefix the field with - for descending order. " +
      "The default is -conversation.age, and conversation ID ascending breaks ties. " +
      "conversation.timeSpan measures elapsed time; conversation.generationDuration sums model call duration.\n\n" +
      "Target patterns:\n" +
      "  sentry agent-conversation list              # Auto-detect organization\n" +
      "  sentry agent-conversation list <org>/       # All projects in an organization\n" +
      "  sentry agent-conversation list <org>/<proj> # One project\n" +
      "  sentry agent-conversation list <project>    # Find project across organizations\n\n" +
      targetPatternExplanation(),
    examples: [
      {
        description: "List recent agent conversations",
        command: "sentry agent-conversation list",
      },
      {
        description: "Explicit organization (all projects)",
        command: "sentry agent-conversation list my-org/",
      },
      {
        description: "One project",
        command: "sentry agent-conversation list my-org/my-project",
      },
      {
        description: "Find a project across organizations",
        command: "sentry agent-conversation list my-project",
      },
      {
        description: "Show more, last 24 hours",
        command: "sentry agent-conversation list --limit 50 --period 24h",
      },
      {
        description: "Sort by highest error count",
        command: "sentry agent-conversation list --sort -conversation.errors",
      },
      {
        description: "Sort by lowest total cost",
        command: "sentry agent-conversation list --sort conversation.totalCost",
      },
      {
        description: "Find conversations with errors",
        command: 'sentry agent-conversation list -q "conversation.errors:>0"',
      },
      {
        description: "Find conversations for an agent",
        command:
          'sentry agent-conversation list -q "gen_ai.agent.name:my-agent"',
      },
      {
        description: "Find conversations with more than two tool calls",
        command:
          'sentry agent-conversation list -q "conversation.toolCalls:>2"',
      },
      {
        description: "Find conversations that used a tool",
        command:
          'sentry agent-conversation list -q "gen_ai.tool.name:search_issues"',
      },
      {
        description: "Paginate through project results",
        command: "sentry agent-conversation list my-org/my-project -c next",
      },
    ],
  },
  output: {
    human: formatListHuman,
    jsonTransform,
    schema: ConversationListItemSchema,
  },
  parameters: {
    positional: LIST_TARGET_POSITIONAL,
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
        brief:
          "Any matching span selects its conversation; totals include all spans in selected projects and time range",
        optional: true,
      },
      sort: {
        kind: "enum",
        values: CONVERSATION_SORT_VALUES,
        brief:
          "One conversation field; prefix - for descending (default: -conversation.age; ID breaks ties)",
        optional: true,
      },
      period: LIST_PERIOD_FLAG,
    },
    aliases: {
      ...PERIOD_ALIASES,
      n: "limit",
      q: "query",
      s: "sort",
    },
  },
  async *func(this: SentryContext, flags: ListFlags, target?: string) {
    const { cwd } = this;

    const resolved = await resolveOrgOptionalFromArg(target, cwd, COMMAND_NAME);
    const { org, project } = resolved;
    let projectId: number | undefined;
    if (project) {
      const projectData =
        resolved.projectData ?? (await getProject(org, project));
      projectId = toNumericId(projectData.id);
    }
    const scope = project ? `${org}/${project}` : `${org}/`;

    const contextKey = buildPaginationContextKey("agent-conversation", scope, {
      q: flags.query,
      sort: flags.sort,
      period: serializeTimeRange(flags.period),
    });
    const { cursor, direction } = resolveCursor(
      flags.cursor,
      PAGINATION_KEY,
      contextKey,
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
          sort: flags.sort,
          limit: flags.limit,
          cursor,
          project: projectId === undefined ? undefined : String(projectId),
          ...timeParams,
        }),
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
      project,
    });

    const parts: string[] = [];
    appendQueryHint(parts, flags.query);
    appendSortHint(parts, flags.sort);
    appendPeriodHint(parts, flags.period, DEFAULT_PERIOD);
    const flagSuffix = parts.length > 0 ? ` ${parts.join(" ")}` : "";

    return {
      hint: paginationHint({
        hasMore,
        hasPrev: !!hasPrev,
        nextHint: `sentry agent-conversation list ${scope} -c next${flagSuffix}`,
        prevHint: `sentry agent-conversation list ${scope} -c prev${flagSuffix}`,
      }),
    };
  },
});
