import { operations, type ApiOperation } from "@sentry/api/operations";
import { describe, expect, test } from "vitest";
import { projectApiOperations } from "../../script/lib/api-schema.js";
import { searchEndpoints } from "../../src/lib/api-schema.js";

const events = {
  functionName: "listOrganizationEvents",
  operationId: "List an Organization's Events",
  method: "GET",
  path: "/api/0/organizations/{organization_id_or_slug}/events/",
  summary: "Query events",
  description: "Select the dataset to query.",
  tags: ["Explore"],
  pathParameters: ["organization_id_or_slug"],
  queryParameters: [
    {
      name: "dataset",
      required: true,
      type: "string",
      enum: ["logs", "spans"],
    },
    {
      name: "field",
      required: false,
      type: "array",
      enum: ["id", "timestamp"],
    },
  ],
  deprecated: false,
  idempotent: true,
} as const satisfies ApiOperation;

describe("SDK catalog projection", () => {
  test("preserves the CLI endpoint JSON shape alongside SDK metadata", () => {
    expect(projectApiOperations([events])).toEqual([
      {
        fn: "listOrganizationEvents",
        operationId: "List an Organization's Events",
        method: "GET",
        path: "/api/0/organizations/{organization_id_or_slug}/events/",
        summary: "Query events",
        description: "Select the dataset to query.",
        tags: ["Explore"],
        pathParams: ["organization_id_or_slug"],
        queryParams: ["dataset", "field"],
        queryParameters: events.queryParameters,
        resource: "events",
        deprecated: false,
      },
    ]);
  });

  test("keeps resource ordering and legacy deprecation detection local", () => {
    const endpoints = projectApiOperations([
      { ...events, operationId: "Z", deprecated: true },
      { ...events, operationId: "Deprecated operation" },
      { ...events, operationId: "A", functionName: "deprecatedListEvents" },
      {
        ...events,
        path: "/api/0/projects/{org}/{project}/alerts/{alert_id}/",
        operationId: "Get a project alert",
      },
    ]);

    expect(
      endpoints.map(({ resource, operationId, deprecated }) => ({
        resource,
        operationId,
        deprecated,
      })),
    ).toEqual([
      {
        resource: "alerts",
        operationId: "Get a project alert",
        deprecated: false,
      },
      { resource: "events", operationId: "A", deprecated: true },
      {
        resource: "events",
        operationId: "Deprecated operation",
        deprecated: true,
      },
      { resource: "events", operationId: "Z", deprecated: true },
    ]);
  });

  test("discovers log and span datasets from the installed SDK catalog", () => {
    const catalog = projectApiOperations(operations);
    for (const dataset of ["logs", "spans"]) {
      expect(searchEndpoints(dataset, catalog)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fn: "listOrganizationEvents",
            queryParameters: expect.arrayContaining([
              expect.objectContaining({
                name: "dataset",
                enum: expect.arrayContaining([dataset]),
              }),
            ]),
          }),
        ]),
      );
    }
  });
});
