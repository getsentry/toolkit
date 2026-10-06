/**
 * Unit Tests for API Schema Query Functions
 */

import { describe, expect, test } from "vitest";
import {
  findEndpointsByIdentifier,
  findEndpointsByPath,
  getAllEndpoints,
  getAllResources,
  getEndpoint,
  getEndpointsByResource,
  getResourceSummaries,
  parseEndpointQuery,
  searchEndpoints,
} from "../../src/lib/api-schema.js";

describe("getAllEndpoints", () => {
  test("returns non-empty array", () => {
    const endpoints = getAllEndpoints();
    expect(endpoints.length).toBeGreaterThan(100);
  });

  test("every endpoint has required fields", () => {
    for (const ep of getAllEndpoints()) {
      expect(typeof ep.fn).toBe("string");
      expect(typeof ep.method).toBe("string");
      expect(typeof ep.path).toBe("string");
      expect(typeof ep.resource).toBe("string");
      expect(typeof ep.operationId).toBe("string");
      expect(Array.isArray(ep.queryParams)).toBe(true);
      expect(ep.method.length).toBeGreaterThan(0);
      expect(ep.path.startsWith("/api/0/")).toBe(true);
    }
  });

  test("methods are valid HTTP methods", () => {
    const validMethods = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);
    for (const ep of getAllEndpoints()) {
      expect(validMethods.has(ep.method)).toBe(true);
    }
  });
});

describe("getAllResources", () => {
  test("returns sorted unique strings", () => {
    const resources = getAllResources();
    expect(resources.length).toBeGreaterThan(10);

    // Verify sorted
    const sorted = [...resources].sort();
    expect(resources).toEqual(sorted);

    // Verify unique
    expect(new Set(resources).size).toBe(resources.length);
  });

  test("contains known resources", () => {
    const resources = getAllResources();
    expect(resources).toContain("issues");
    expect(resources).toContain("projects");
    expect(resources).toContain("organizations");
    expect(resources).toContain("teams");
  });
});

describe("getEndpointsByResource", () => {
  test("returns endpoints for known resource", () => {
    const endpoints = getEndpointsByResource("issues");
    expect(endpoints.length).toBeGreaterThan(0);
    for (const ep of endpoints) {
      expect(ep.resource).toBe("issues");
    }
  });

  test("is case-insensitive", () => {
    const lower = getEndpointsByResource("issues");
    const upper = getEndpointsByResource("Issues");
    expect(lower).toEqual(upper);
  });

  test("returns empty array for unknown resource", () => {
    expect(getEndpointsByResource("nonexistent")).toEqual([]);
  });
});

describe("getEndpoint", () => {
  test("finds specific endpoint by operationId substring", () => {
    const ep = getEndpoint("issues", "getOrganizationIssue");
    expect(ep).toBeDefined();
    expect(ep?.resource).toBe("issues");
    expect(ep?.method).toBe("GET");
    expect(ep?.fn).toBe("getOrganizationIssue");
  });

  test("is case-insensitive", () => {
    const ep1 = getEndpoint("issues", "list");
    const ep2 = getEndpoint("Issues", "List");
    expect(ep1).toEqual(ep2);
  });

  test("returns undefined for unknown endpoint", () => {
    expect(getEndpoint("issues", "xyznonexistent123")).toBeUndefined();
    expect(getEndpoint("nonexistent", "list")).toBeUndefined();
  });
});

describe("parseEndpointQuery", () => {
  test("parses METHOD + OpenAPI path", () => {
    const parsed = parseEndpointQuery(
      "GET /api/0/organizations/{organization_id_or_slug}/issues/"
    );
    expect(parsed.method).toBe("GET");
    expect(parsed.path).toBe(
      "/api/0/organizations/{organization_id_or_slug}/issues/"
    );
  });

  test("parses a bare /api/ path and adds a trailing slash", () => {
    const parsed = parseEndpointQuery(
      "/api/0/organizations/{organization_id_or_slug}/issues"
    );
    expect(parsed.method).toBeUndefined();
    expect(parsed.path).toBe(
      "/api/0/organizations/{organization_id_or_slug}/issues/"
    );
  });

  test("parses a full Sentry URL and strips the query string", () => {
    const parsed = parseEndpointQuery(
      "https://sentry.io/api/0/organizations/acme/issues/?query=is:unresolved"
    );
    expect(parsed.path).toBe("/api/0/organizations/acme/issues/");
  });

  test("leaves keyword searches alone", () => {
    expect(parseEndpointQuery("issues")).toEqual({ text: "issues" });
    expect(parseEndpointQuery("GET issues").method).toBe("GET");
    expect(parseEndpointQuery("GET issues").path).toBeUndefined();
    expect(parseEndpointQuery("GET issues").text).toBe("issues");
  });
});

describe("findEndpointsByPath", () => {
  test("matches a concrete org slug against {organization_id_or_slug}", () => {
    const matches = findEndpointsByPath(
      "/api/0/organizations/acme/issues/",
      "GET"
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.fn).toBe("listOrganizationIssues");
  });

  test("does not treat a query {param} as a wildcard for static siblings", () => {
    const matches = findEndpointsByPath(
      "/api/0/organizations/{organization_id_or_slug}/preprodartifacts/snapshots/{snapshot_id}/",
      "GET"
    );
    expect(matches.map((e) => e.fn)).toEqual([
      "getOrganizationPreprodArtifactSnapshot",
    ]);
  });

  test("prefers a static segment over a neighboring {param}", () => {
    const matches = findEndpointsByPath(
      "/api/0/organizations/acme/preprodartifacts/snapshots/latest-base/",
      "GET"
    );
    expect(matches.map((e) => e.fn)).toEqual([
      "getOrganizationPreprodArtifactSnapshotLatestBase",
    ]);
  });

  test("does not match getProject when the query is an OpenAPI /issues/ path", () => {
    const matches = findEndpointsByPath(
      "/api/0/projects/{organization_id_or_slug}/issues/",
      "GET"
    );
    expect(matches).toEqual([]);
  });
});

describe("findEndpointsByIdentifier", () => {
  test("finds an endpoint by exact SDK function name", () => {
    const matches = findEndpointsByIdentifier("listOrganizationEvents");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.fn).toBe("listOrganizationEvents");
  });

  test("finds an endpoint by exact OpenAPI operation ID", () => {
    const endpoint = getAllEndpoints().find(
      (candidate) =>
        candidate.fn &&
        candidate.operationId &&
        candidate.fn !== candidate.operationId
    );
    expect(endpoint).toBeDefined();
    if (!endpoint) {
      return;
    }

    expect(findEndpointsByIdentifier(endpoint.operationId)).toContain(endpoint);
  });

  test("is case-insensitive but does not accept partial identifiers", () => {
    expect(findEndpointsByIdentifier("LISTORGANIZATIONEVENTS")[0]?.fn).toBe(
      "listOrganizationEvents"
    );
    expect(findEndpointsByIdentifier("OrganizationEvents")).toEqual([]);
  });
});

describe("searchEndpoints", () => {
  test("finds endpoints by resource name", () => {
    const results = searchEndpoints("issues");
    expect(results.length).toBeGreaterThan(0);
  });

  test("finds endpoints by path fragment", () => {
    const results = searchEndpoints("organizations");
    expect(results.length).toBeGreaterThan(0);
  });

  test("finds endpoints by description keyword", () => {
    const results = searchEndpoints("replay");
    expect(results.length).toBeGreaterThan(0);
  });

  test("is case-insensitive", () => {
    const lower = searchEndpoints("issues");
    const upper = searchEndpoints("ISSUES");
    expect(lower).toEqual(upper);
  });

  test("returns empty for no match", () => {
    expect(searchEndpoints("xyznonexistent123")).toEqual([]);
  });
});

describe("getResourceSummaries", () => {
  test("returns summaries for all resources", () => {
    const summaries = getResourceSummaries();
    const resources = getAllResources();
    expect(summaries.length).toBe(resources.length);
  });

  test("each summary has correct shape", () => {
    for (const summary of getResourceSummaries()) {
      expect(typeof summary.name).toBe("string");
      expect(typeof summary.endpointCount).toBe("number");
      expect(summary.endpointCount).toBeGreaterThan(0);
      expect(Array.isArray(summary.methods)).toBe(true);
      expect(summary.methods.length).toBeGreaterThan(0);
    }
  });

  test("methods are sorted and unique", () => {
    for (const summary of getResourceSummaries()) {
      const sorted = [...summary.methods].sort();
      expect(summary.methods).toEqual(sorted);
      expect(new Set(summary.methods).size).toBe(summary.methods.length);
    }
  });
});
