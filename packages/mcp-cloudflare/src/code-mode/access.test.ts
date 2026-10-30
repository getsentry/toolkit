import { describe, expect, it } from "vitest";
import { authorizeApiRequest } from "./access";

const dashboardPath =
  "/api/0/organizations/{organization_id_or_slug}/dashboards/";
const monitorPath =
  "/api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/monitors/{monitor_id_or_slug}/";
const releasePath = "/api/0/organizations/{organization_id_or_slug}/releases/";
const issuePath =
  "/api/0/organizations/{organization_id_or_slug}/issues/{issue_id}/";

// Scope excerpts from the pinned Sentry OpenAPI. In particular, dashboard
// writes accept org:read upstream, while monitor and release writes do not.
const spec = {
  paths: {
    [dashboardPath]: {
      get: {
        security: [{ auth_token: ["org:admin", "org:read", "org:write"] }],
      },
      post: {
        security: [{ auth_token: ["org:admin", "org:read", "org:write"] }],
      },
    },
    [monitorPath]: {
      put: {
        security: [
          { auth_token: ["alerts:write", "project:admin", "project:write"] },
        ],
      },
    },
    [releasePath]: {
      post: {
        security: [
          {
            auth_token: [
              "org:ci",
              "project:admin",
              "project:releases",
              "project:write",
            ],
          },
        ],
      },
    },
    [issuePath]: {
      put: { security: [{ auth_token: ["event:admin", "event:write"] }] },
    },
    "/api/0/issues/{issue_id}/": {
      get: {
        security: [
          { auth_token: ["event:admin", "event:read", "event:write"] },
        ],
      },
    },
  },
};

function request(path: string, method: string, organizationSlug?: string) {
  return authorizeApiRequest(new URL(path, "https://sentry.io"), method, spec, {
    organizationSlug,
  });
}

describe("authorizeApiRequest", () => {
  it("accepts a published read and HEAD fallback", () => {
    expect(
      request("/api/0/organizations/example/dashboards/?cursor=next", "GET"),
    ).toEqual({
      pathTemplate: dashboardPath,
      organizationSlug: "example",
    });
    expect(
      request("/api/0/organizations/example/dashboards/", "HEAD").pathTemplate,
    ).toBe(dashboardPath);
  });

  it("leaves upstream scopes to Sentry for published writes", () => {
    expect(
      request("/api/0/organizations/example/dashboards/", "POST").pathTemplate,
    ).toBe(dashboardPath);
    expect(
      request("/api/0/projects/example/frontend/monitors/import/", "PUT")
        .pathTemplate,
    ).toBe(monitorPath);
    expect(
      request("/api/0/organizations/example/releases/", "POST").pathTemplate,
    ).toBe(releasePath);
    expect(
      request("/api/0/organizations/example/issues/123/", "PUT").pathTemplate,
    ).toBe(issuePath);
  });

  it("enforces the organization slug and rejects unscoped object IDs", () => {
    expect(
      request("/api/0/organizations/ex%61mple/dashboards/", "GET", "example")
        .organizationSlug,
    ).toBe("example");
    for (const path of [
      "/api/0/organizations/another/dashboards/",
      "/api/0/organizations/123/dashboards/",
      "/api/0/issues/123/?organization=example",
    ]) {
      expect(() => request(path, "GET", "example")).toThrow(
        "organization constraint",
      );
    }
    expect(request("/api/0/issues/123/", "GET")).toEqual({
      pathTemplate: "/api/0/issues/{issue_id}/",
    });
  });

  it("requires the exact published path and HTTP method", () => {
    expect(() =>
      request("/api/0/organizations/example/private/", "GET"),
    ).toThrow("published API schema");
    expect(() =>
      request("/api/0/organizations/example/dashboards/", "DELETE"),
    ).toThrow("HTTP method");
    expect(() =>
      request("/api/0/organizations/example/dashboards", "GET"),
    ).toThrow("published API schema");
  });

  it("rejects encoded separators before treating a path segment as an identifier", () => {
    for (const organization of [
      "example%2fanother",
      "example%5canother",
      "example%252fanother",
      "example%zz",
    ]) {
      expect(() =>
        request(`/api/0/organizations/${organization}/dashboards/`, "GET"),
      ).toThrow(/API path/);
    }
    // URL normalization happens before authorization: traversing to another
    // organization must be checked against the final path, not the input prefix.
    expect(() =>
      request(
        "/api/0/organizations/example/%2e%2e/another/dashboards/",
        "GET",
        "example",
      ),
    ).toThrow("organization constraint");
  });

  it("does not fall back to a generic route when a literal route denies access", () => {
    const overlappingSpec = {
      paths: {
        "/api/0/organizations/{organization_id_or_slug}/": {
          get: { security: [{ auth_token: ["org:read"] }] },
        },
        "/api/0/organizations/settings/": {
          post: { security: [{ auth_token: ["org:write"] }] },
        },
      },
    };
    expect(() =>
      authorizeApiRequest(
        new URL("https://sentry.io/api/0/organizations/settings/"),
        "GET",
        overlappingSpec,
        {},
      ),
    ).toThrow("HTTP method");
  });

  it("requires a catalog but does not use security metadata as an MCP grant", () => {
    const url = new URL(
      "https://sentry.io/api/0/organizations/example/dashboards/",
    );
    expect(() => authorizeApiRequest(url, "GET", {}, {})).toThrow(
      "operation catalog",
    );
    expect(
      authorizeApiRequest(
        url,
        "GET",
        { paths: { [dashboardPath]: { get: {} } } },
        {},
      ).pathTemplate,
    ).toBe(dashboardPath);
  });
});
