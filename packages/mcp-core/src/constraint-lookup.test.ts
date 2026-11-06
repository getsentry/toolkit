import { describe, expect, it, vi } from "vitest";
import {
  ApiNotFoundError,
  ApiPermissionError,
  type SentryApiService,
} from "./api-client/index";
import {
  allowedRegionHost,
  ConstraintLookupTimeoutError,
  lookupConstraints,
} from "./constraint-lookup";

const ORG = { id: "1", slug: "acme", name: "Acme" };
const PROJECT = { id: "2", slug: "web", name: "web" };

function orgInRegion(regionUrl: string) {
  return { ...ORG, links: { regionUrl, organizationUrl: "https://acme.io" } };
}

function stubApi({
  getOrganization = async () => ORG,
  getProject = async () => PROJECT,
}: {
  getOrganization?: () => Promise<unknown>;
  getProject?: () => Promise<unknown>;
}) {
  const api = {
    getOrganization: vi.fn(getOrganization),
    getProject: vi.fn(getProject),
  };
  return { api, service: api as unknown as SentryApiService };
}

const scope = { organizationSlug: "acme" };
const options = { projectHost: () => undefined };

describe("lookupConstraints", () => {
  it("finds an organization without asking for a project", async () => {
    const { api, service } = stubApi({});
    const result = await lookupConstraints(service, scope, options);
    expect(result).toEqual({
      organization: { status: "ok", value: ORG },
      regionUrl: null,
      project: null,
    });
    expect(api.getProject).not.toHaveBeenCalled();
  });

  it("classifies a 404 organization and skips the project", async () => {
    const error = new ApiNotFoundError("Not Found");
    const { api, service } = stubApi({
      getOrganization: () => Promise.reject(error),
    });
    const result = await lookupConstraints(
      service,
      { ...scope, projectSlug: "web" },
      options,
    );
    expect(result.organization).toEqual({ status: "not-found", error });
    expect(result.project).toBeNull();
    expect(api.getProject).not.toHaveBeenCalled();
  });

  it("classifies any other organization failure as unknown", async () => {
    const error = new ApiPermissionError("Forbidden");
    const { api, service } = stubApi({
      getOrganization: () => Promise.reject(error),
    });
    const result = await lookupConstraints(
      service,
      { ...scope, projectSlug: "web" },
      options,
    );
    expect(result.organization).toEqual({ status: "unknown", error });
    expect(api.getProject).not.toHaveBeenCalled();
  });

  it("asks for the project on the host projectHost picks", async () => {
    const projectHost = vi.fn(() => "de.sentry.io");
    const { api, service } = stubApi({
      getOrganization: async () => orgInRegion("https://de.sentry.io"),
    });
    const result = await lookupConstraints(
      service,
      { ...scope, projectSlug: "web" },
      { projectHost },
    );
    expect(projectHost).toHaveBeenCalledWith("https://de.sentry.io");
    expect(result.regionUrl).toBe("https://de.sentry.io");
    expect(result.project).toEqual({ status: "ok", value: PROJECT });
    expect(api.getProject).toHaveBeenCalledWith(
      {
        organizationSlug: "acme",
        projectSlugOrId: "web",
        collapse: "organization",
      },
      { host: "de.sentry.io" },
    );
  });

  it("classifies a projectHost throw as unknown", async () => {
    const error = new TypeError("Invalid URL");
    const { api, service } = stubApi({});
    const result = await lookupConstraints(
      service,
      { ...scope, projectSlug: "web" },
      {
        projectHost: () => {
          throw error;
        },
      },
    );
    expect(result.project).toEqual({ status: "unknown", error });
    expect(api.getProject).not.toHaveBeenCalled();
  });

  it("classifies a 404 project", async () => {
    const error = new ApiNotFoundError("Not Found");
    const { service } = stubApi({ getProject: () => Promise.reject(error) });
    const result = await lookupConstraints(
      service,
      { ...scope, projectSlug: "web" },
      options,
    );
    expect(result.project).toEqual({ status: "not-found", error });
  });

  it("reports a lookup that outlasts its time limit as a timeout", async () => {
    const { service } = stubApi({
      getProject: () => new Promise(() => {}),
    });
    const result = await lookupConstraints(
      service,
      { ...scope, projectSlug: "web" },
      { ...options, projectTimeoutMs: 5 },
    );
    expect(result.project?.status).toBe("unknown");
    expect(
      result.project?.status === "unknown" && result.project.error,
    ).toBeInstanceOf(ConstraintLookupTimeoutError);
  });
});

describe("allowedRegionHost", () => {
  it("accepts a known Sentry region", () => {
    expect(allowedRegionHost("https://de.sentry.io", "sentry.io")).toBe(
      "de.sentry.io",
    );
  });

  it("rejects a host outside the allowlist", () => {
    expect(
      allowedRegionHost("https://evil.example.com", "sentry.io"),
    ).toBeUndefined();
  });

  it("returns undefined without a region URL", () => {
    expect(allowedRegionHost(null, "sentry.io")).toBeUndefined();
  });
});
