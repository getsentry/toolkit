/**
 * Seed the shell-completion cache from API responses.
 *
 * `sentry __complete` makes no API calls, so it suggests entities that
 * earlier commands fetched (see `src/lib/db/completion-cache.ts`). Every
 * response that passes through the authenticated fetch in
 * `src/lib/sentry-client.ts` is offered to {@link seedCompletionsFromResponse},
 * which matches its path against {@link COMPLETION_SOURCES}: the
 * `@sentry/api` operations that return issues or dashboards, by their URL
 * templates. Any command that
 * lists or fetches issues or dashboards therefore seeds the cache, without
 * the API functions having to remember to.
 *
 * To complete a new entity type, add its kind to `db/completion-cache.ts` and
 * the operations that return it here.
 *
 * Failures are swallowed: a cache problem must never fail the command that
 * fetched the data. Cache write errors are reported; a body that cannot be
 * read as JSON is only logged.
 */

import type {
  GetOrganizationDashboardData,
  GetOrganizationIssueData,
  ListOrganizationDashboardsData,
  ListOrganizationIssuesData,
  ResolveOrganizationShortIdData,
} from "@sentry/api";
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

/** An API operation whose response body holds entities to remember. */
type CompletionSource = {
  kind: CompletionEntityKind;
  /**
   * The operation's URL template, as in `@sentry/api` (`{name}` marks a path
   * parameter; `{organization_id_or_slug}` names the organization).
   */
  url: string;
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

/**
 * Operations that return issues or dashboards. Each `satisfies` ties a
 * template to the generated `url` of an `@sentry/api` operation, so an
 * endpoint the SDK renames or drops fails type checking. A template serves
 * every method on it (e.g. `getOrganizationIssue` and
 * `updateOrganizationIssue`, `listOrganizationDashboards` and
 * `createOrganizationDashboard`).
 */
const COMPLETION_SOURCES: readonly CompletionSource[] = [
  {
    kind: ISSUE_ENTITY,
    url: "/api/0/organizations/{organization_id_or_slug}/issues/" satisfies ListOrganizationIssuesData["url"],
    extract: issueEntities,
  },
  {
    kind: ISSUE_ENTITY,
    url: "/api/0/organizations/{organization_id_or_slug}/issues/{issue_id}/" satisfies GetOrganizationIssueData["url"],
    extract: issueEntities,
  },
  {
    kind: ISSUE_ENTITY,
    url: "/api/0/organizations/{organization_id_or_slug}/shortids/{issue_id}/" satisfies ResolveOrganizationShortIdData["url"],
    extract: (body) =>
      issueEntities(
        typeof body === "object" && body !== null
          ? (body as { group?: unknown }).group
          : undefined,
      ),
  },
  {
    // The deprecated unscoped lookup (`getIssue`, `updateIssueStatus`
    // without an org) is not in `@sentry/api`. Its path names no org, so
    // the org comes from the issue's permalink.
    kind: ISSUE_ENTITY,
    url: "/api/0/issues/{issue_id}/",
    extract: issueEntities,
    org: (body) => {
      const permalink = stringField(body, "permalink");
      return permalink ? parseSentryUrl(permalink)?.org : undefined;
    },
  },
  {
    kind: DASHBOARD_ENTITY,
    url: "/api/0/organizations/{organization_id_or_slug}/dashboards/" satisfies ListOrganizationDashboardsData["url"],
    extract: dashboardEntities,
  },
  {
    kind: DASHBOARD_ENTITY,
    url: "/api/0/organizations/{organization_id_or_slug}/dashboards/{dashboard_id}/" satisfies GetOrganizationDashboardData["url"],
    extract: dashboardEntities,
  },
];

/** Path parameter in an `@sentry/api` URL template. */
const TEMPLATE_PARAM_RE = /\{(\w+)\}/g;

/**
 * A regex matching paths that end in `template`. The organization
 * parameter is the first capture group; other parameters match any
 * segment.
 */
function templatePattern(template: string): RegExp {
  const pattern = template.replace(TEMPLATE_PARAM_RE, (_, name) =>
    name === "organization_id_or_slug" ? "([^/]+)" : "[^/]+",
  );
  return new RegExp(`${pattern}$`);
}

const SOURCE_PATTERNS = COMPLETION_SOURCES.map((source) => ({
  source,
  pattern: templatePattern(source.url),
}));

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
  for (const { source, pattern } of SOURCE_PATTERNS) {
    const match = pattern.exec(pathname);
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
