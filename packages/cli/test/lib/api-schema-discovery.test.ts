import { describe, expect, test } from "vitest";
import {
  type ApiEndpoint,
  findEndpointsByIdentifier,
  findEndpointsByPath,
  searchEndpoints,
} from "../../src/lib/api-schema.js";

// Representative OpenAPI operations: logs are both an Explore dataset and a
// feature-flag resource. A lexical resource hit must not hide the dataset.
const events: ApiEndpoint = {
  fn: "listOrganizationEvents",
  operationId: "listOrganizationEvents",
  summary: "Query Explore Events in Table Format",
  method: "GET",
  path: "/api/0/organizations/{org}/events/",
  resource: "events",
  description: "Retrieves explore data for a given organization.",
  tags: ["Explore"],
  pathParams: ["org"],
  queryParams: ["dataset"],
  queryParameters: [
    {
      name: "dataset",
      required: true,
      type: "string",
      enum: ["logs", "spans"],
    },
  ],
  deprecated: false,
};
const flagLogs: ApiEndpoint = {
  fn: "listOrganizationFlagLogs",
  operationId: "listOrganizationFlagLogs",
  method: "GET",
  path: "/api/0/organizations/{org}/flags/logs/",
  resource: "logs",
  description: "List an organization's flag logs.",
  pathParams: ["org"],
  queryParams: [],
  deprecated: false,
};

describe("schema discovery", () => {
  test.each(["expl", "xplor", "exlpore"])(
    "discovers partial names and typos without changing exact identity: %s",
    (query) => {
      const result = searchEndpoints(query, [events, flagLogs]);
      expect(result.map((endpoint) => endpoint.fn)).toEqual([events.fn]);
      expect(result[0]?.match?.reasons).toContain("Operation summary");
      expect(findEndpointsByIdentifier(query, [events, flagLogs])).toEqual([]);
    },
  );

  test("literal matches do not acquire unrelated fuzzy candidates", () => {
    const jobs: ApiEndpoint = {
      ...flagLogs,
      fn: "listOrganizationJobs",
      operationId: "listOrganizationJobs",
      resource: "jobs",
      path: "/api/0/organizations/{org}/jobs/",
      description: "List organization jobs.",
    };
    expect(searchEndpoints("logs", [jobs, events, flagLogs])).toEqual(
      searchEndpoints("logs", [events, flagLogs]),
    );
  });

  test("finds log capabilities alongside the exact flags resource and explains the selector", () => {
    const result = searchEndpoints("logs", [flagLogs, events]);
    expect(result.map((endpoint) => endpoint.fn)).toEqual([
      "listOrganizationEvents",
      "listOrganizationFlagLogs",
    ]);
    expect(result[0]?.match?.reasons).toContain(
      "Query parameter: dataset=logs",
    );
    expect(result[1]?.match?.reasons).toContain("API resource: logs");
    expect(searchEndpoints("log", [flagLogs, events])).toEqual(result);
  });

  test("a new API dataset becomes searchable without a vocabulary mapping", () => {
    expect(searchEndpoints("uptime_results", [events])).toEqual([]);
    const grown: ApiEndpoint = {
      ...events,
      queryParameters: [
        {
          name: "dataset",
          required: true,
          enum: ["logs", "spans", "uptime_results"],
        },
      ],
    };
    expect(
      searchEndpoints("uptime_results", [grown])[0]?.match?.reasons,
    ).toContain("Query parameter: dataset=uptime_results");
  });

  test("adding or reordering list operations keeps all candidates and exact lookups stable", () => {
    const issues: ApiEndpoint = {
      ...events,
      fn: "listOrganizationIssues",
      operationId: "listOrganizationIssues",
      resource: "issues",
      path: "/api/0/organizations/{org}/issues/",
    };
    const projectIssues: ApiEndpoint = {
      ...issues,
      fn: "deprecatedListProjectIssues",
      operationId: "List a Project's Issues",
      path: "/api/0/projects/{org}/{project}/issues/",
      deprecated: true,
    };
    const added: ApiEndpoint = {
      ...issues,
      fn: "listTeamIssues",
      operationId: "listTeamIssues",
      path: "/api/0/teams/{team}/issues/",
    };
    const original = searchEndpoints("issues list", [projectIssues, issues]);
    expect(original.map((endpoint) => endpoint.fn)).toEqual([
      issues.fn,
      projectIssues.fn,
    ]);
    const grown = [projectIssues, added, issues];
    const result = searchEndpoints("issue list", grown);
    expect(result.map((endpoint) => endpoint.fn)).toEqual([
      issues.fn,
      added.fn,
      projectIssues.fn,
    ]);
    expect(searchEndpoints("issues list", [...grown].reverse())).toEqual(
      result,
    );
    expect(findEndpointsByIdentifier(issues.fn, grown)).toEqual([issues]);
    expect(findEndpointsByPath(issues.path, "GET", grown)).toEqual([issues]);
  });

  test("preserves both command contexts when they use the same API", () => {
    const result = searchEndpoints(
      "observability",
      [events],
      [
        {
          command: "sentry log list",
          fn: events.fn,
          note: "Queries dataset=logs.",
        },
        {
          command: "sentry trace list",
          fn: events.fn,
          note: "Queries dataset=spans with is_transaction:true.",
        },
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.match?.relatedCommands).toEqual([
      { command: "sentry log list", note: "Queries dataset=logs." },
      {
        command: "sentry trace list",
        note: "Queries dataset=spans with is_transaction:true.",
      },
    ]);
  });

  test("requires every search token and honors an explicit HTTP method", () => {
    expect(searchEndpoints("logs nonexistent", [events, flagLogs])).toEqual([]);
    expect(searchEndpoints("POST logs", [events, flagLogs])).toEqual([]);
    expect(searchEndpoints("GET logs", [events, flagLogs])).toHaveLength(2);
  });

  test("exact path and operation lookup do not acquire discovery metadata", () => {
    expect(searchEndpoints(events.fn, [events, flagLogs])).toEqual([events]);
    expect(searchEndpoints(`GET ${events.path}`, [events, flagLogs])).toEqual([
      events,
    ]);
  });

  test("an exact identifier with a different method cannot become a fuzzy discovery", () => {
    const alternate: ApiEndpoint = {
      ...events,
      fn: "listOrganizationEventsAsync",
      operationId: "listOrganizationEventsAsync",
      method: "POST",
    };
    expect(searchEndpoints(`POST ${events.fn}`, [events, alternate])).toEqual(
      [],
    );
  });
});
