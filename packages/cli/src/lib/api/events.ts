/**
 * Event API functions
 *
 * Functions for retrieving, listing, and resolving Sentry events.
 */

import {
  type EventAttachmentDetailsResponse,
  getOrganizationIssueEvent,
  getProjectEvent,
  listOrganizationIssueEvents,
  listProjectEventAttachments,
  resolveOrganizationEventId as sdkResolveAnEventId,
} from "@sentry/api";
import pLimit from "p-limit";

import type { IssueEvent, SentryEvent } from "../../types/index.js";

import { ApiError, AuthError } from "../errors.js";

import {
  API_MAX_PER_PAGE,
  autoPaginate,
  getOrgSdkConfig,
  MAX_PAGINATION_PAGES,
  ORG_FANOUT_CONCURRENCY,
  type PaginatedResponse,
  unwrapPaginatedResult,
  unwrapResult,
} from "./infrastructure.js";
import { listOrganizations } from "./organizations.js";

/**
 * Get the latest event for an issue.
 * Uses region-aware routing for multi-region support.
 *
 * @param orgSlug - Organization slug (required for multi-region routing)
 * @param issueId - Issue ID (numeric)
 */
export async function getLatestEvent(
  orgSlug: string,
  issueId: string
): Promise<SentryEvent> {
  const config = await getOrgSdkConfig(orgSlug);

  const result = await getOrganizationIssueEvent({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      issue_id: issueId,
      event_id: "latest",
    },
  });

  return unwrapResult<SentryEvent>(result, "Failed to get latest event");
}

/**
 * Get a specific event by ID.
 * Uses region-aware routing for multi-region support.
 */
export async function getEvent(
  orgSlug: string,
  projectSlug: string,
  eventId: string
): Promise<SentryEvent> {
  const config = await getOrgSdkConfig(orgSlug);

  const result = await getProjectEvent({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      project_id_or_slug: projectSlug,
      event_id: eventId,
    },
  });

  return unwrapResult<SentryEvent>(result, "Failed to get event");
}

/**
 * List metadata for attachments on a project event.
 * Uses the generated Sentry API client and region-aware organization routing.
 * The extra result sentinel lets the shared page bound emit its incomplete-data
 * warning instead of stopping silently at the exact theoretical capacity.
 */
export async function listEventAttachments(
  orgSlug: string,
  projectSlug: string,
  eventId: string
): Promise<EventAttachmentDetailsResponse[]> {
  const config = await getOrgSdkConfig(orgSlug);
  const { data } = await autoPaginate(
    async (cursor) => {
      // The endpoint accepts `per_page`, but its generated SDK type omits it.
      // Keeping the query in a variable permits the server-supported parameter
      // without weakening the generated client type.
      const query = {
        per_page: API_MAX_PER_PAGE,
        ...(cursor ? { cursor } : {}),
      };
      const result = await listProjectEventAttachments({
        ...config,
        path: {
          organization_id_or_slug: orgSlug,
          project_id_or_slug: projectSlug,
          event_id: eventId,
        },
        query,
      });
      return unwrapPaginatedResult<EventAttachmentDetailsResponse[]>(
        result,
        "Failed to list event attachments"
      );
    },
    API_MAX_PER_PAGE * MAX_PAGINATION_PAGES + 1
  );
  return data;
}

/**
 * Result of resolving an event ID to an org and project.
 * Includes the full event so the caller can avoid a second API call.
 */
export type ResolvedEvent = {
  org: string;
  project: string;
  event: SentryEvent;
};

/**
 * Resolve an event ID to its org and project using the
 * `/organizations/{org}/eventids/{event_id}/` endpoint.
 *
 * Returns the resolved org, project, and full event on success,
 * or null if the event is not found in the given org.
 */
export async function resolveEventInOrg(
  orgSlug: string,
  eventId: string
): Promise<ResolvedEvent | null> {
  const config = await getOrgSdkConfig(orgSlug);

  const result = await sdkResolveAnEventId({
    ...config,
    path: { organization_id_or_slug: orgSlug, event_id: eventId },
  });

  try {
    const data = unwrapResult<{
      organizationSlug: string;
      projectSlug: string;
      event: unknown;
    }>(result, "Failed to resolve event ID");
    return {
      org: data.organizationSlug,
      project: data.projectSlug,
      event: data.event as SentryEvent,
    };
  } catch (error) {
    // 404 means the event doesn't exist in this org — not an error
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/** Options for {@link findEventAcrossOrgs}. */
export type FindEventAcrossOrgsOptions = {
  /** Org slugs to skip (already searched by the caller). */
  excludeOrgs?: string[];
};

/**
 * Search for an event across all accessible organizations by event ID.
 *
 * Fans out to every org in parallel using the eventids resolution endpoint.
 * Returns the first match found, or null if the event is not accessible.
 *
 * @param eventId - The event ID (UUID) to look up
 * @param options - Optional settings (e.g., orgs to skip)
 */
export async function findEventAcrossOrgs(
  eventId: string,
  options?: FindEventAcrossOrgsOptions
): Promise<ResolvedEvent | null> {
  const excludeSet = options?.excludeOrgs
    ? new Set(options.excludeOrgs)
    : undefined;
  const allOrgs = await listOrganizations();
  const orgs = excludeSet
    ? allOrgs.filter((o) => !excludeSet.has(o.slug))
    : allOrgs;

  const limit = pLimit(ORG_FANOUT_CONCURRENCY);
  const results = await Promise.allSettled(
    orgs.map((org) => limit(() => resolveEventInOrg(org.slug, eventId)))
  );

  // First pass: return the first successful match
  for (const result of results) {
    if (result.status === "fulfilled" && result.value !== null) {
      return result.value;
    }
  }

  // Second pass (only reached when no org had the event): propagate
  // AuthError since it indicates a global problem (expired/missing token).
  // Transient per-org failures (network, 5xx) are swallowed — they are not
  // global, and if the event existed in any accessible org it would have matched.
  for (const result of results) {
    if (result.status === "rejected" && result.reason instanceof AuthError) {
      throw result.reason;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Issue event listing
// ---------------------------------------------------------------------------

/** Options for {@link listIssueEvents}. */
export type ListIssueEventsOptions = {
  /** Max items to return (total across all auto-paginated pages). @default 25 */
  limit?: number;
  /** Search query (Sentry search syntax). */
  query?: string;
  /** Include full event body (stacktraces, breadcrumbs). */
  full?: boolean;
  /** Pagination cursor from a previous response. */
  cursor?: string;
  /** Relative time period (e.g., "7d", "24h"). Overrides start/end on the API. */
  statsPeriod?: string;
  /** Absolute start datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  start?: string;
  /** Absolute end datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  end?: string;
};

/**
 * List events for a specific issue.
 *
 * Uses the SDK's `listOrganizationIssueEvents` endpoint with region-aware routing.
 * When `limit` exceeds {@link API_MAX_PER_PAGE} (100), auto-paginates through
 * multiple API calls to fill the requested limit, bounded by
 * {@link MAX_PAGINATION_PAGES}.
 *
 * Page size is capped at `min(limit, API_MAX_PER_PAGE)` via `per_page`, which
 * Sentry accepts on this route at runtime even though it is absent from the
 * OpenAPI spec. Capping page size keeps the server-issued `nextCursor` aligned
 * to a page boundary, preventing the skip bug where trim + keep-cursor would
 * jump past items.
 *
 * When trimming to `limit`, `nextCursor` is PRESERVED: the events cursor is
 * offset-based, so resuming from it re-includes any trimmed tail rather than
 * skipping it. This prevents both the original skip bug and the stall
 * (drop-cursor) regression.
 *
 * @param orgSlug - Organization slug for region routing
 * @param issueId - Numeric issue ID
 * @param options - Query and pagination options
 * @returns Paginated response with events array and optional next cursor
 */
export async function listIssueEvents(
  orgSlug: string,
  issueId: string,
  options: ListIssueEventsOptions = {}
): Promise<PaginatedResponse<IssueEvent[]>> {
  const { limit = 25, query, full, cursor, statsPeriod, start, end } = options;

  const config = await getOrgSdkConfig(orgSlug);
  const perPage = Math.min(limit, API_MAX_PER_PAGE);

  const allEvents: IssueEvent[] = [];
  let currentCursor = cursor;
  let nextCursor: string | undefined;

  for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
    const result = await listOrganizationIssueEvents({
      ...config,
      path: {
        organization_id_or_slug: orgSlug,
        issue_id: issueId,
      },
      query: {
        query: query || undefined,
        full,
        cursor: currentCursor,
        statsPeriod,
        start,
        end,
        // `per_page` is accepted at runtime but absent from the generated query
        // type, so widen via cast.
        per_page: perPage,
      } as Parameters<typeof listOrganizationIssueEvents>[0]["query"],
    });

    const paginated = unwrapPaginatedResult(
      result,
      "Failed to list issue events"
    );

    allEvents.push(...(paginated.data as IssueEvent[]));
    nextCursor = paginated.nextCursor;

    if (allEvents.length >= limit || !nextCursor) {
      break;
    }
    currentCursor = nextCursor;
  }

  // Trim to limit but PRESERVE nextCursor. The events cursor is offset-based,
  // so resuming from it re-includes any trimmed tail rather than skipping it.
  // Preserving the cursor lets `-c next` advance; dropping it would strand all
  // events past the first page.
  const data = allEvents.length > limit ? allEvents.slice(0, limit) : allEvents;
  return { data, nextCursor };
}
