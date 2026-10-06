/**
 * User Feedback API functions.
 *
 * Modern Sentry User Feedback is represented by issue groups. This module
 * owns the mandatory category filter so callers cannot accidentally query
 * ordinary issues or the legacy User Reports endpoints.
 */

import type { SentryFeedback } from "../../types/index.js";
import { buildIssueListCollapse, listIssuesAllPages } from "./issues.js";

/** Status filters exposed by `sentry feedback list`. */
export type FeedbackStatus = "unresolved" | "resolved" | "spam" | "all";

const FEEDBACK_CATEGORY_FILTER = "issue.category:feedback";

const STATUS_FILTERS: Record<Exclude<FeedbackStatus, "all">, string> = {
  unresolved: "status:unresolved",
  resolved: "status:resolved",
  spam: "status:ignored",
};

/** Options for listing modern User Feedback. */
export type ListFeedbackOptions = {
  /** Maximum feedback items to return across auto-paginated API pages. */
  limit: number;
  /** Feedback mailbox to query. */
  status: FeedbackStatus;
  /** Optional user-provided Sentry issue-search expression. */
  query?: string;
  /** Cursor from a previous page. */
  cursor?: string;
  /** Relative time period such as `14d`. */
  statsPeriod?: string;
  /** Inclusive absolute start time. */
  start?: string;
  /** Inclusive absolute end time. */
  end?: string;
  /** Numeric project ID used for direct project selection. */
  projectId?: number;
};

/** A page of feedback items plus the server cursor for the following page. */
export type FeedbackPage = {
  /** Feedback items returned by the issue index. */
  feedback: SentryFeedback[];
  /** Cursor for the next page, when more results are available. */
  nextCursor?: string;
};

/**
 * Build the issue-index query for modern User Feedback.
 *
 * The category clause is always the first term. `spam` maps to Sentry's
 * underlying `ignored` issue status, while `all` omits a generated status
 * clause and keeps only the category plus any user query.
 */
export function buildFeedbackQuery(
  status: FeedbackStatus,
  query?: string
): string {
  const statusFilter = status === "all" ? undefined : STATUS_FILTERS[status];
  const userQuery = query?.trim() || undefined;
  return [FEEDBACK_CATEGORY_FILTER, statusFilter, userQuery]
    .filter(Boolean)
    .join(" ");
}

/**
 * List modern User Feedback from the organization issue index.
 *
 * Reuses the issue API's bounded auto-pagination and fixes sorting to newest
 * activity first. The mandatory category filter is applied here rather than
 * in the command so every caller stays inside the Feedback domain boundary.
 */
export async function listFeedback(
  orgSlug: string,
  projectSlug: string,
  options: ListFeedbackOptions
): Promise<FeedbackPage> {
  const { issues, nextCursor } = await listIssuesAllPages(
    orgSlug,
    projectSlug,
    {
      query: buildFeedbackQuery(options.status, options.query),
      limit: options.limit,
      sort: "date",
      statsPeriod: options.statsPeriod,
      start: options.start,
      end: options.end,
      startCursor: options.cursor,
      projectId: options.projectId,
      collapse: buildIssueListCollapse({ shouldCollapseStats: false }),
    }
  );

  return {
    // The server query is category-constrained; specialize the SDK's generic
    // issue response only after that boundary has been applied.
    feedback: issues as SentryFeedback[],
    nextCursor,
  };
}
