import {
  listOrganizationEventsTimeseries,
  type ListOrganizationEventsTimeseriesData,
  type OrganizationEventsTimeseriesResponse,
} from "@sentry/api";
import { vListOrganizationEventsTimeseriesResponse } from "@sentry/api/valibot";
import { parse } from "valibot";
import { describe, expect, test } from "vitest";
import { apiCommand } from "../../../src/commands/api.js";
import { EventsTimeseriesResponseSchema } from "../../../src/types/dashboard.js";
import { mockFetch } from "../../helpers.js";

describe("transformation contracts", () => {
  test("serializes indexed transformations and preserves nullable values and provenance", async () => {
    const response = {
      meta: {
        dataset: "spans",
        start: 1_700_000_000_000,
        end: 1_700_000_300_000,
        ingestion: {
          status: "healthy",
          delaySeconds: 10,
          completeThrough: 1_700_000_300_000,
        },
      },
      timeSeries: [
        {
          yAxis: "count()",
          groupBy: [
            { key: "project", value: 42 },
            { key: "environment", value: "production" },
            { key: "release", value: null },
          ],
          meta: {
            interval: 300_000,
            valueType: "integer",
            valueUnit: null,
            dataScanned: "partial",
          },
          values: [
            {
              timestamp: 1_700_000_000_000,
              value: null,
              comparisonValue: null,
              incomplete: true,
              incompleteReason: "INGESTION_PENDING",
              filled: false,
              smoothed: false,
              comparisonFilled: true,
              comparisonSmoothed: true,
              sampleCount: 0,
              sampleRate: null,
              confidence: null,
            },
          ],
        },
      ],
    } satisfies OrganizationEventsTimeseriesResponse;
    const laterAxis = {
      "transformations[2]": ["smooth(sma,3)", "fill(locf)"],
    };
    const query = {
      dataset: "spans",
      yAxis: ["count()", "count()", "count()"],
      "transformations[0]": ["fill(zero)"],
      ...laterAxis,
      interval: "5m",
    } satisfies ListOrganizationEventsTimeseriesData["query"];
    const requests: Request[] = [];
    const result = await listOrganizationEventsTimeseries({
      baseUrl: "https://de.sentry.io",
      path: { organization_id_or_slug: "acme" },
      query,
      fetch: mockFetch(async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(response);
      }),
    });

    expect(result.data).toEqual(response);
    expect(
      parse(vListOrganizationEventsTimeseriesResponse, result.data),
    ).toEqual(response);
    expect(parse(EventsTimeseriesResponseSchema, result.data)).toEqual(
      response,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("GET");
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe("/api/0/organizations/acme/events-timeseries/");
    expect([...url.searchParams]).toEqual([
      ["dataset", "spans"],
      ["yAxis", "count()"],
      ["yAxis", "count()"],
      ["yAxis", "count()"],
      ["transformations[0]", "fill(zero)"],
      ["transformations[2]", "smooth(sma,3)"],
      ["transformations[2]", "fill(locf)"],
      ["interval", "5m"],
    ]);
  });

  test("omits unspecified and empty transformations and an unspecified interval", async () => {
    const requests: Request[] = [];
    const result = await listOrganizationEventsTimeseries({
      baseUrl: "https://sentry.io",
      path: { organization_id_or_slug: "acme" },
      query: {
        dataset: "spans",
        yAxis: ["count()"],
        "transformations[0]": [],
        interval: undefined,
      },
      fetch: mockFetch(async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ timeSeries: [] });
      }),
    });

    expect(result.data).toEqual({ timeSeries: [] });
    expect([...new URL(requests[0].url).searchParams]).toEqual([
      ["dataset", "spans"],
      ["yAxis", "count()"],
    ]);
  });

  test.each([
    { name: "omission", field: { yAxes: ["count()"] } },
    { name: "clearing", field: { yAxes: ["count()"], transformations: [] } },
    {
      name: "ordered stages",
      field: {
        yAxes: ["count()"],
        transformations: ["smooth(sma,3)", "fill(locf)"],
      },
    },
  ])("preserves saved-query $name in a JSON body", async ({ field }) => {
    let output = "";
    const func = await apiCommand.loader();
    await func.call(
      {
        cwd: "/tmp",
        stdin: process.stdin,
        stdout: {
          write(value: string | Uint8Array) {
            output += String(value);
            return true;
          },
        },
        stderr: { write: () => true },
      },
      {
        method: "PUT",
        silent: false,
        verbose: false,
        "dry-run": true,
        json: true,
        data: JSON.stringify({
          query: [{ mode: "aggregate", aggregateField: [field] }],
        }),
      },
      "https://sentry.io/api/0/organizations/acme/explore/saved/42/",
    );

    const request = JSON.parse(output);
    expect(request.method).toBe("PUT");
    expect(request.body).toEqual({
      query: [{ mode: "aggregate", aggregateField: [field] }],
    });
  });
});
