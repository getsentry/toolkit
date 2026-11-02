import { describe, expect, it } from "vitest";
import { authorizeApiRequest, type CatalogOperation } from "./access";

const dashboardPath =
  "/api/0/organizations/{organization_id_or_slug}/dashboards/";
const issuePath =
  "/api/0/organizations/{organization_id_or_slug}/issues/{issue_id}/";

const catalog: CatalogOperation[] = [
  { method: "GET", path: dashboardPath },
  { method: "POST", path: dashboardPath },
  { method: "PUT", path: issuePath },
  { method: "GET", path: "/api/0/issues/{issue_id}/" },
];

function request(path: string, method: string, organizationSlug?: string) {
  return authorizeApiRequest(
    new URL(path, "https://sentry.io"),
    method,
    catalog,
    { organizationSlug },
  );
}

describe("authorizeApiRequest", () => {
  it("accepts published operations and HEAD on a published GET", () => {
    expect(
      request("/api/0/organizations/example/dashboards/?cursor=next", "GET"),
    ).toEqual({
      pathTemplate: dashboardPath,
      pathname: "/api/0/organizations/example/dashboards/",
      organizationSlug: "example",
    });
    expect(
      request("/api/0/organizations/example/dashboards/", "HEAD").pathTemplate,
    ).toBe(dashboardPath);
    expect(
      request("/api/0/organizations/example/issues/123/", "put").pathTemplate,
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
      pathname: "/api/0/issues/123/",
    });
  });

  it("requires the exact published path and HTTP method", () => {
    expect(() =>
      request("/api/0/organizations/example/private/", "GET"),
    ).toThrow("published API schema");
    expect(() =>
      request("/api/0/organizations/example/dashboards/", "DELETE"),
    ).toThrow("HTTP method");
  });

  it("adds a missing trailing slash to match and send the canonical path", () => {
    expect(
      request("/api/0/organizations/example/dashboards", "GET").pathname,
    ).toBe("/api/0/organizations/example/dashboards/");
    expect(() =>
      request("/api/0/organizations/example/dashboards//", "GET"),
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
    expect(() =>
      authorizeApiRequest(
        new URL("https://sentry.io/api/0/organizations/settings/"),
        "GET",
        [
          {
            method: "GET",
            path: "/api/0/organizations/{organization_id_or_slug}/",
          },
          { method: "POST", path: "/api/0/organizations/settings/" },
        ],
        {},
      ),
    ).toThrow("HTTP method");
  });
});
