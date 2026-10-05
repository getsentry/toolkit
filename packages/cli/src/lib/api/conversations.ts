/**
 * Agent conversations API functions
 *
 * Functions for listing and retrieving agent conversation data from the Sentry
 * Explore agent conversations endpoints.
 *
 * The `/organizations/{org}/agents/conversations/` endpoints are PRIVATE and not
 * yet in `@sentry/api` (getsentry/sentry-api-schema). Call them via
 * `apiRequestToRegion` with local Valibot schemas (same pattern as `logs.ts` /
 * `traces.ts`). Details response shape is documented on
 * `AgentConversationDetailsSchema`. Pagination uses `parseLinkHeader`. Revisit
 * once these endpoints land in `@sentry/api`.
 */

import { array } from "valibot";

import {
  type AgentConversationDetails,
  AgentConversationDetailsSchema,
  type AgentConversationSpan,
  type ConversationListItem,
  ConversationListItemSchema,
} from "../../types/conversation.js";

import { logger } from "../logger.js";
import { resolveOrgRegion } from "../region.js";

import {
  API_MAX_PER_PAGE,
  apiRequestToRegion,
  MAX_PAGINATION_PAGES,
  type PaginatedResponse,
  paginate,
  parseLinkHeader,
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
    cursor?: string;
    statsPeriod?: string;
    start?: string;
    end?: string;
    project?: string;
  },
  perPage: number
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
  if (options.project) {
    params.project = options.project;
  }

  const { data, headers } = await apiRequestToRegion<ConversationListItem[]>(
    regionUrl,
    `/organizations/${orgSlug}/agents/conversations/`,
    { params, schema: array(ConversationListItemSchema) }
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
 * @param options - Query options (query, limit, cursor, statsPeriod, etc.)
 * @returns Paginated response with conversation items and optional next cursor
 */
export async function listConversations(
  orgSlug: string,
  options: {
    query?: string;
    limit?: number;
    cursor?: string;
    statsPeriod?: string;
    start?: string;
    end?: string;
    project?: string;
  } = {}
): Promise<PaginatedResponse<ConversationListItem[]>> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  return paginate(options, (perPage, cursor) =>
    fetchConversationsPage(regionUrl, orgSlug, { ...options, cursor }, perPage)
  );
}

export async function getConversationSpans(
  orgSlug: string,
  conversationId: string,
  options: {
    statsPeriod?: string;
    project?: string;
    perPage?: number;
  } = {}
): Promise<{
  spans: AgentConversationSpan[];
  truncated: boolean;
  title: string | null;
}> {
  const regionUrl = await resolveOrgRegion(orgSlug);

  const params: Record<string, string> = {
    per_page: String(options.perPage ?? 1000),
    statsPeriod: options.statsPeriod ?? "30d",
  };
  if (options.project) {
    params.project = options.project;
  }

  const spans: AgentConversationSpan[] = [];
  let title: string | null = null;
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
    if (cursor) {
      params.cursor = cursor;
    }

    const { data, headers } =
      await apiRequestToRegion<AgentConversationDetails>(
        regionUrl,
        `/organizations/${orgSlug}/agents/conversations/${encodeURIComponent(conversationId)}/`,
        { params, schema: AgentConversationDetailsSchema }
      );

    if (page === 0) {
      title = data.title;
    }
    spans.push(...data.spans);
    const parsed = parseLinkHeader(headers.get("link") ?? null);
    cursor = parsed.nextCursor;
    if (!cursor) {
      break;
    }
  }

  const truncated = !!cursor;
  if (truncated) {
    log.warn(
      `Pagination limit reached (${MAX_PAGINATION_PAGES} pages, ${spans.length} spans). Conversation transcript may be incomplete.`
    );
  }

  return { spans, truncated, title };
}
