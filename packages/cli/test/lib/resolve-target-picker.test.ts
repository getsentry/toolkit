import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { setAuthToken } from "../../src/lib/db/auth.js";
import {
  getDefaultOrganization,
  getDefaultProject,
  setDefaultOrganization,
  setDefaultProject,
} from "../../src/lib/db/defaults.js";
import { ContextError } from "../../src/lib/errors.js";
import { guideOrgProjectFailure } from "../../src/lib/resolve-target.js";
import organizationsFixture from "../fixtures/organizations.json";
import projectsFixture from "../fixtures/projects.json";
import { useEnvSandbox, useTestConfigDir } from "../helpers.js";
import { createMockServer, type MockServer } from "../mocks/server.js";

const { selectWithFilter } = vi.hoisted(() => ({ selectWithFilter: vi.fn() }));
vi.mock("../../src/lib/init/ui/ink-ui.js", () => ({ selectWithFilter }));

useTestConfigDir("test-target-picker-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_URL",
  "SENTRY_HOST",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
]);

let originalFetch: typeof globalThis.fetch;
let server: MockServer;
let organizations: typeof organizationsFixture;
let projects: typeof projectsFixture;
let requestedPaths: string[];

// Keep one origin for the process-level region cache; each case gets a fresh DB.
beforeAll(async () => {
  server = createMockServer(
    [
      {
        method: "GET",
        path: "/api/0/organizations/",
        response: (request: Request) => {
          requestedPaths.push(new URL(request.url).pathname);
          return { body: organizations };
        },
      },
      {
        method: "GET",
        path: "/api/0/organizations/:orgSlug/projects/",
        response: (request: Request) => {
          requestedPaths.push(new URL(request.url).pathname);
          return { body: projects };
        },
      },
    ],
    { validTokens: ["test-picker-token"] },
  );
  await server.start();
});

afterAll(() => {
  server?.stop();
});

beforeEach(() => {
  selectWithFilter.mockReset();
  originalFetch = globalThis.fetch;
  organizations = organizationsFixture;
  projects = projectsFixture;
  requestedPaths = [];
  const realFetch = (globalThis as { __originalFetch?: typeof fetch })
    .__originalFetch;
  if (!realFetch) {
    throw new Error(
      "Test preload did not preserve the real fetch implementation",
    );
  }
  process.env.SENTRY_URL = server.url;
  setAuthToken("test-picker-token");
  globalThis.fetch = realFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("interactive org/project resolution", () => {
  test("passes names and slugs to filterable pickers and persists the selected target", async () => {
    selectWithFilter
      .mockResolvedValueOnce("test-org-2")
      .mockResolvedValueOnce("test-project-2");

    const target = await guideOrgProjectFailure({ interactive: true });

    expect(target).toMatchObject({
      org: "test-org-2",
      project: "test-project-2",
    });
    expect(selectWithFilter).toHaveBeenNthCalledWith(1, {
      message: "Select an organization:",
      options: organizationsFixture.map((org) => ({
        label: org.name,
        value: org.slug,
      })),
    });
    expect(selectWithFilter).toHaveBeenNthCalledWith(2, {
      message: "Select a project:",
      options: projectsFixture.map((project) => ({
        label: project.name,
        value: project.slug,
      })),
    });
    expect(requestedPaths).toEqual([
      "/api/0/organizations/",
      "/api/0/organizations/test-org-2/projects/",
    ]);
    expect(getDefaultOrganization()).toBe("test-org-2");
    expect(getDefaultProject()).toBe("test-project-2");
  });

  test("preserves saved defaults when the project picker is cancelled", async () => {
    setDefaultOrganization("saved-org");
    setDefaultProject("saved-project");
    selectWithFilter
      .mockResolvedValueOnce("test-org")
      .mockResolvedValueOnce(null);

    await expect(
      guideOrgProjectFailure({ interactive: true }),
    ).rejects.toBeInstanceOf(ContextError);

    expect(getDefaultOrganization()).toBe("saved-org");
    expect(getDefaultProject()).toBe("saved-project");
  });

  test("auto-selects and persists sole options without loading a picker", async () => {
    organizations = organizationsFixture.slice(0, 1);
    projects = projectsFixture.slice(0, 1);

    const target = await guideOrgProjectFailure({ interactive: true });

    expect(target).toMatchObject({ org: "test-org", project: "test-project" });
    expect(selectWithFilter).not.toHaveBeenCalled();
    expect(getDefaultOrganization()).toBe("test-org");
    expect(getDefaultProject()).toBe("test-project");
  });

  test("surfaces renderer failures without persisting a target or retrying the prompt", async () => {
    const error = new Error("Unable to render picker");
    selectWithFilter.mockRejectedValue(error);

    await expect(guideOrgProjectFailure({ interactive: true })).rejects.toBe(
      error,
    );
    expect(selectWithFilter).toHaveBeenCalledTimes(1);
    expect(getDefaultOrganization()).toBeNull();
    expect(getDefaultProject()).toBeNull();
  });
});
