/**
 * Tests for listTraceItemAttributes (trace-items attribute key discovery).
 *
 * Verifies URL construction, query parameter encoding (including repeated
 * array params and omission of empty filters), "has more" detection,
 * and error propagation.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listTraceItemAttributes } from "../../../src/lib/api/traces.js";
import { DEFAULT_SENTRY_URL } from "../../../src/lib/constants.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { ApiError } from "../../../src/lib/errors.js";
import { resetAuthenticatedFetch } from "../../../src/lib/sentry-client.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("api-trace-item-attributes-");

const ATTRIBUTES = [
  {
    key: "span.op",
    name: "span.op",
    attributeType: "string",
    attributeSource: { source_type: "sentry" },
  },
  {
    key: "gen_ai.usage.input_tokens",
    name: "gen_ai.usage.input_tokens",
    attributeType: "number",
    attributeSource: { source_type: "user" },
  },
];

let originalFetch: typeof globalThis.fetch;
let capturedUrl: URL | undefined;

function mockOk(body: unknown, headers: Record<string, string> = {}) {
  globalThis.fetch = mockFetch(async (input, init) => {
    capturedUrl = new URL(new Request(input!, init).url);
    return Response.json(body, { headers });
  });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  capturedUrl = undefined;
  resetAuthenticatedFetch();
  setAuthToken("test-token");
  setOrgRegion("test-org", DEFAULT_SENTRY_URL);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAuthenticatedFetch();
});

describe("listTraceItemAttributes", () => {
  test("calls the org-scoped attributes endpoint with only the dataset when no filters are set", async () => {
    mockOk(ATTRIBUTES);

    const { data } = await listTraceItemAttributes("test-org", {
      dataset: "spans",
    });

    expect(capturedUrl?.pathname).toBe(
      "/api/0/organizations/test-org/trace-items/attributes/",
    );
    expect([...capturedUrl!.searchParams.keys()]).toEqual(["dataset"]);
    expect(capturedUrl?.searchParams.get("dataset")).toBe("spans");
    expect(data).toEqual(ATTRIBUTES);
  });

  test("encodes array filters as repeated params and passes string filters through", async () => {
    mockOk([]);

    await listTraceItemAttributes("test-org", {
      dataset: "logs",
      project: [123, "backend"],
      environment: ["production"],
      attributeTypes: ["string", "number"],
    });

    const params = capturedUrl!.searchParams;
    expect(params.get("dataset")).toBe("logs");
    expect(params.getAll("project")).toEqual(["123", "backend"]);
    expect(params.getAll("environment")).toEqual(["production"]);
    expect(params.getAll("attributeType")).toEqual(["string", "number"]);
  });

  test("omits empty arrays and empty strings instead of sending blank params", async () => {
    mockOk([]);

    await listTraceItemAttributes("test-org", {
      dataset: "spans",
      project: [],
      environment: [],
      query: "",
    });

    expect([...capturedUrl!.searchParams.keys()]).toEqual(["dataset"]);
  });

  test("sends perPage as per_page", async () => {
    mockOk([]);
    await listTraceItemAttributes("test-org", {
      dataset: "spans",
      perPage: 25,
    });
    expect(capturedUrl?.searchParams.get("per_page")).toBe("25");
  });

  test("sends expand=context only when context is requested", async () => {
    mockOk([]);
    await listTraceItemAttributes("test-org", {
      dataset: "spans",
      context: true,
    });
    expect(capturedUrl?.searchParams.getAll("expand")).toEqual(["context"]);

    mockOk([]);
    await listTraceItemAttributes("test-org", {
      dataset: "spans",
      context: false,
    });
    expect(capturedUrl?.searchParams.has("expand")).toBe(false);
  });

  test("reports that more results exist when Sentry's Link header says so", async () => {
    mockOk(ATTRIBUTES, {
      Link: '<https://sentry.io/api/0/next/>; rel="next"; results="true"; cursor="0:100:0"',
    });

    const result = await listTraceItemAttributes("test-org", {
      dataset: "spans",
    });

    expect(result.nextCursor).toBeTruthy();
  });

  test("throws ApiError with dataset context on failure", async () => {
    globalThis.fetch = mockFetch(async () =>
      Response.json({ detail: "You do not have permission" }, { status: 403 }),
    );

    const promise = listTraceItemAttributes("test-org", { dataset: "logs" });
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toThrow(/logs attributes/);
  });
});
