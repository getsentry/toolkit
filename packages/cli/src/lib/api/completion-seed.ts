/**
 * Seed the shell-completion cache from API responses.
 *
 * `sentry __complete` makes no API calls, so it suggests entities that
 * earlier commands fetched (see `src/lib/db/completion-cache.ts`). Every
 * response that passes through the authenticated fetch in
 * `src/lib/sentry-client.ts` is offered to {@link seedCompletionsFromResponse},
 * which matches its path against {@link COMPLETION_SOURCES}. Any command that
 * lists or fetches issues or dashboards therefore seeds the cache, without
 * the API functions having to remember to.
 *
 * To complete a new entity type, add its kind to `db/completion-cache.ts` and
 * the endpoints that return it here.
 *
 * Failures are swallowed: a cache problem must never fail the command that
 * fetched the data. Cache write errors are reported; a body that cannot be
 * read as JSON is only logged.
 */

import {
  type CompletionEntity,
  type CompletionEntityKind,
  cacheCompletionEntities,
  DASHBOARD_ENTITY,
  ISSUE_ENTITY,
} from "../db/completion-cache.js";
import { reportCliError } from "../error-reporting.js";
import { logger } from "../logger.js";
import { parseSentryUrl } from "../sentry-url-parser.js";
import { isAllDigits } from "../utils.js";

const log = logger.withTag("completion-seed");

/** An endpoint whose response body holds entities to remember. */
type CompletionSource = {
  kind: CompletionEntityKind;
  /**
   * Matches the URL path. The first group, when the path has one, is the
   * organization slug.
   */
  path: RegExp;
  /** Entities in the parsed JSON body, in display order. */
  extract: (body: unknown) => CompletionEntity[];
  /** Organization of a body whose path names none (unscoped endpoints). */
  org?: (body: unknown) => string | undefined;
};

/** Read a string property of an untyped JSON value. */
function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

/** The items of a list response, or the single object of a detail response. */
function items(body: unknown): unknown[] {
  return Array.isArray(body) ? body : [body];
}

/** Issues by short ID, with the title as description. */
function issueEntities(body: unknown): CompletionEntity[] {
  return items(body).flatMap((issue) => {
    const value = stringField(issue, "shortId");
    return value ? [{ value, label: stringField(issue, "title") }] : [];
  });
}

/**
 * Dashboards by ID, with the title as description. Only numeric IDs are
 * kept: dashboard commands read `<org>/<id>` as an ID only when it is
 * numeric, so other IDs could not be completed in that form.
 */
function dashboardEntities(body: unknown): CompletionEntity[] {
  return items(body).flatMap((dashboard) => {
    const value = stringField(dashboard, "id");
    return value && isAllDigits(value)
      ? [{ value, label: stringField(dashboard, "title") }]
      : [];
  });
}

/** Endpoints that return issues or dashboards. */
const COMPLETION_SOURCES: readonly CompletionSource[] = [
  {
    kind: ISSUE_ENTITY,
    path: /\/api\/0\/organizations\/([^/]+)\/issues\/(?:[^/]+\/)?$/,
    extract: issueEntities,
  },
  {
    kind: ISSUE_ENTITY,
    path: /\/api\/0\/organizations\/([^/]+)\/shortids\/[^/]+\/$/,
    extract: (body) =>
      issueEntities(
        typeof body === "object" && body !== null
          ? (body as { group?: unknown }).group
          : undefined,
      ),
  },
  {
    // Unscoped numeric-ID lookup (`getIssue`, `updateIssueStatus` without an
    // org); the org comes from the issue's permalink.
    kind: ISSUE_ENTITY,
    path: /\/api\/0\/issues\/\d+\/$/,
    extract: issueEntities,
    org: (body) => {
      const permalink = stringField(body, "permalink");
      return permalink ? parseSentryUrl(permalink)?.org : undefined;
    },
  },
  {
    kind: DASHBOARD_ENTITY,
    path: /\/api\/0\/organizations\/([^/]+)\/dashboards\/(?:\d+\/)?$/,
    extract: dashboardEntities,
  },
];

/** The source for a URL and the organization it names, if any. */
function matchSource(
  url: string,
): { source: CompletionSource; orgSlug?: string } | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch (error) {
    log.debug(`Not seeding completions from unparsable URL '${url}'`, error);
    return;
  }
  for (const source of COMPLETION_SOURCES) {
    const match = source.path.exec(pathname);
    if (match) {
      const org = match[1];
      return { source, orgSlug: org ? decodeURIComponent(org) : undefined };
    }
  }
  return;
}

/**
 * Remember the entities in a successful API response for shell completion.
 *
 * Reads a clone of the body, so the caller's response is untouched.
 * Responses from paths without a {@link CompletionSource}, and responses
 * that are not JSON, are ignored without reading their body.
 *
 * @param url - Request URL
 * @param response - Response returned to the caller
 */
export async function seedCompletionsFromResponse(
  url: string,
  response: Response,
): Promise<void> {
  if (
    !(response.ok && response.headers.get("Content-Type")?.includes("json"))
  ) {
    return;
  }
  const match = matchSource(url);
  if (!match) {
    return;
  }
  const { source } = match;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch (error) {
    log.debug(`Not seeding ${source.kind} completions from '${url}'`, error);
    return;
  }
  const orgSlug = match.orgSlug ?? source.org?.(body);
  if (!orgSlug) {
    log.debug(
      `Not seeding ${source.kind} completions without an org: '${url}'`,
    );
    return;
  }
  try {
    cacheCompletionEntities(source.kind, orgSlug, source.extract(body));
  } catch (error) {
    log.debug(
      `Failed to cache ${source.kind} completions for '${orgSlug}'`,
      error,
    );
    reportCliError(error);
  }
}
