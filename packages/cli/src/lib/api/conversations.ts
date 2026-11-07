/**
 * Agent conversations API functions
 *
 * Functions for listing and retrieving agent conversation data from the Sentry
 * Explore agent conversations endpoints.
 *
 * Both endpoints use their generated `@sentry/api` operations, and their
 * responses are still checked with the CLI's own schemas
 * (`ConversationListItemSchema`, `AgentConversationDetailsSchema`).
 * Pagination follows the `Link` header.
 */

import {
  type ListOrganizationAiConversationsData,
  listOrganizationAiConversations,
  retrieveOrganizationAiConversation,
} from "@sentry/api";
import { array } from "valibot";

import {
  type AgentConversationDetails,
  AgentConversationDetailsSchema,
  type AgentConversationSpan,
  type ConversationListItem,
  ConversationListItemSchema,
  type ConversationStats,
} from "../../types/conversation.js";

import { logger } from "../logger.js";
import { resolveOrgRegion } from "../region.js";
import { getSdkClientConfig } from "../sentry-sdk-client.js";

import {
  API_MAX_PER_PAGE,
  getOrgSdkConfig,
  MAX_PAGINATION_PAGES,
  type PaginatedResponse,
  paginate,
  unwrapPaginatedResult,
  validateResponse,
} from "./infrastructure.js";

const log = logger.withTag("api.conversations");

type ConversationListOptions = {
  query?: string;
  sort?: NonNullable<ListOrganizationAiConversationsData["query"]>["sort"];
  cursor?: string;
  statsPeriod?: string;
  start?: string;
  end?: string;
  project?: string;
};

/**
 * Fetch a single page of conversations from the agent conversations endpoint.
 *
 * Internal helper used by {@link listConversations} for both single-page and
 * multi-page (auto-paginating) fetches.
 */
async function fetchConversationsPage(
  regionUrl: string,
  orgSlug: string,
  options: ConversationListOptions,
  perPage: number,
): Promise<PaginatedResponse<ConversationListItem[]>> {
  const result = await listOrganizationAiConversations({
    ...getSdkClientConfig(regionUrl),
    path: { organization_id_or_slug: orgSlug },
    query: {
      per_page: perPage,
      statsPeriod: options.statsPeriod || undefined,
      start: options.start || undefined,
      end: options.end || undefined,
      cursor: options.cursor || undefined,
      query: options.query || undefined,
      sort: options.sort,
      project: options.project ? [options.project] : undefined,
    },
  });
  const page = unwrapPaginatedResult<unknown>(
    result,
    "Failed to list agent conversations",
  );
  const data = validateResponse(
    array(ConversationListItemSchema),
    page.data,
    `/organizations/${orgSlug}/agents/conversations/`,
    page.response?.status ?? 0,
  );
  return { data, nextCursor: page.nextCursor };
}

/**
 * List agent conversations for an organization.
 *
 * When `limit` exceeds {@link API_MAX_PER_PAGE}, transparently fetches multiple
 * pages using cursor-based pagination (bounded by {@link MAX_PAGINATION_PAGES}).
 *
 * @param orgSlug - Organization slug
 * @param options - Query options (query, sort, limit, cursor, statsPeriod, etc.)
 * @returns Paginated response with conversation items and optional next cursor
 */
export async function listConversations(
  orgSlug: string,
  options: ConversationListOptions & { limit?: number } = {},
): Promise<PaginatedResponse<ConversationListItem[]>> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  return await paginate(options, (perPage, cursor) =>
    fetchConversationsPage(regionUrl, orgSlug, { ...options, cursor }, perPage),
  );
}

export async function getConversationSpans(
  orgSlug: string,
  conversationId: string,
  options: {
    statsPeriod?: string;
    project?: string;
    perPage?: number;
  } = {},
): Promise<{
  spans: AgentConversationSpan[];
  stats?: ConversationStats;
  truncated: boolean;
  title: string | null;
}> {
  const config = getOrgSdkConfig();
  const endpoint = `/organizations/${orgSlug}/agents/conversations/${encodeURIComponent(conversationId)}/`;

  const spans: AgentConversationSpan[] = [];
  let stats: ConversationStats | undefined;
  let title: string | null = null;
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
    const result = await retrieveOrganizationAiConversation({
      ...config,
      path: {
        organization_id_or_slug: orgSlug,
        conversation_id: conversationId,
      },
      query: {
        per_page: options.perPage ?? 1000,
        statsPeriod: options.statsPeriod ?? "30d",
        project: options.project ? [options.project] : undefined,
        cursor,
      },
    });
    const pageResult = unwrapPaginatedResult<unknown>(
      result,
      "Failed to get agent conversation",
    );
    const data: AgentConversationDetails = validateResponse(
      AgentConversationDetailsSchema,
      pageResult.data,
      endpoint,
      pageResult.response?.status ?? 0,
    );

    if (page === 0) {
      stats = data.stats;
      title = data.title;
    }
    spans.push(...data.spans);
    cursor = pageResult.nextCursor;
    if (!cursor) {
      break;
    }
  }

  const truncated = !!cursor;
  if (truncated) {
    log.warn(
      `Pagination limit reached (${MAX_PAGINATION_PAGES} pages, ${spans.length} spans). Conversation transcript may be incomplete.`,
    );
  }

  return { spans, stats, truncated, title };
}
