import { describe, expect, test } from "vitest";
import {
  extractApiEndpoints,
  type OpenApiSpec,
} from "../../script/lib/api-schema.js";

const EVENTS_PATH = "/api/0/organizations/{organization_id_or_slug}/events/";

/** Reduced public OpenAPI Explore operation; no account or event data. */
function exploreSpec(datasets = ["errors", "logs", "spans"]): OpenApiSpec {
  return {
    paths: {
      [EVENTS_PATH]: {
        get: {
          operationId: "listOrganizationEvents",
          summary: "Query Explore Events in Table Format",
          description: "Retrieves explore data for a given organization.",
          tags: ["Explore"],
          parameters: [
            {
              in: "query",
              name: "dataset",
              required: true,
              description:
                "Which dataset to query. The chosen dataset determines which fields are queryable.",
              schema: { type: "string", enum: datasets },
            },
            {
              in: "query",
              name: "field",
              required: true,
              schema: { type: "array" },
            },
            { in: "query", name: "query", schema: { type: "string" } },
          ],
        },
      },
    },
  };
}

describe("extractApiEndpoints", () => {
  test("preserves Explore dataset vocabulary and the existing endpoint fields", () => {
    const endpoints = extractApiEndpoints(
      exploreSpec(),
      new Map([[`GET:${EVENTS_PATH}`, "listOrganizationEvents"]]),
    );

    expect(endpoints).toEqual([
      {
        fn: "listOrganizationEvents",
        method: "GET",
        path: EVENTS_PATH,
        resource: "events",
        operationId: "listOrganizationEvents",
        summary: "Query Explore Events in Table Format",
        description: "Retrieves explore data for a given organization.",
        tags: ["Explore"],
        deprecated: false,
        pathParams: ["organization_id_or_slug"],
        queryParams: ["dataset", "field", "query"],
        queryParameters: [
          {
            name: "dataset",
            required: true,
            description:
              "Which dataset to query. The chosen dataset determines which fields are queryable.",
            type: "string",
            enum: ["errors", "logs", "spans"],
          },
          { name: "field", required: true, type: "array" },
          { name: "query", required: false, type: "string" },
        ],
      },
    ]);
  });

  test("includes new operations and datasets without adding vocabulary mappings", () => {
    const spec = exploreSpec(["errors", "logs", "spans", "uptime_results"]);
    // Based on the separate Explore timeseries operation: the API can add it
    // before the installed SDK has a mapped function name.
    const timeseriesPath =
      "/api/0/organizations/{organization_id_or_slug}/events-timeseries/";
    spec.paths[timeseriesPath] = {
      get: {
        ...spec.paths[EVENTS_PATH]?.get,
        operationId: "listOrganizationEventsTimeseries",
        summary: "Query Explore Events in Timeseries Format",
      },
    };

    const endpoints = extractApiEndpoints(spec, new Map());

    expect(endpoints).toHaveLength(2);
    for (const endpoint of endpoints) {
      expect(endpoint.fn).toBe("");
      expect(endpoint.queryParameters).toContainEqual(
        expect.objectContaining({
          name: "dataset",
          enum: ["errors", "logs", "spans", "uptime_results"],
        }),
      );
    }
    expect(endpoints).toContainEqual(
      expect.objectContaining({
        path: timeseriesPath,
        operationId: "listOrganizationEventsTimeseries",
        summary: "Query Explore Events in Timeseries Format",
        tags: ["Explore"],
      }),
    );
  });

  test("inherits path parameters and lets operations replace matching query parameters", () => {
    const spec: OpenApiSpec = {
      paths: {
        [EVENTS_PATH]: {
          parameters: [
            { in: "path", name: "organization_id_or_slug", required: true },
            { in: "query", name: "cursor", schema: { type: "string" } },
            {
              in: "query",
              name: "dataset",
              schema: { type: "string", enum: ["errors"] },
            },
          ],
          get: {
            parameters: [
              {
                in: "query",
                name: "dataset",
                required: true,
                schema: { type: "string", enum: ["logs", "spans"] },
              },
              { in: "header", name: "cursor", required: true },
            ],
          },
          post: {},
        },
      },
    };

    const endpoints = extractApiEndpoints(spec, new Map());

    expect(endpoints.find((endpoint) => endpoint.method === "GET")).toEqual(
      expect.objectContaining({
        pathParams: ["organization_id_or_slug"],
        queryParams: ["cursor", "dataset"],
        queryParameters: [
          { name: "cursor", required: false, type: "string" },
          {
            name: "dataset",
            required: true,
            type: "string",
            enum: ["logs", "spans"],
          },
        ],
      }),
    );
    expect(endpoints.find((endpoint) => endpoint.method === "POST")).toEqual(
      expect.objectContaining({
        queryParameters: [
          { name: "cursor", required: false, type: "string" },
          {
            name: "dataset",
            required: false,
            type: "string",
            enum: ["errors"],
          },
        ],
      }),
    );
  });

  test("retains scalar and repeated query enum values", () => {
    const spec: OpenApiSpec = {
      paths: {
        "/api/0/organizations/{organization_id_or_slug}/stats_v2/": {
          get: {
            parameters: [
              {
                in: "query",
                name: "groupBy",
                required: true,
                schema: {
                  type: "array",
                  items: { enum: ["outcome", "category", "reason", "project"] },
                },
              },
              {
                in: "query",
                name: "category",
                schema: {
                  type: "string",
                  enum: ["error", "transaction", "monitor"],
                },
              },
            ],
          },
        },
      },
    };

    const [endpoint] = extractApiEndpoints(spec, new Map());

    expect(endpoint?.queryParameters).toEqual([
      {
        name: "groupBy",
        required: true,
        type: "array",
        enum: ["outcome", "category", "reason", "project"],
      },
      {
        name: "category",
        required: false,
        type: "string",
        enum: ["error", "transaction", "monitor"],
      },
    ]);
  });
});
