/**
 * Agent conversations API functions
 *
 * Functions for listing and retrieving agent conversation data from the Sentry
 * Explore agent conversations endpoints.
 *
 * Both endpoints are in `@sentry/api`. The list still goes through
 * `apiRequestToRegion` because its generated query has no `sort`. The details
 * call uses the generated operation; its spans are untyped records there, so
 * the response is still checked with `AgentConversationDetailsSchema`.
 * Pagination follows the `Link` header.
 */

import { retrieveOrganizationAiConversation } from "@sentry/api";
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

import {
  API_MAX_PER_PAGE,
  apiRequestToRegion,
  getOrgSdkConfig,
  MAX_PAGINATION_PAGES,
  type PaginatedResponse,
  paginate,
  parseLinkHeader,
  unwrapPaginatedResult,
  validateResponse,
} from "./infrastructure.js";

const log = logger.withTag("api.conversations");

/**
 * Fetch a single page of conversations from the agent conversations endpoint.
 *
 * Internal helper used by {@link listConversations} for both single-page and
 * multi-page (auto-paginating) fetches.
 */
async function fetchConversationsPage(
  regionUrl: string,
  orgSlug: string,
  options: {
    query?: string;
    sort?: string;
    cursor?: string;
    statsPeriod?: string;
    start?: string;
    end?: string;
    project?: string;
  },
  perPage: number,
): Promise<PaginatedResponse<ConversationListItem[]>> {
  const params: Record<string, string> = {
    per_page: String(perPage),
  };
  if (options.statsPeriod) {
    params.statsPeriod = options.statsPeriod;
  }
  if (options.start) {
    params.start = options.start;
  }
  if (options.end) {
    params.end = options.end;
  }
  if (options.cursor) {
    params.cursor = options.cursor;
  }
  if (options.query) {
    params.query = options.query;
  }
  if (options.sort) {
    params.sort = options.sort;
  }
  if (options.project) {
    params.project = options.project;
  }

  const { data, headers } = await apiRequestToRegion<ConversationListItem[]>(
    regionUrl,
    `/organizations/${orgSlug}/agents/conversations/`,
    { params, schema: array(ConversationListItemSchema) },
  );

  const { nextCursor } = parseLinkHeader(headers.get("link") ?? null);

  return { data, nextCursor };
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
  options: {
    query?: string;
    sort?: string;
    limit?: number;
    cursor?: string;
    statsPeriod?: string;
    start?: string;
    end?: string;
    project?: string;
  } = {},
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
