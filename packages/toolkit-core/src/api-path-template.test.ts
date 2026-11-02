import { describe, expect, it } from "vitest";
import { matchApiPathTemplate } from "./api-path-template.js";

const issues = "/api/0/organizations/{organization_id_or_slug}/issues/";

describe("matchApiPathTemplate", () => {
  it("captures parameters and counts literal segments", () => {
    expect(
      matchApiPathTemplate(issues, "/api/0/organizations/acme/issues/"),
    ).toEqual({
      parameters: { organization_id_or_slug: "acme" },
      // "", "api", "0", "organizations", "issues", ""
      literalSegments: 6,
    });
  });

  it.each([
    ["a different literal", "/api/0/projects/acme/issues/"],
    ["an empty parameter", "/api/0/organizations//issues/"],
    ["a missing trailing slash", "/api/0/organizations/acme/issues"],
    ["an extra segment", "/api/0/organizations/acme/issues/1/"],
  ])("rejects %s", (_, path) => {
    expect(matchApiPathTemplate(issues, path)).toBeUndefined();
  });

  it("ranks a literal route above a parameter at the same position", () => {
    const path = "/api/0/organizations/settings/";
    const generic = matchApiPathTemplate(
      "/api/0/organizations/{organization_id_or_slug}/",
      path,
    );
    const literal = matchApiPathTemplate(path, path);
    expect(literal!.literalSegments).toBeGreaterThan(generic!.literalSegments);
  });

  it("rejects a template that repeats a parameter name", () => {
    expect(matchApiPathTemplate("/{id}/{id}/", "/a/b/")).toBeUndefined();
  });
});
