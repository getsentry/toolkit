/**
 * The transport rules of a target-scoped SDK invocation (`limitToTarget`):
 * which requests a scope sends as they are, sends filtered to its project,
 * checks by their response, or refuses.
 */

import { beforeEach, describe, expect, test } from "vitest";
import {
  SCOPE_ORG_ENV_VAR,
  SCOPE_PROJECT_ENV_VAR,
  withEnv,
} from "../../src/lib/env.js";
import { ResolutionError } from "../../src/lib/errors.js";
import {
  __resetScopeLookupsForTests,
  withTargetScope,
} from "../../src/lib/target-scope.js";

const BASE = "https://sentry.io/api/0/";
const WEB = { id: "1", slug: "web" };
const API = { id: "2", slug: "api" };

/** Bodies by path: issue 100 is in `web`, issue 200 in `api`. */
const BODIES: Record<string, unknown> = {
  "projects/acme/web/": WEB,
  "projects/acme/1/": WEB,
  "organizations/acme/issues/100/": { id: "100", project: WEB },
  "organizations/acme/issues/200/": { id: "200", project: API },
  "organizations/acme/shortids/WEB-1/": { projectSlug: "web" },
  "organizations/acme/shortids/API-1/": { projectSlug: "api" },
  "organizations/acme/eventids/a/": { projectSlug: "web" },
  "organizations/acme/eventids/b/": { projectSlug: "api" },
  "organizations/acme/replays/a/": { data: { project_id: "1" } },
  "organizations/acme/replays/b/": { data: { project_id: "2" } },
  "organizations/acme/trace/a/": [
    { project_slug: "edge", children: [{ project_slug: "web" }] },
  ],
  "organizations/acme/trace/b/": [{ project_slug: "api", children: [] }],
  "organizations/acme/trace/empty/": [],
  "organizations/acme/trace/mixed/": [
    { project_slug: "api", children: [{ project_id: 1 }] },
  ],
  "organizations/acme/detectors/7/": { projectId: "1" },
  "organizations/acme/detectors/8/": { projectId: "2" },
  "organizations/acme/releases/1.0/": { projects: [API, WEB] },
  "organizations/acme/releases/2.0/": { projects: [API] },
};

type Sent = { method: string; path: string };

/**
 * Send `method path` in `scope` through the scope, to the fake API.
 * @returns The requests the API got, the scope's lookups first
 */
async function send(
  scope: { org?: string; project?: string },
  method: string,
  path: string,
): Promise<Sent[]> {
  const sent: Sent[] = [];
  const fetchScoped = withTargetScope(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const relative = url.pathname.replace("/api/0/", "") + url.search;
    sent.push({ method: request.method, path: relative });
    const body = BODIES[url.pathname.replace("/api/0/", "")];
    return body === undefined
      ? Response.json({ detail: "Not found" }, { status: 404 })
      : Response.json(body);
  });
  const env: Record<string, string> = {};
  if (scope.org) {
    env[SCOPE_ORG_ENV_VAR] = scope.org;
  }
  if (scope.project) {
    env[SCOPE_PROJECT_ENV_VAR] = scope.project;
  }
  await withEnv(env, () => fetchScoped(`${BASE}${path}`, { method }));
  // Leave out the scope's own lookup of its project's ID.
  return sent.filter(
    (request) => request.path === path || request.path !== "projects/acme/web/",
  );
}

const WEB_SCOPE = { org: "acme", project: "web" };
const ORG_SCOPE = { org: "acme" };

/** The request the API got, after the scope's lookups. */
async function sentAs(
  scope: { org?: string; project?: string },
  method: string,
  path: string,
): Promise<string | undefined> {
  const sent = await send(scope, method, path);
  return sent.at(-1)?.path;
}

describe("a project scope", () => {
  beforeEach(() => __resetScopeLookupsForTests());

  test.each([
    ["GET", "", "the API index"],
    ["GET", "users/me/", "the token's user"],
    ["GET", "organizations/acme/", "the organization"],
    ["GET", "organizations/acme/projects/", "the organization's projects"],
    ["GET", "projects/acme/web/events/a/", "an event of its project"],
    ["PUT", "projects/acme/web/", "a change to its project"],
    ["GET", "projects/acme/1/", "its project by ID"],
    ["GET", "organizations/acme/issues/?project=1", "issues of its project"],
    ["GET", "organizations/acme/issues/100/", "an issue of its project"],
    ["GET", "organizations/acme/shortids/WEB-1/", "a short ID in it"],
    ["GET", "organizations/acme/eventids/a/", "an event ID in it"],
    ["GET", "organizations/acme/replays/a/", "a replay of it"],
    ["GET", "organizations/acme/trace/a/", "a trace through it"],
    ["GET", "organizations/acme/trace/empty/", "an empty trace"],
    ["GET", "organizations/acme/trace/mixed/", "a trace naming it by ID"],
    ["GET", "organizations/acme/detectors/7/", "an alert of it"],
    ["GET", "organizations/acme/releases/1.0/", "a release with it"],
    // Read-only organization metadata.
    ["GET", "organizations/", "the organization list"],
    ["GET", "users/42/", "a user"],
    ["GET", "seer/models/", "Seer's models"],
    ["GET", "organizations/acme/dsn-lookup/?dsn=x", "a DSN lookup"],
    ["GET", "organizations/acme/chunk-upload/", "upload options"],
    ["GET", "organizations/acme/members/5/", "a member"],
    ["GET", "organizations/acme/user-teams/", "the user's teams"],
    ["GET", "organizations/acme/integrations/3/repos/", "integration repos"],
    ["GET", "organizations/acme/config/integrations/", "integration providers"],
    ["GET", "organizations/acme/available-actions/", "alert actions"],
    ["GET", "organizations/acme/sentry-apps/", "custom integrations"],
    ["GET", "organizations/acme/sentry-app-installations/", "app installs"],
    ["GET", "organizations/acme/repos/4/commits/", "a repo's commits"],
    ["GET", "organizations/acme/code-mappings/", "code mappings"],
    ["GET", "organizations/acme/discover/saved/", "saved queries"],
    ["GET", "organizations/acme/discover/saved/6/", "a saved query"],
    ["GET", "organizations/acme/group-search-views/", "issue views"],
    ["GET", "teams/acme/backend/members/", "a team's members"],
    ["GET", "customers/acme/", "the subscription"],
  ])("sends %s %s (%s) as it is", async (method, path) => {
    expect(await sentAs(WEB_SCOPE, method, path)).toBe(path);
  });

  test.each([
    [
      "GET",
      "organizations/acme/issues/",
      "organizations/acme/issues/?project=1",
    ],
    [
      "GET",
      "organizations/acme/events/?query=foo",
      "organizations/acme/events/?query=foo&project=1",
    ],
    [
      "GET",
      "organizations/acme/replays/?project=-1",
      "organizations/acme/replays/?project=1",
    ],
    [
      "PUT",
      "organizations/acme/issues/?id=100",
      "organizations/acme/issues/?id=100&project=1",
    ],
    // Older Sentry versions read only IDs in `project`, and not every
    // endpoint reads `projectSlug`, so the filter is by ID.
    [
      "GET",
      "organizations/acme/issues/?project=web",
      "organizations/acme/issues/?project=1",
    ],
    [
      "GET",
      "organizations/acme/issues/?projectSlug=web",
      "organizations/acme/issues/?projectSlug=web&project=1",
    ],
  ])("filters %s %s to its project", async (method, path, filtered) => {
    expect(await sentAs(WEB_SCOPE, method, path)).toBe(filtered);
  });

  test.each([
    ["PUT", "organizations/acme/issues/100/", "organizations/acme/issues/100/"],
    [
      "GET",
      "organizations/acme/issues/100/events/latest/",
      "organizations/acme/issues/100/",
    ],
    [
      "GET",
      "organizations/acme/trace-meta/a/",
      "organizations/acme/trace/a/?statsPeriod=14d",
    ],
    [
      "GET",
      "organizations/acme/trace-logs/?traceId=a&statsPeriod=90d",
      "organizations/acme/trace/a/?statsPeriod=90d",
    ],
    [
      "DELETE",
      "organizations/acme/detectors/7/",
      "organizations/acme/detectors/7/",
    ],
  ])("looks up what %s %s names first", async (method, path, lookup) => {
    const sent = await send(WEB_SCOPE, method, path);
    expect(sent.map((request) => request.path)).toEqual([lookup, path]);
  });

  test("looks up an issue once", async () => {
    await send(WEB_SCOPE, "GET", "organizations/acme/issues/100/");
    const sent = await send(WEB_SCOPE, "PUT", "organizations/acme/issues/100/");
    expect(sent.map((request) => request.path)).toEqual([
      "organizations/acme/issues/100/",
    ]);
  });

  test.each([
    ["GET", "organizations/other/", "another organization"],
    ["GET", "projects/acme/api/events/b/", "another project's path"],
    ["GET", "projects/acme/2/", "another project by ID"],
    ["GET", "organizations/acme/issues/?project=2", "another project's filter"],
    ["GET", "organizations/acme/issues/?projectSlug=api", "the same by slug"],
    ["GET", "organizations/acme/issues/200/", "another project's issue"],
    ["PUT", "organizations/acme/issues/200/", "a change to it"],
    ["GET", "organizations/acme/issues/200/events/", "its events"],
    ["GET", "organizations/acme/shortids/API-1/", "its short ID"],
    ["GET", "organizations/acme/eventids/b/", "another project's event ID"],
    ["GET", "organizations/acme/replays/b/", "another project's replay"],
    ["GET", "organizations/acme/trace/b/", "a trace not through it"],
    ["GET", "organizations/acme/trace-meta/b/", "that trace's counts"],
    ["GET", "organizations/acme/trace-logs/?traceId=b", "that trace's logs"],
    ["GET", "organizations/acme/trace-meta/empty/", "an empty trace's counts"],
    ["GET", "organizations/acme/trace-logs/", "logs of no trace"],
    ["GET", "organizations/acme/detectors/8/", "another project's alert"],
    ["DELETE", "organizations/acme/detectors/8/", "a change to it"],
    ["GET", "organizations/acme/releases/2.0/", "a release without it"],
    ["GET", "organizations/other/dsn-lookup/", "another org's DSN lookup"],
    // Paths no rule covers.
    ["GET", "issues/200/", "an issue outside an organization path"],
    ["GET", "projects/", "every organization's projects"],
    ["POST", "teams/acme/backend/projects/", "a team write"],
    ["PUT", "customers/acme/", "a subscription write"],
    ["GET", "organizations/acme/project-keys/", "every project's keys"],
    ["GET", "organizations/acme/org-auth-tokens/", "org auth tokens"],
    ["GET", "organizations/acme/scim/v2/Users", "SCIM members"],
    ["GET", "organizations/acme/stats_v2/", "event counts"],
    ["GET", "organizations/acme/sessions/", "session stats"],
    ["GET", "organizations/acme/preprodartifacts/1/size-analysis/", "preprod"],
    ["GET", "organizations/acme/agents/conversations/9/", "a conversation"],
    ["POST", "organizations/acme/dashboards/", "an organization write"],
    ["GET", "organizations/acme/brand-new-endpoint/", "an unknown endpoint"],
    ["GET", "sentry-app-installations/x/external-requests/", "an app install"],
  ])("refuses %s %s (%s)", async (method, path) => {
    await expect(send(WEB_SCOPE, method, path)).rejects.toThrow(
      /outside this session's scope \(acme\/web\)/,
    );
  });

  test.each([
    [
      "GET",
      "organizations/acme/issues/",
      "organizations/acme/issues/?project=1",
    ],
    ["GET", "projects/acme/1/", "projects/acme/1/"],
  ])("by ID sends %s %s as %s", async (method, path, sent) => {
    expect(await sentAs({ org: "acme", project: "1" }, method, path)).toBe(
      sent,
    );
  });

  test("by ID checks a short ID's slug", async () => {
    const sent = await send(
      { org: "acme", project: "1" },
      "GET",
      "organizations/acme/shortids/WEB-1/",
    );
    expect(sent.map((request) => request.path)).toEqual([
      "organizations/acme/shortids/WEB-1/",
      "projects/acme/1/",
    ]);
  });

  test("by ID refuses another project's short ID", async () => {
    await expect(
      send(
        { org: "acme", project: "1" },
        "GET",
        "organizations/acme/shortids/API-1/",
      ),
    ).rejects.toThrow(/outside this session's scope \(acme\/1\)/);
  });

  test("sends its lookups with the request's headers", async () => {
    const lookups: (string | null)[] = [];
    const fetchScoped = withTargetScope(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/projects/acme/web/")) {
        lookups.push(request.headers.get("Authorization"));
      }
      return Response.json(WEB);
    });
    await withEnv(
      { [SCOPE_ORG_ENV_VAR]: "acme", [SCOPE_PROJECT_ENV_VAR]: "web" },
      () =>
        fetchScoped(`${BASE}organizations/acme/issues/`, {
          headers: { Authorization: "Bearer t" },
        }),
    );
    expect(lookups).toEqual(["Bearer t"]);
  });

  test.each([
    ["organizations/acme/issues/200/", "issue list acme/web"],
    ["organizations/acme/eventids/b/", "issue list acme/web"],
    ["organizations/acme/trace/b/", "trace list acme/web"],
    ["organizations/acme/replays/b/", "replay list acme/web"],
  ])("suggests the list command for GET %s", async (path, command) => {
    const refused = await send(WEB_SCOPE, "GET", path).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(ResolutionError);
    expect((refused as ResolutionError).hint).toContain(command);
  });

  test("refuses before it sends", async () => {
    const sent: string[] = [];
    const fetchScoped = withTargetScope(async (input, init) => {
      sent.push(new Request(input, init).url);
      return Response.json({});
    });
    await withEnv(
      { [SCOPE_ORG_ENV_VAR]: "acme", [SCOPE_PROJECT_ENV_VAR]: "web" },
      () =>
        expect(
          fetchScoped(`${BASE}organizations/other/issues/`),
        ).rejects.toThrow(ResolutionError),
    );
    expect(sent).toEqual([]);
  });

  test("refuses a URL outside the API", async () => {
    const fetchScoped = withTargetScope(async () => Response.json({}));
    await withEnv(
      { [SCOPE_ORG_ENV_VAR]: "acme", [SCOPE_PROJECT_ENV_VAR]: "web" },
      () =>
        expect(
          fetchScoped("https://sentry.io/organizations/acme/"),
        ).rejects.toThrow(ResolutionError),
    );
  });
});

describe("an organization scope", () => {
  beforeEach(() => __resetScopeLookupsForTests());

  test.each([
    ["GET", "users/me/"],
    ["GET", "organizations/"],
    ["GET", "organizations/acme/brand-new-endpoint/"],
    ["POST", "organizations/acme/dashboards/"],
    ["GET", "projects/acme/api/events/b/"],
    ["GET", "organizations/acme/issues/200/"],
    ["POST", "teams/acme/backend/projects/"],
  ])("sends %s %s as it is", async (method, path) => {
    expect(await sentAs(ORG_SCOPE, method, path)).toBe(path);
  });

  test.each([
    ["GET", "organizations/other/issues/"],
    ["GET", "projects/other/web/"],
    ["GET", "projects/"],
    ["GET", "issues/200/"],
  ])("refuses %s %s", async (method, path) => {
    await expect(send(ORG_SCOPE, method, path)).rejects.toThrow(
      /outside this session's scope \(acme\)/,
    );
  });
  test("suggests issue list for another organization's trace", async () => {
    const refused = await send(
      ORG_SCOPE,
      "GET",
      "organizations/other/trace/b/",
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ResolutionError);
    expect((refused as ResolutionError).hint).toContain("issue list acme/");
  });
});

describe("no scope", () => {
  test("sends any request as it is", async () => {
    expect(await sentAs({}, "GET", "organizations/other/issues/")).toBe(
      "organizations/other/issues/",
    );
  });
});
