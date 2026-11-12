/**
 * Sentry search query sanitization for `--query` flags.
 *
 * The rewrite rules live in `@sentry/toolkit-core/search-query`, shared with
 * the MCP server. This wrapper adds the CLI's reporting: one stderr warning
 * per rewritten query, and {@link ValidationError} when a query can't be
 * rewritten. Commands that query the issues endpoint use
 * {@link sanitizeIssueQuery}.
 */

import {
  rewriteSearchQuery,
  type SearchQueryOptions,
  SearchQueryError,
} from "@sentry/toolkit-core/search-query";
import { ValidationError } from "./errors.js";
import { logger } from "./logger.js";

export {
  __testing,
  SEARCH_SYNTAX_REFERENCE,
  unscopedCountFilterKeys,
} from "@sentry/toolkit-core/search-query";

const log = logger.withTag("search-query");

/**
 * Sanitize a `--query` value before sending to the Sentry API.
 *
 * See {@link rewriteSearchQuery} for the rewrite rules. Warns once on stderr
 * when the query changed, quoting the query that will actually run.
 *
 * Accepts `undefined` for convenience — commands can pass `flags.query`
 * directly without a conditional guard.
 *
 * @param query - Raw query string from `--query` flag, or `undefined`
 * @param options - Preserve boolean syntax for endpoints that support it
 * @returns The sanitized query, or `undefined` if input was `undefined`
 * @throws {ValidationError} When OR cannot be rewritten to in-list syntax
 */
export function sanitizeQuery(
  query: string,
  options?: SearchQueryOptions,
): string;
export function sanitizeQuery(
  query: undefined,
  options?: SearchQueryOptions,
): undefined;
export function sanitizeQuery(
  query: string | undefined,
  options?: SearchQueryOptions,
): string | undefined;
export function sanitizeQuery(
  query: string | undefined,
  options: SearchQueryOptions = {},
): string | undefined {
  if (!query) {
    return query;
  }

  let result: ReturnType<typeof rewriteSearchQuery>;
  try {
    result = rewriteSearchQuery(query, options);
  } catch (error) {
    if (error instanceof SearchQueryError) {
      throw new ValidationError(error.message, "query");
    }
    throw error;
  }

  if (result.notes.length > 0) {
    log.warn(`${result.notes.join(" ")}\nRunning query: "${result.query}"`);
  }
  return result.query;
}

/**
 * Sanitize a `--query` value sent to the issues endpoint
 * (`/organizations/{org}/issues/`).
 *
 * Like {@link sanitizeQuery}, plus the issue-search rewrites: `is:A OR is:B`
 * becomes a `status:[…]` or `substatus:[…]` in-list, and parentheses that
 * reduce to plain terms are unwrapped.
 *
 * @param query - Raw query string from `--query` flag
 * @returns The sanitized query
 * @throws {ValidationError} When OR cannot be rewritten to in-list syntax
 */
export function sanitizeIssueQuery(query: string): string {
  return sanitizeQuery(query, { issueSearch: true });
}
