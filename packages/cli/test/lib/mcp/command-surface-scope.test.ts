/**
 * A project-scoped `sentry mcp --commands` session (`acme/web`) refuses an
 * issue, event, trace or replay in another project, whatever identifies it:
 * the command surface checks the targets a call names, and the CLI checks
 * what an ID alone names (a numeric ID, an event, trace or replay ID, a URL,
 * a selector, search text) once it finds it. Calls run through the CLI SDK
 * against a mocked Sentry API.
 */

import type { ServerContext } from "@sentry/mcp-core/types";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createCliCommandTools } from "../../../src/lib/mcp/command-surface.js";
import type { McpServerConfig } from "../../../src/lib/mcp/config.js";
import { __resetScopeLookupsForTests } from "../../../src/lib/target-scope.js";
import eventFixture from "../../fixtures/event.json";
import issueFixture from "../../fixtures/issue.json";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

const WEB = { id: "1", slug: "web", name: "Web", platform: "javascript" };
const API = { id: "2", slug: "api", name: "API", platform: "python" };

/** Issues by numeric ID: 100 (`WEB-1`) is in the session, 200 (`API-1`) is not. */
const ISSUES = {
  "100": { ...issueFixture, id: "100", shortId: "WEB-1", project: WEB },
  "200": { ...issueFixture, id: "200", shortId: "API-1", project: API },
};

/** Events, traces and replays by ID: `web` ones are in the session, `api` ones are not. */
const WEB_ID = "a".repeat(32);
const API_ID = "b".repeat(32);
const IN_PROJECT = { [WEB_ID]: WEB, [API_ID]: API };

function event(id: string) {
  return { ...eventFixture, eventID: id, projectID: IN_PROJECT[id]?.id };
}

/** A trace that starts in a third project and calls into the ID's project. */
function trace(id: string) {
  return [
    {
      span_id: "root",
      op: "http.server",
      description: "GET /",
      start_timestamp: 1_706_621_535,
      end_timestamp: 1_706_621_536,
      project_slug: "edge",
      event_id: "c".repeat(32),
      children: [
        {
          span_id: "child",
          op: "db.query",
          description: "SELECT 1",
          start_timestamp: 1_706_621_535.1,
          end_timestamp: 1_706_621_535.2,
          project_slug: IN_PROJECT[id]?.slug,
          event_id: "d".repeat(32),
          children: [],
        },
      ],
    },
  ];
}

function replay(id: string) {
  return {
    id,
    project_id: Number(IN_PROJECT[id]?.id),
    count_errors: 0,
    count_segments: 0,
    duration: 10,
    started_at: "2025-01-30T14:32:15+00:00",
    finished_at: "2025-01-30T14:32:25+00:00",
    error_ids: [],
    trace_ids: [],
  };
}

const config = {
  sentryHost: "sentry.io",
  sentryProtocol: "https",
  readOnly: false,
} as McpServerConfig;

const context: ServerContext = {
  accessToken: "unused",
  constraints: { organizationSlug: "acme", projectSlug: "web" },
};

type RecordedRequest = { method: string; url: URL };

function json(body: unknown): Response {
  return Response.json(body, { status: 200 });
}

/** The issue index: org-wide, or only the projects the `project` param selects. */
function listIssues(url: URL): Response {
  const projects = url.searchParams.getAll("project");
  return json(
    Object.values(ISSUES)
      .filter(
        ({ project }) => !projects.length || projects.includes(project.id),
      )
      // The other project's issue is the newest in the organization.
      .reverse(),
  );
}

function sentryApi(requests: RecordedRequest[]): typeof fetch {
  return mockFetch(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({ method: request.method, url });
    const path = url.pathname.replace(/^\/api\/0\//, "");
    if (path === "organizations/acme/") {
      return json({ id: "9", slug: "acme", name: "Acme" });
    }
    if (path === "projects/acme/web/") {
      return json(WEB);
    }
    if (path === "organizations/") {
      return json([{ id: "9", slug: "acme", name: "Acme" }]);
    }
    if (path === "organizations/acme/issues/") {
      return listIssues(url);
    }
    if (path === "organizations/acme/replays/") {
      return json({ data: [] });
    }
    const opaque =
      /^(?:projects\/acme\/web\/events|organizations\/acme\/(eventids|trace|replays))\/([0-9a-f]{32})\/$/.exec(
        path,
      );
    const opaqueId = opaque?.[2];
    if (opaqueId && IN_PROJECT[opaqueId]) {
      switch (opaque[1]) {
        case "eventids":
          return json({
            organizationSlug: "acme",
            projectSlug: IN_PROJECT[opaqueId].slug,
            groupId: "1",
            eventId: opaqueId,
            event: event(opaqueId),
          });
        case "trace":
          return json(trace(opaqueId));
        case "replays":
          return json({ data: replay(opaqueId) });
        default:
          if (IN_PROJECT[opaqueId] === WEB) {
            return json(event(opaqueId));
          }
      }
    }
    if (
      /^projects\/acme\/web\/events\/[0-9a-f]{32}\/attachments\/$/.test(path)
    ) {
      return json([]);
    }
    const shortId = /^organizations\/acme\/shortids\/([^/]+)\/$/.exec(path);
    const byShortId = Object.values(ISSUES).find(
      (issue) => issue.shortId === shortId?.[1],
    );
    if (byShortId) {
      return json({ group: byShortId });
    }
    const id = /^organizations\/acme\/issues\/(\d+)\/$/.exec(path)?.[1];
    const issue = id ? ISSUES[id as keyof typeof ISSUES] : undefined;
    if (issue && request.method === "GET") {
      return json(issue);
    }
    if (issue && request.method === "PUT") {
      return json({ ...issue, status: "resolved" });
    }
    return Response.json({ detail: "Not found" }, { status: 404 });
  });
}

/** Call the command tool `name` in the `acme/web` session. */
async function call(
  name: string,
  positional: string[],
  flags: Record<string, unknown> = {},
): Promise<unknown> {
  const tool = createCliCommandTools({
    config,
    cwd: process.cwd(),
    getToken: async () => `sntryu_${"a".repeat(64)}`,
  })[name];
  if (!tool) {
    throw new Error(`no tool ${name}`);
  }
  return JSON.parse(
    (await tool.handler({ positional, flags }, context)) as string,
  );
}

const OUTSIDE = /Issue 200 is outside this session's scope \(acme\/web\)/;

describe("a project-scoped command session", () => {
  useTestConfigDir("mcp-command-scope-");
  let requests: RecordedRequest[];
  let originalFetch: typeof fetch;

  beforeEach(() => {
    __resetScopeLookupsForTests();
    requests = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = sentryApi(requests);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const writes = () => requests.filter(({ method }) => method !== "GET");

  test("reads an issue of its project by numeric ID", async () => {
    expect(await call("sentry_issue_view", ["100"])).toMatchObject({
      result: { shortId: "WEB-1" },
    });
  });

  test.each([
    ["a numeric ID", "200"],
    ["an org-qualified numeric ID", "acme/200"],
    ["an issue URL", "https://acme.sentry.io/issues/200/"],
  ])("refuses another project's issue by %s", async (_form, issue) => {
    await expect(call("sentry_issue_view", [issue])).rejects.toThrow(OUTSIDE);
  });

  test("changes no issue of another project", async () => {
    await expect(call("sentry_issue_resolve", ["200"])).rejects.toThrow(
      OUTSIDE,
    );
    expect(writes()).toEqual([]);
  });

  test("resolves an issue of its project by numeric ID", async () => {
    await call("sentry_issue_resolve", ["100"]);
    expect(writes().map(({ url }) => url.pathname)).toEqual([
      "/api/0/organizations/acme/issues/100/",
    ]);
  });

  test("picks @latest from its own project", async () => {
    expect(await call("sentry_issue_view", ["@latest"])).toMatchObject({
      result: { shortId: "WEB-1" },
    });
  });

  test("picks the latest Feedback from its own project", async () => {
    expect(await call("sentry_feedback_view", ["@latest"])).toMatchObject({
      result: { shortId: "WEB-1" },
    });
  });

  test("searches only its own project", async () => {
    await call("sentry_issue_resolve", ["Cannot read property"]);
    expect(writes().map(({ url }) => url.pathname)).toEqual([
      "/api/0/organizations/acme/issues/100/",
    ]);
  });

  test("reads no events of another project's issue", async () => {
    await expect(
      call("sentry_event_view", ["https://acme.sentry.io/issues/200/"]),
    ).rejects.toThrow(OUTSIDE);
    expect(
      requests.filter(({ url }) => url.pathname.includes("/events/")),
    ).toEqual([]);
  });

  test.each([
    ["sentry_event_view", { eventID: WEB_ID }],
    ["sentry_trace_view", { traceId: WEB_ID }],
    ["sentry_replay_view", { id: WEB_ID }],
  ])("reads its project's ID in %s", async (tool, result) => {
    expect(await call(tool, [WEB_ID])).toMatchObject({ result });
  });

  test.each([
    ["sentry_event_view", [API_ID]],
    ["sentry_event_view", ["acme/", API_ID]],
    ["sentry_trace_view", [API_ID]],
    ["sentry_trace_view", [`acme/${API_ID}`]],
    ["sentry_replay_view", [API_ID]],
    ["sentry_replay_view", [`acme/${API_ID}`]],
    [
      "sentry_replay_view",
      [`https://acme.sentry.io/explore/replays/${API_ID}/`],
    ],
  ])("refuses another project's ID in %s %j", async (tool, positional) => {
    await expect(call(tool, positional)).rejects.toThrow(
      /outside this session's scope \(acme\/web\)/,
    );
  });
});
