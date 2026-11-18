import {
  type FetchAllPagesFailure,
  fetchAllPages,
  MAX_LIST_PAGES,
} from "@sentry/api/client";

/** Error message for each way {@link fetchAllPages} can fail. */
const FETCH_ALL_PAGES_ERRORS: Record<
  FetchAllPagesFailure,
  (context: string) => string
> = {
  "invalid-page": (context) => `Unexpected response format when ${context}`,
  "repeated-cursor": (context) =>
    `Pagination repeated a cursor when ${context}`,
  "page-cap": (context) =>
    `Pagination exceeded ${MAX_LIST_PAGES} pages when ${context}`,
};

/**
 * Fetches every page of a list endpoint, or throws.
 *
 * A partial result is an error: use this when a missing page could hide the
 * record a lookup or mutation depends on. Throws on a repeated cursor or more
 * than {@link MAX_LIST_PAGES} pages.
 *
 * @param fetchPage - Fetches and validates one page given a cursor
 * @param context - Operation for error messages, e.g. "listing dashboards"
 * @returns Every row, in page order
 */
export async function fetchEveryPage<T>(
  fetchPage: (
    cursor: string | undefined,
  ) => Promise<{ data: T[]; nextCursor?: string | null }>,
  context: string,
): Promise<T[]> {
  const result = await fetchAllPages<T>(
    async (cursor) => {
      const page = await fetchPage(cursor);
      return { data: page.data, nextCursor: page.nextCursor ?? undefined };
    },
    // `fetchPage` already validated its rows.
    (data) => data as T[],
    MAX_LIST_PAGES,
  );
  if (!result.ok) {
    throw new Error(FETCH_ALL_PAGES_ERRORS[result.reason](context));
  }
  return result.items;
}
