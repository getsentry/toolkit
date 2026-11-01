/**
 * Seed the shell-completion cache from API responses.
 *
 * `sentry __complete` makes no API calls, so it suggests entities that
 * earlier commands fetched (see `src/lib/db/completion-cache.ts`). Every
 * response that passes through the authenticated fetch in
 * `src/lib/sentry-client.ts` is offered to {@link seedCompletions},
 * which matches its path against {@link COMPLETION_SOURCES}: the
 * `@sentry/api` operations that return a completed entity (issues,
 * dashboards, environments, releases, teams, …), by their URL templates.
 * Any command that lists or fetches them therefore seeds the cache, without
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
  GetOrganizationMonitorData,
  GetOrganizationReleaseData,
  GetOrganizationWorkflowData,
  GetProjectMonitorData,
  ListOrganizationDashboardsData,
  ListOrganizationEnvironmentsData,
  ListOrganizationIntegrationsData,
  ListOrganizationIssuesData,
  ListOrganizationMonitorsData,
  ListOrganizationReleasesData,
  ListOrganizationSentryAppComponentsData,
  ListOrganizationSentryAppInstallationsData,
  ListOrganizationTeamsData,
  ListOrganizationWorkflowsData,
  ListProjectEnvironmentsData,
  ListProjectKeysData,
  ListProjectReleasesData,
  ListProjectTeamsData,
  ResolveOrganizationShortIdData,
} from "@sentry/api";
import {
  type CompletionEntity,
  type CompletionEntityKind,
  cacheCompletionEntities,
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

/** An object property of an untyped JSON value. */
function objectField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Entities read from one string property of each item, with another as
 * description when it differs (`name` next to a team's `slug`).
 */
function fieldEntities(
  valueKey: string,
  labelKey?: string,
): (body: unknown) => CompletionEntity[] {
  return (body) =>
    items(body).flatMap((item) => {
      const value = stringField(item, valueKey);
      const label = labelKey ? stringField(item, labelKey) : undefined;
      return value
        ? [{ value, label: label && label !== value ? label : undefined }]
        : [];
    });
}

/** Integrations by ID, the form `--integration` takes, described by name. */
function integrationEntities(body: unknown): CompletionEntity[] {
  return items(body).flatMap((integration) => {
    const value = stringField(integration, "id");
    const provider = stringField(objectField(integration, "provider"), "name");
    const name = stringField(integration, "name");
    return value
      ? [{ value, label: [provider, name].filter(Boolean).join(": ") }]
      : [];
  });
}

/** Installed Sentry Apps by slug, the form `--app` takes. */
function sentryAppEntities(body: unknown): CompletionEntity[] {
  return items(body).flatMap((installation) => {
    const app = objectField(installation, "app");
    const value = stringField(app, "slug");
    const name = stringField(app, "name");
    return value
      ? [{ value, label: name && name !== value ? name : undefined }]
      : [];
  });
}

/** Teams as the `team:<id>` actor that `--owner` takes, described by slug. */
function teamOwnerEntities(body: unknown): CompletionEntity[] {
  return items(body).flatMap((team) => {
    const id = stringField(team, "id");
    const slug = stringField(team, "slug");
    return id ? [{ value: `team:${id}`, label: slug && `#${slug}` }] : [];
  });
}

/** A choice of a form field: `[value, label]`. */
function choiceValue(choice: unknown): string | undefined {
  const value = Array.isArray(choice) ? choice[0] : undefined;
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}

/**
 * The fields of the issue-link forms of installed Sentry Apps, the
 * `name=value` pairs `issue link --field` takes: `name=` for each field,
 * then `name=value` for each fixed choice of a select field. Choices an
 * app loads from its own server (`uri`) are not in the response.
 */
function appLinkFieldEntities(body: unknown): CompletionEntity[] {
  return items(body).flatMap((component) => {
    if (stringField(component, "type") !== "issue-link") {
      return [];
    }
    const app = stringField(objectField(component, "sentryApp"), "slug");
    const link = objectField(objectField(component, "schema"), "link");
    return (["required_fields", "optional_fields"] as const).flatMap(
      (group) => {
        const fields = objectField(link, group);
        if (!Array.isArray(fields)) {
          return [];
        }
        const label = [
          app,
          group === "required_fields" ? "required" : undefined,
        ]
          .filter(Boolean)
          .join(", ");
        return fields.flatMap((field) => {
          const name = stringField(field, "name");
          if (!name) {
            return [];
          }
          const choices =
            objectField(field, "choices") ?? objectField(field, "options");
          const values = Array.isArray(choices)
            ? choices.flatMap((choice) => {
                const value = choiceValue(choice);
                return value === undefined ? [] : [`${name}=${value}`];
              })
            : [];
          return [`${name}=`, ...values].map((value) => ({
            value,
            label: label || undefined,
          }));
        });
      },
    );
  });
}

/** Public DSNs of client keys, described by the key name. */
function dsnEntities(body: unknown): CompletionEntity[] {
  return items(body).flatMap((key) => {
    const value = stringField(objectField(key, "dsn"), "public");
    return value ? [{ value, label: stringField(key, "name") }] : [];
  });
}

/**
 * Operations that return completed entities. Each `satisfies` ties a
 * template to the generated `url` of an `@sentry/api` operation, so an
 * endpoint the SDK renames or drops fails type checking. A template serves
 * every method on it (e.g. `getOrganizationIssue` and
 * `updateOrganizationIssue`, `listOrganizationDashboards` and
 * `createOrganizationDashboard`).
 */
const COMPLETION_SOURCES: readonly CompletionSource[] = [
  {
    kind: "issue",
    url: "/api/0/organizations/{organization_id_or_slug}/issues/" satisfies ListOrganizationIssuesData["url"],
    extract: issueEntities,
  },
  {
    kind: "issue",
    url: "/api/0/organizations/{organization_id_or_slug}/issues/{issue_id}/" satisfies GetOrganizationIssueData["url"],
    extract: issueEntities,
  },
  {
    kind: "issue",
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
    kind: "issue",
    url: "/api/0/issues/{issue_id}/",
    extract: issueEntities,
    org: (body) => {
      const permalink = stringField(body, "permalink");
      return permalink ? parseSentryUrl(permalink)?.org : undefined;
    },
  },
  {
    kind: "dashboard",
    url: "/api/0/organizations/{organization_id_or_slug}/dashboards/" satisfies ListOrganizationDashboardsData["url"],
    extract: dashboardEntities,
  },
  {
    kind: "dashboard",
    url: "/api/0/organizations/{organization_id_or_slug}/dashboards/{dashboard_id}/" satisfies GetOrganizationDashboardData["url"],
    extract: dashboardEntities,
  },
  {
    kind: "environment",
    url: "/api/0/organizations/{organization_id_or_slug}/environments/" satisfies ListOrganizationEnvironmentsData["url"],
    extract: fieldEntities("name"),
  },
  {
    kind: "environment",
    url: "/api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/environments/" satisfies ListProjectEnvironmentsData["url"],
    extract: fieldEntities("name"),
  },
  {
    kind: "release",
    url: "/api/0/organizations/{organization_id_or_slug}/releases/" satisfies ListOrganizationReleasesData["url"],
    extract: fieldEntities("version", "shortVersion"),
  },
  {
    kind: "release",
    url: "/api/0/organizations/{organization_id_or_slug}/releases/{version}/" satisfies GetOrganizationReleaseData["url"],
    extract: fieldEntities("version", "shortVersion"),
  },
  {
    kind: "release",
    url: "/api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/releases/" satisfies ListProjectReleasesData["url"],
    extract: fieldEntities("version", "shortVersion"),
  },
  {
    kind: "team",
    url: "/api/0/organizations/{organization_id_or_slug}/teams/" satisfies ListOrganizationTeamsData["url"],
    extract: fieldEntities("slug", "name"),
  },
  {
    kind: "team",
    url: "/api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/teams/" satisfies ListProjectTeamsData["url"],
    extract: fieldEntities("slug", "name"),
  },
  {
    kind: "owner",
    url: "/api/0/organizations/{organization_id_or_slug}/teams/" satisfies ListOrganizationTeamsData["url"],
    extract: teamOwnerEntities,
  },
  {
    kind: "owner",
    url: "/api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/teams/" satisfies ListProjectTeamsData["url"],
    extract: teamOwnerEntities,
  },
  {
    kind: "monitor",
    url: "/api/0/organizations/{organization_id_or_slug}/monitors/" satisfies ListOrganizationMonitorsData["url"],
    extract: fieldEntities("slug", "name"),
  },
  {
    kind: "monitor",
    url: "/api/0/organizations/{organization_id_or_slug}/monitors/{monitor_id_or_slug}/" satisfies GetOrganizationMonitorData["url"],
    extract: fieldEntities("slug", "name"),
  },
  {
    kind: "monitor",
    url: "/api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/monitors/{monitor_id_or_slug}/" satisfies GetProjectMonitorData["url"],
    extract: fieldEntities("slug", "name"),
  },
  {
    kind: "workflow",
    url: "/api/0/organizations/{organization_id_or_slug}/workflows/" satisfies ListOrganizationWorkflowsData["url"],
    extract: fieldEntities("id", "name"),
  },
  {
    kind: "workflow",
    url: "/api/0/organizations/{organization_id_or_slug}/workflows/{workflow_id}/" satisfies GetOrganizationWorkflowData["url"],
    extract: fieldEntities("id", "name"),
  },
  {
    kind: "integration",
    url: "/api/0/organizations/{organization_id_or_slug}/integrations/" satisfies ListOrganizationIntegrationsData["url"],
    extract: integrationEntities,
  },
  {
    kind: "sentry-app",
    url: "/api/0/organizations/{organization_id_or_slug}/sentry-app-installations/" satisfies ListOrganizationSentryAppInstallationsData["url"],
    extract: sentryAppEntities,
  },
  {
    kind: "app-link-field",
    url: "/api/0/organizations/{organization_id_or_slug}/sentry-app-components/" satisfies ListOrganizationSentryAppComponentsData["url"],
    extract: appLinkFieldEntities,
  },
  {
    kind: "dsn",
    url: "/api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/keys/" satisfies ListProjectKeysData["url"],
    extract: dsnEntities,
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

/** A source matching a request URL, with the organization its path names. */
type SourceMatch = { source: CompletionSource; orgSlug?: string };

/**
 * The sources for a URL and the organization each names, if any. One
 * response can hold several kinds (a team list gives both `--team` slugs
 * and `--owner` actors).
 */
function matchSources(url: string): SourceMatch[] {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch (error) {
    log.debug(`Not seeding completions from unparsable URL '${url}'`, error);
    return [];
  }
  return SOURCE_PATTERNS.flatMap(({ source, pattern }) => {
    const match = pattern.exec(pathname);
    if (!match) {
      return [];
    }
    const org = match[1];
    return [{ source, orgSlug: org ? decodeURIComponent(org) : undefined }];
  });
}

/**
 * Remember the entities in a successful API response for shell completion.
 *
 * Reads a clone of the body, so the caller's response is untouched.
 * Responses from paths without a {@link CompletionSource}, and responses
 * that are not JSON, are ignored without reading their body. Finishes
 * storing before it resolves, so a command that exits right after its
 * request still keeps the entities.
 *
 * @param url - Request URL
 * @param response - Response returned to the caller
 * @returns `response`
 */
export async function seedCompletions(
  url: string,
  response: Response,
): Promise<Response> {
  if (response.ok && response.headers.get("Content-Type")?.includes("json")) {
    const matches = matchSources(url);
    if (matches.length > 0) {
      await seedFromBody(url, response, matches);
    }
  }
  return response;
}

/** Store the entities of a response whose URL matched `matches`. */
async function seedFromBody(
  url: string,
  response: Response,
  matches: readonly SourceMatch[],
): Promise<void> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch (error) {
    log.debug(`Not seeding completions from '${url}'`, error);
    return;
  }
  for (const { source, orgSlug: pathOrg } of matches) {
    const orgSlug = pathOrg ?? source.org?.(body);
    if (!orgSlug) {
      log.debug(
        `Not seeding ${source.kind} completions without an org: '${url}'`,
      );
      continue;
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
}
