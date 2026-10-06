/**
 * Issue Command Utilities Tests
 *
 * Tests for shared utilities in src/commands/issue/utils.ts
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildCommandHint,
  ensureRootCauseAnalysis,
  mapIssueArgsConcurrently,
  pollAutofixState,
  resolveIssue,
  resolveOrgAndIssueId,
} from "../../../src/commands/issue/utils.js";
import { DEFAULT_SENTRY_URL } from "../../../src/lib/constants.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setCachedProject } from "../../../src/lib/db/project-cache.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import {
  ApiError,
  ContextError,
  ResolutionError,
} from "../../../src/lib/errors.js";
import {
  mockFetch,
  resetHostScopingState,
  useEnvSandbox,
  useTestConfigDir,
} from "../../helpers.js";

describe("mapIssueArgsConcurrently", () => {
  test("reports only partial failures", async () => {
    const failure = new Error("missing");
    const onError = vi.fn();

    const result = await mapIssueArgsConcurrently(
      ["missing", "found"],
      async (issueArg) => {
        if (issueArg === "missing") {
          throw failure;
        }
        return issueArg;
      },
      onError
    );

    expect(result).toEqual(["found"]);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith("missing", failure);
  });

  test("rethrows total failure without emitting warnings", async () => {
    const primary = new Error("primary");
    const secondary = new Error("secondary");
    const onError = vi.fn();

    await expect(
      mapIssueArgsConcurrently(
        ["first", "second"],
        async (issueArg) => {
          throw issueArg === "first" ? primary : secondary;
        },
        onError
      )
    ).rejects.toBe(primary);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("buildCommandHint", () => {
  test("suggests <org>/ID for numeric IDs", () => {
    expect(buildCommandHint("view", "123456789")).toBe(
      "sentry issue view <org>/123456789"
    );
    expect(buildCommandHint("explain", "0")).toBe(
      "sentry issue explain <org>/0"
    );
  });

  test("suggests <project>-suffix for short suffixes", () => {
    expect(buildCommandHint("view", "G")).toBe("sentry issue view <project>-G");
    expect(buildCommandHint("explain", "4Y")).toBe(
      "sentry issue explain <project>-4Y"
    );
    expect(buildCommandHint("plan", "ABC")).toBe(
      "sentry issue plan <project>-ABC"
    );
  });

  test("suggests <org>/ID for IDs with dashes", () => {
    expect(buildCommandHint("view", "cli-G")).toBe(
      "sentry issue view <org>/cli-G"
    );
    expect(buildCommandHint("explain", "PROJECT-ABC")).toBe(
      "sentry issue explain <org>/PROJECT-ABC"
    );
  });

  test("suggests <org>/@selector for selectors", () => {
    expect(buildCommandHint("view", "@latest")).toBe(
      "sentry issue view <org>/@latest"
    );
    expect(buildCommandHint("explain", "@most_frequent")).toBe(
      "sentry issue explain <org>/@most_frequent"
    );
  });

  test("shows as-is when input already contains a slash (CLI-8C)", () => {
    // org/numeric — don't add another <org>/ prefix
    expect(buildCommandHint("view", "saber-ut/103103195")).toBe(
      "sentry issue view saber-ut/103103195"
    );
    // org/project-suffix — already has full context
    expect(buildCommandHint("view", "sentry/cli-G")).toBe(
      "sentry issue view sentry/cli-G"
    );
    // org/project/suffix — three-level path, show as-is
    expect(buildCommandHint("explain", "sentry/cli/CLI-A1")).toBe(
      "sentry issue explain sentry/cli/CLI-A1"
    );
  });

  test("suggests org/<project>-suffix for bare org/suffix form", () => {
    // org/SUFFIX with no project prefix — guide user to supply a project
    expect(buildCommandHint("view", "sentry/SERVER")).toBe(
      "sentry issue view sentry/<project>-SERVER"
    );
    expect(buildCommandHint("explain", "my-org/ABC")).toBe(
      "sentry issue explain my-org/<project>-ABC"
    );
  });

  test("shows as-is for slash forms that aren't a bare org/suffix", () => {
    // org/@selector — a special selector, not a project suffix (CLI-RD review)
    expect(buildCommandHint("view", "sentry/@latest")).toBe(
      "sentry issue view sentry/@latest"
    );
    // org/project/suffix — multi-segment path is already fully specified
    expect(buildCommandHint("view", "sentry/cli/A1")).toBe(
      "sentry issue view sentry/cli/A1"
    );
    // org/project#suffix — GitHub-style separator, already has project context
    expect(buildCommandHint("view", "sentry/cli#A1")).toBe(
      "sentry issue view sentry/cli#A1"
    );
    // leading slash with no org — don't fabricate an org/<project> template
    expect(buildCommandHint("view", "/SERVER")).toBe(
      "sentry issue view /SERVER"
    );
  });

  test("returns URL as-is for share URLs", () => {
    const shareUrl =
      "https://gibush-kq.sentry.io/share/issue/f1abd515c51346778384ff25dfb341e5/";
    expect(buildCommandHint("view", shareUrl)).toBe(
      `sentry issue view ${shareUrl}`
    );
  });

  test("returns URL as-is for regular issue URLs", () => {
    const issueUrl = "https://sentry.io/organizations/my-org/issues/12345/";
    expect(buildCommandHint("view", issueUrl)).toBe(
      `sentry issue view ${issueUrl}`
    );
  });

  test("supports a custom command domain", () => {
    expect(buildCommandHint("view", "PROJECT-ABC", "sentry feedback")).toBe(
      "sentry feedback view <org>/PROJECT-ABC"
    );
  });
});

const getConfigDir = useTestConfigDir("test-issue-utils-", {
  isolateProjectRoot: true,
});

let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  // Default to a silent 404 so tests that don't set a custom fetch mock
  // won't produce "unexpected fetch" warnings from the preload trap.
  globalThis.fetch = mockFetch(
    async () =>
      new Response(JSON.stringify({ detail: "Not found" }), { status: 404 })
  );
  await setAuthToken("test-token");
  // Pre-populate region cache for orgs used in tests to avoid region resolution API calls
  setOrgRegion("test-org", DEFAULT_SENTRY_URL);
  setOrgRegion("my-org", DEFAULT_SENTRY_URL);
  setOrgRegion("cached-org", DEFAULT_SENTRY_URL);
  setOrgRegion("org1", DEFAULT_SENTRY_URL);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("resolveOrgAndIssueId", () => {
  test("uses a custom command domain in deep resolution suggestions", async () => {
    const error = await resolveIssue({
      issueArg: "my-org/G",
      cwd: getConfigDir(),
      command: "view",
      commandBase: "sentry feedback",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ResolutionError);
    expect((error as ResolutionError).hint).toContain("sentry feedback view");
    expect((error as ResolutionError).suggestions).toEqual([
      "The format 'my-org/G' requires a project to build the full issue ID.",
      "Use: sentry feedback view my-org/<project>-G",
    ]);
  });

  test("throws for numeric ID (org cannot be resolved)", async () => {
    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      // Numeric ID is fetched directly
      if (url.includes("/issues/123456789/")) {
        return new Response(
          JSON.stringify({
            id: "123456789",
            shortId: "PROJECT-ABC",
            title: "Test Issue",
            status: "unresolved",
            platform: "javascript",
            type: "error",
            count: "10",
            userCount: 5,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    // Numeric IDs don't have org context, so resolveOrgAndIssueId should throw
    await expect(
      resolveOrgAndIssueId({
        issueArg: "123456789",
        cwd: getConfigDir(),
        command: "explain",
      })
    ).rejects.toThrow("organization");
  });

  test("resolves numeric ID when API response includes subdomain-style permalink", async () => {
    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      if (url.includes("/issues/123456789/")) {
        return new Response(
          JSON.stringify({
            id: "123456789",
            shortId: "PROJECT-ABC",
            title: "Test Issue",
            status: "unresolved",
            platform: "javascript",
            type: "error",
            count: "10",
            userCount: 5,
            // Org slug embedded in subdomain-style permalink
            permalink: "https://my-org.sentry.io/issues/123456789/",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    // Org should be extracted from permalink — no longer throws
    const result = await resolveOrgAndIssueId({
      issueArg: "123456789",
      cwd: getConfigDir(),
      command: "explain",
    });
    expect(result.org).toBe("my-org");
    expect(result.issueId).toBe("123456789");
  });

  test("resolves numeric ID when API response includes path-style permalink", async () => {
    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      if (url.includes("/issues/55555555/")) {
        return new Response(
          JSON.stringify({
            id: "55555555",
            shortId: "BACKEND-XY",
            title: "Another Issue",
            status: "unresolved",
            platform: "python",
            type: "error",
            count: "1",
            userCount: 1,
            // Path-style permalink (sentry.io/organizations/{org}/issues/{id}/)
            permalink:
              "https://sentry.io/organizations/acme-corp/issues/55555555/",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const result = await resolveOrgAndIssueId({
      issueArg: "55555555",
      cwd: getConfigDir(),
      command: "explain",
    });
    expect(result.org).toBe("acme-corp");
    expect(result.issueId).toBe("55555555");
  });

  test("resolves explicit org prefix (org/ISSUE-ID)", async () => {
    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      if (url.includes("organizations/my-org/shortids/PROJECT-ABC")) {
        return new Response(
          JSON.stringify({
            organizationSlug: "my-org",
            projectSlug: "project",
            groupId: "987654321",
            group: {
              id: "987654321",
              shortId: "PROJECT-ABC",
              title: "Test Issue",
              status: "unresolved",
              platform: "javascript",
              type: "error",
              count: "10",
              userCount: 5,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const result = await resolveOrgAndIssueId({
      issueArg: "my-org/PROJECT-ABC",
      cwd: getConfigDir(),
      command: "explain",
    });

    expect(result.org).toBe("my-org");
    expect(result.issueId).toBe("987654321");
  });

  test("resolves alias-suffix format (e.g., 'f-g') using cached aliases", async () => {
    // Empty fingerprint matches detectAllDsns on empty dir
    const { setProjectAliases } = await import(
      "../../../src/lib/db/project-aliases.js"
    );
    setProjectAliases(
      {
        f: { orgSlug: "cached-org", projectSlug: "frontend" },
        b: { orgSlug: "cached-org", projectSlug: "backend" },
      },
      ""
    );

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      if (url.includes("organizations/cached-org/shortids/FRONTEND-G")) {
        return new Response(
          JSON.stringify({
            organizationSlug: "cached-org",
            projectSlug: "frontend",
            groupId: "111222333",
            group: {
              id: "111222333",
              shortId: "FRONTEND-G",
              title: "Test Issue from alias",
              status: "unresolved",
              platform: "javascript",
              type: "error",
              count: "5",
              userCount: 2,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const result = await resolveOrgAndIssueId({
      issueArg: "f-g",
      cwd: getConfigDir(),
      command: "explain",
    });

    expect(result.org).toBe("cached-org");
    expect(result.issueId).toBe("111222333");
  });

  test("resolves explicit org prefix with project-suffix (e.g., 'org1/dashboard-4y')", async () => {
    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      // With explicit org, we try project-suffix format: dashboard-4y -> DASHBOARD-4Y
      if (url.includes("organizations/org1/shortids/DASHBOARD-4Y")) {
        return new Response(
          JSON.stringify({
            organizationSlug: "org1",
            projectSlug: "dashboard",
            groupId: "999888777",
            group: {
              id: "999888777",
              shortId: "DASHBOARD-4Y",
              title: "Test Issue with explicit org",
              status: "unresolved",
              platform: "javascript",
              type: "error",
              count: "1",
              userCount: 1,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const result = await resolveOrgAndIssueId({
      issueArg: "org1/dashboard-4y",
      cwd: getConfigDir(),
      command: "explain",
    });

    expect(result.org).toBe("org1");
    expect(result.issueId).toBe("999888777");
  });

  test("resolves short suffix format (e.g., 'G') using project context from defaults", async () => {
    const { setDefaultOrganization, setDefaultProject } = await import(
      "../../../src/lib/db/defaults.js"
    );
    setDefaultOrganization("my-org");
    setDefaultProject("my-project");

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      if (url.includes("organizations/my-org/shortids/MY-PROJECT-G")) {
        return new Response(
          JSON.stringify({
            organizationSlug: "my-org",
            projectSlug: "my-project",
            groupId: "444555666",
            group: {
              id: "444555666",
              shortId: "MY-PROJECT-G",
              title: "Test Issue from short suffix",
              status: "unresolved",
              platform: "python",
              type: "error",
              count: "3",
              userCount: 1,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const result = await resolveOrgAndIssueId({
      issueArg: "G",
      cwd: getConfigDir(),
      command: "explain",
    });

    expect(result.org).toBe("my-org");
    expect(result.issueId).toBe("444555666");
  });

  test("throws ResolutionError for short suffix without project context", async () => {
    // Clear any defaults to ensure no project context
    const { clearAuth } = await import("../../../src/lib/db/auth.js");
    await clearAuth();

    await expect(
      resolveOrgAndIssueId({
        issueArg: "G",
        cwd: getConfigDir(),
        command: "explain",
      })
    ).rejects.toThrow("could not be resolved");
  });

  test("searches projects across orgs for project-suffix format", async () => {
    const { clearProjectAliases } = await import(
      "../../../src/lib/db/project-aliases.js"
    );
    clearProjectAliases();

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      // getUserRegions - return empty regions to use fallback path
      if (url.includes("/users/me/regions/")) {
        return new Response(JSON.stringify({ regions: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // listOrganizations call
      if (
        url.includes("/organizations/") &&
        !url.includes("/projects/") &&
        !url.includes("/issues/") &&
        !url.includes("/shortids/")
      ) {
        return new Response(
          JSON.stringify([{ id: "1", slug: "my-org", name: "My Org" }]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // getProject for my-org/craft - found
      if (url.includes("/projects/my-org/craft/")) {
        return new Response(
          JSON.stringify({
            id: "123",
            slug: "craft",
            name: "Craft",
            platform: "javascript",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      if (url.includes("organizations/my-org/shortids/CRAFT-G")) {
        return new Response(
          JSON.stringify({
            organizationSlug: "my-org",
            projectSlug: "craft",
            groupId: "777888999",
            group: {
              id: "777888999",
              shortId: "CRAFT-G",
              title: "Test Issue fallback",
              status: "unresolved",
              platform: "javascript",
              type: "error",
              count: "1",
              userCount: 1,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const result = await resolveOrgAndIssueId({
      issueArg: "craft-g",
      cwd: getConfigDir(),
      command: "explain",
    });

    expect(result.org).toBe("my-org");
    expect(result.issueId).toBe("777888999");
  });

  test("throws when project not found in any org", async () => {
    const { clearProjectAliases } = await import(
      "../../../src/lib/db/project-aliases.js"
    );
    clearProjectAliases();

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      // getUserRegions - return empty regions to use fallback path
      if (url.includes("/users/me/regions/")) {
        return new Response(JSON.stringify({ regions: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // listOrganizations call
      if (
        url.includes("/organizations/") &&
        !url.includes("/projects/") &&
        !url.includes("/issues/") &&
        !url.includes("/shortids/")
      ) {
        return new Response(
          JSON.stringify([{ id: "1", slug: "my-org", name: "My Org" }]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // getProject (single project detail) — "nonexistent" doesn't exist
      // URL pattern: /projects/{org}/{project}/
      if (url.match(/\/projects\/[^/]+\/[^/]+/)) {
        return new Response(JSON.stringify({ detail: "Not found" }), {
          status: 404,
        });
      }

      // listProjects — return projects that don't match "nonexistent"
      // URL pattern: /organizations/{org}/projects/
      if (url.includes("/projects/")) {
        return new Response(
          JSON.stringify([
            {
              id: "123",
              slug: "other-project",
              name: "Other",
              platform: "python",
            },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    await expect(
      resolveOrgAndIssueId({
        issueArg: "nonexistent-g",
        cwd: getConfigDir(),
        command: "explain",
      })
    ).rejects.toThrow("Issue 'NONEXISTENT-G'");
  });

  test("throws when project found in multiple orgs without explicit org", async () => {
    const { clearProjectAliases } = await import(
      "../../../src/lib/db/project-aliases.js"
    );
    clearProjectAliases();

    setOrgRegion("org2", DEFAULT_SENTRY_URL);

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      // getUserRegions - return empty regions to use fallback path
      if (url.includes("/users/me/regions/")) {
        return new Response(JSON.stringify({ regions: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // listOrganizations call
      if (
        url.includes("/organizations/") &&
        !url.includes("/projects/") &&
        !url.includes("/issues/") &&
        !url.includes("/shortids/")
      ) {
        return new Response(
          JSON.stringify([
            { id: "1", slug: "org1", name: "Org 1" },
            { id: "2", slug: "org2", name: "Org 2" },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // getProject for org1/common - found
      if (url.includes("/projects/org1/common/")) {
        return new Response(
          JSON.stringify({
            id: "123",
            slug: "common",
            name: "Common",
            platform: "javascript",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // getProject for org2/common - also found
      if (url.includes("/projects/org2/common/")) {
        return new Response(
          JSON.stringify({
            id: "456",
            slug: "common",
            name: "Common",
            platform: "python",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    await expect(
      resolveOrgAndIssueId({
        issueArg: "common-g",
        cwd: getConfigDir(),
        command: "explain",
      })
    ).rejects.toThrow("is ambiguous");
  });

  test("short suffix auth error (401) propagates", async () => {
    const { setDefaultOrganization, setDefaultProject } = await import(
      "../../../src/lib/db/defaults.js"
    );
    setDefaultOrganization("my-org");
    setDefaultProject("my-project");

    // @ts-expect-error - partial mock
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: "Unauthorized" }), {
        status: 401,
      });

    // Auth errors should propagate
    await expect(
      resolveOrgAndIssueId({
        issueArg: "G",
        cwd: getConfigDir(),
        command: "explain",
      })
    ).rejects.toThrow();
  });

  test("short suffix server error (500) propagates", async () => {
    const { setDefaultOrganization, setDefaultProject } = await import(
      "../../../src/lib/db/defaults.js"
    );
    setDefaultOrganization("my-org");
    setDefaultProject("my-project");

    // @ts-expect-error - partial mock
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: "Internal Server Error" }), {
        status: 500,
      });

    // Server errors should propagate
    await expect(
      resolveOrgAndIssueId({
        issueArg: "G",
        cwd: getConfigDir(),
        command: "explain",
      })
    ).rejects.toThrow("500");
  });

  test("fast path: ambiguous when shortid resolves in multiple orgs", async () => {
    const { clearProjectAliases } = await import(
      "../../../src/lib/db/project-aliases.js"
    );
    clearProjectAliases();

    setOrgRegion("org2", DEFAULT_SENTRY_URL);

    const makeShortIdResponse = (orgSlug: string, groupId: string) =>
      new Response(
        JSON.stringify({
          organizationSlug: orgSlug,
          projectSlug: "shared",
          groupId,
          group: {
            id: groupId,
            shortId: "SHARED-G",
            title: "Test Issue",
            status: "unresolved",
            platform: "javascript",
            type: "error",
            count: "1",
            userCount: 1,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      if (url.includes("/users/me/regions/")) {
        return new Response(JSON.stringify({ regions: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        url.includes("/organizations/") &&
        !url.includes("/projects/") &&
        !url.includes("/issues/") &&
        !url.includes("/shortids/")
      ) {
        return new Response(
          JSON.stringify([
            { id: "1", slug: "org1", name: "Org 1" },
            { id: "2", slug: "org2", name: "Org 2" },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Both orgs resolve the shortid — triggers fast-path ambiguity
      if (url.includes("organizations/org1/shortids/SHARED-G")) {
        return makeShortIdResponse("org1", "111");
      }
      if (url.includes("organizations/org2/shortids/SHARED-G")) {
        return makeShortIdResponse("org2", "222");
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    await expect(
      resolveOrgAndIssueId({
        issueArg: "shared-g",
        cwd: getConfigDir(),
        command: "explain",
      })
    ).rejects.toThrow("is ambiguous");
  });

  test("fast path: surfaces 403 when all orgs return forbidden", async () => {
    const { clearProjectAliases } = await import(
      "../../../src/lib/db/project-aliases.js"
    );
    clearProjectAliases();

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      if (url.includes("/users/me/regions/")) {
        return new Response(JSON.stringify({ regions: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        url.includes("/organizations/") &&
        !url.includes("/projects/") &&
        !url.includes("/issues/") &&
        !url.includes("/shortids/")
      ) {
        return new Response(
          JSON.stringify([{ id: "1", slug: "my-org", name: "My Org" }]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Shortid endpoint returns 403 for all orgs
      if (url.includes("/shortids/")) {
        return new Response(
          JSON.stringify({ detail: "You do not have permission" }),
          { status: 403 }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const err = await resolveOrgAndIssueId({
      issueArg: "restricted-g",
      cwd: getConfigDir(),
      command: "explain",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });

  test("fast path: surfaces 500 when all orgs return server error", async () => {
    const { clearProjectAliases } = await import(
      "../../../src/lib/db/project-aliases.js"
    );
    clearProjectAliases();

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      if (url.includes("/users/me/regions/")) {
        return new Response(JSON.stringify({ regions: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        url.includes("/organizations/") &&
        !url.includes("/projects/") &&
        !url.includes("/issues/") &&
        !url.includes("/shortids/")
      ) {
        return new Response(
          JSON.stringify([{ id: "1", slug: "my-org", name: "My Org" }]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Shortid endpoint returns 500 for all orgs
      if (url.includes("/shortids/")) {
        return new Response(
          JSON.stringify({ detail: "Internal Server Error" }),
          { status: 500 }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const err = await resolveOrgAndIssueId({
      issueArg: "broken-g",
      cwd: getConfigDir(),
      command: "explain",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });
});

describe("resolveOrgAndIssueId: issue-id → org cache (Pattern D)", () => {
  test("uses cached org on warm cache (single org-scoped call)", async () => {
    const { setCachedIssueOrg, getCachedIssueOrg } = await import(
      "../../../src/lib/db/issue-org-cache.js"
    );
    setCachedIssueOrg("77777777", "cached-org");

    // Track which endpoint is hit — must be org-scoped, not legacy unscoped.
    const calls: string[] = [];
    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      calls.push(req.url);
      if (req.url.includes("/organizations/cached-org/issues/77777777/")) {
        return new Response(
          JSON.stringify({
            id: "77777777",
            shortId: "CACHED-1",
            permalink:
              "https://sentry.io/organizations/cached-org/issues/77777777/",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const result = await resolveOrgAndIssueId({
      issueArg: "77777777",
      cwd: getConfigDir(),
      command: "view",
    });

    expect(result.org).toBe("cached-org");
    // Should NOT have hit the legacy unscoped /api/0/issues/{id}/ endpoint.
    expect(calls.some((u) => /\/api\/0\/issues\/77777777\//.test(u))).toBe(
      false
    );
    // The org-scoped endpoint is what got called.
    expect(
      calls.some((u) =>
        u.includes("/organizations/cached-org/issues/77777777/")
      )
    ).toBe(true);
    // Cache stays populated (it was a valid hit).
    expect(getCachedIssueOrg("77777777")).toBe("cached-org");
  });

  test("evicts stale cache entry on 404 and uses permalink org (does not leak stale slug)", async () => {
    const { setCachedIssueOrg, getCachedIssueOrg } = await import(
      "../../../src/lib/db/issue-org-cache.js"
    );
    // Seed a stale mapping that will 404 on the org-scoped endpoint.
    setCachedIssueOrg("88888888", "stale-org");
    setOrgRegion("stale-org", DEFAULT_SENTRY_URL);
    setOrgRegion("correct-org", DEFAULT_SENTRY_URL);

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;
      // Org-scoped call with the stale org → 404.
      if (url.includes("/organizations/stale-org/issues/88888888/")) {
        return new Response(JSON.stringify({ detail: "Not found" }), {
          status: 404,
        });
      }
      // Legacy unscoped fallback returns the correct org via permalink.
      if (/\/api\/0\/issues\/88888888\/(\?|$)/.test(url)) {
        return new Response(
          JSON.stringify({
            id: "88888888",
            shortId: "CORRECT-1",
            permalink:
              "https://sentry.io/organizations/correct-org/issues/88888888/",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const result = await resolveOrgAndIssueId({
      issueArg: "88888888",
      cwd: getConfigDir(),
      command: "view",
    });

    // Critical assertion: the returned org is the CORRECT one from the
    // permalink, NOT the stale cached slug.
    expect(result.org).toBe("correct-org");
    expect(result.org).not.toBe("stale-org");
    // The stale cache entry should have been evicted and replaced with
    // the corrected mapping from the permalink.
    expect(getCachedIssueOrg("88888888")).toBe("correct-org");
  });

  test("writes numeric-id → org mapping after legacy unscoped fallback", async () => {
    const { getCachedIssueOrg } = await import(
      "../../../src/lib/db/issue-org-cache.js"
    );
    setOrgRegion("fresh-org", DEFAULT_SENTRY_URL);

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      // Match /api/0/issues/99999999/ regardless of query string (?collapse=...).
      if (/\/api\/0\/issues\/99999999\/(\?|$)/.test(req.url)) {
        return new Response(
          JSON.stringify({
            id: "99999999",
            shortId: "FRESH-1",
            permalink:
              "https://sentry.io/organizations/fresh-org/issues/99999999/",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    expect(getCachedIssueOrg("99999999")).toBeUndefined();
    const result = await resolveOrgAndIssueId({
      issueArg: "99999999",
      cwd: getConfigDir(),
      command: "view",
    });

    expect(result.org).toBe("fresh-org");
    // Mapping should now be cached for next time.
    expect(getCachedIssueOrg("99999999")).toBe("fresh-org");
  });

  test("5xx on cached-org fetch propagates the error WITHOUT evicting the cache", async () => {
    const { setCachedIssueOrg, getCachedIssueOrg } = await import(
      "../../../src/lib/db/issue-org-cache.js"
    );
    // Seed a valid mapping — the org-scoped endpoint will return 500 (transient).
    setCachedIssueOrg("66666666", "still-valid-org");
    setOrgRegion("still-valid-org", DEFAULT_SENTRY_URL);

    let legacyFallbackCalled = false;
    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;
      if (url.includes("/organizations/still-valid-org/issues/66666666/")) {
        return new Response(JSON.stringify({ detail: "Internal error" }), {
          status: 500,
        });
      }
      if (/\/api\/0\/issues\/66666666\/(\?|$)/.test(url)) {
        legacyFallbackCalled = true;
        return new Response(
          JSON.stringify({
            id: "66666666",
            permalink:
              "https://sentry.io/organizations/still-valid-org/issues/66666666/",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    // Error must propagate — the helper only falls back on 404, not on 5xx.
    await expect(
      resolveOrgAndIssueId({
        issueArg: "66666666",
        cwd: getConfigDir(),
        command: "view",
      })
    ).rejects.toThrow(ApiError);

    // Cache must NOT have been evicted — the failure was transient, the
    // mapping may still be correct.
    expect(getCachedIssueOrg("66666666")).toBe("still-valid-org");
    // Legacy fallback must NOT have been reached.
    expect(legacyFallbackCalled).toBe(false);
  });
});

describe("pollAutofixState", () => {
  test("returns immediately when state is COMPLETED", async () => {
    let fetchCount = 0;

    // @ts-expect-error - partial mock
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({
          autofix: {
            run_id: 12_345,
            status: "COMPLETED",
            steps: [],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    };

    const result = await pollAutofixState({
      orgSlug: "test-org",
      issueId: "123456789",

      json: true,
    });

    expect(result.status).toBe("COMPLETED");
    expect(fetchCount).toBe(1);
  });

  test("returns immediately when state is ERROR", async () => {
    // @ts-expect-error - partial mock
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          autofix: {
            run_id: 12_345,
            status: "ERROR",
            steps: [],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );

    const result = await pollAutofixState({
      orgSlug: "test-org",
      issueId: "123456789",

      json: true,
    });

    expect(result.status).toBe("ERROR");
  });

  test("stops at WAITING_FOR_USER_RESPONSE when stopOnWaitingForUser is true", async () => {
    // @ts-expect-error - partial mock
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          autofix: {
            run_id: 12_345,
            status: "WAITING_FOR_USER_RESPONSE",
            steps: [],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );

    const result = await pollAutofixState({
      orgSlug: "test-org",
      issueId: "123456789",

      json: true,
      stopOnWaitingForUser: true,
    });

    expect(result.status).toBe("WAITING_FOR_USER_RESPONSE");
  });

  test("continues polling when PROCESSING", async () => {
    let fetchCount = 0;

    // @ts-expect-error - partial mock
    globalThis.fetch = async () => {
      fetchCount += 1;

      // Return PROCESSING for first call, COMPLETED for second
      if (fetchCount === 1) {
        return new Response(
          JSON.stringify({
            autofix: {
              run_id: 12_345,
              status: "PROCESSING",
              steps: [],
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(
        JSON.stringify({
          autofix: {
            run_id: 12_345,
            status: "COMPLETED",
            steps: [],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    };

    const result = await pollAutofixState({
      orgSlug: "test-org",
      issueId: "123456789",

      json: true,
      pollIntervalMs: 10, // Short interval for test
    });

    expect(result.status).toBe("COMPLETED");
    expect(fetchCount).toBe(2);
  });

  test("writes progress to stdout when not in JSON mode", async () => {
    let stdoutOutput = "";
    let fetchCount = 0;

    // Force rich output so the spinner isn't suppressed in non-TTY test env
    const origPlain = process.env.SENTRY_PLAIN_OUTPUT;
    process.env.SENTRY_PLAIN_OUTPUT = "0";

    // Spy on process.stdout.write to capture spinner output
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutOutput += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      // Return PROCESSING first to allow animation interval to fire,
      // then COMPLETED on second call
      // @ts-expect-error - partial mock
      globalThis.fetch = async () => {
        fetchCount += 1;

        if (fetchCount === 1) {
          return new Response(
            JSON.stringify({
              autofix: {
                run_id: 12_345,
                status: "PROCESSING",
                steps: [
                  {
                    id: "step-1",
                    key: "analysis",
                    status: "PROCESSING",
                    title: "Analysis",
                    progress: [
                      {
                        message: "Analyzing...",
                        timestamp: "2025-01-01T00:00:00Z",
                      },
                    ],
                  },
                ],
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        return new Response(
          JSON.stringify({
            autofix: {
              run_id: 12_345,
              status: "COMPLETED",
              steps: [],
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      };

      await pollAutofixState({
        orgSlug: "test-org",
        issueId: "123456789",
        json: false,
        pollIntervalMs: 100, // Allow animation interval (80ms) to fire
      });

      expect(stdoutOutput).toContain("Analyzing");
    } finally {
      process.stdout.write = origWrite;
      if (origPlain === undefined) {
        delete process.env.SENTRY_PLAIN_OUTPUT;
      } else {
        process.env.SENTRY_PLAIN_OUTPUT = origPlain;
      }
    }
  });

  test("throws timeout error when exceeding timeoutMs", async () => {
    // @ts-expect-error - partial mock
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          autofix: {
            run_id: 12_345,
            status: "PROCESSING",
            steps: [],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );

    await expect(
      pollAutofixState({
        orgSlug: "test-org",
        issueId: "123456789",

        json: true,
        timeoutMs: 50,
        pollIntervalMs: 20,
        timeoutMessage: "Custom timeout message",
      })
    ).rejects.toThrow("Custom timeout message");
  });

  test("continues polling when autofix is null", async () => {
    let fetchCount = 0;

    // @ts-expect-error - partial mock
    globalThis.fetch = async () => {
      fetchCount += 1;

      // Return null for first call, state for second
      if (fetchCount === 1) {
        return new Response(JSON.stringify({ autofix: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(
        JSON.stringify({
          autofix: {
            run_id: 12_345,
            status: "COMPLETED",
            steps: [],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    };

    const result = await pollAutofixState({
      orgSlug: "test-org",
      issueId: "123456789",

      json: true,
      pollIntervalMs: 10,
    });

    expect(result.status).toBe("COMPLETED");
    expect(fetchCount).toBe(2);
  });
});

describe("ensureRootCauseAnalysis", () => {
  test("returns immediately when state is COMPLETED", async () => {
    let fetchCount = 0;

    // @ts-expect-error - partial mock
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({
          autofix: {
            run_id: 12_345,
            status: "COMPLETED",
            steps: [],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    };

    const result = await ensureRootCauseAnalysis({
      org: "test-org",
      issueId: "123456789",

      json: true,
    });

    expect(result.status).toBe("COMPLETED");
    expect(fetchCount).toBe(1); // Only one fetch to check state
  });

  test("returns immediately when state is WAITING_FOR_USER_RESPONSE", async () => {
    let fetchCount = 0;

    // @ts-expect-error - partial mock
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({
          autofix: {
            run_id: 12_345,
            status: "WAITING_FOR_USER_RESPONSE",
            steps: [],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    };

    const result = await ensureRootCauseAnalysis({
      org: "test-org",
      issueId: "123456789",

      json: true,
    });

    expect(result.status).toBe("WAITING_FOR_USER_RESPONSE");
    expect(fetchCount).toBe(1);
  });

  test("triggers new analysis when no state exists", async () => {
    let triggerCalled = false;

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      // First call: getAutofixState returns null
      if (url.includes("/autofix/") && req.method === "GET") {
        // After trigger, return COMPLETED
        if (triggerCalled) {
          return new Response(
            JSON.stringify({
              autofix: {
                run_id: 12_345,
                status: "COMPLETED",
                steps: [],
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
        // Before trigger, return null
        return new Response(JSON.stringify({ autofix: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Trigger RCA endpoint
      if (url.includes("/autofix/") && req.method === "POST") {
        triggerCalled = true;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const result = await ensureRootCauseAnalysis({
      org: "test-org",
      issueId: "123456789",

      json: true,
    });

    expect(result.status).toBe("COMPLETED");
    expect(triggerCalled).toBe(true);
  });

  test("retries when existing analysis has ERROR status", async () => {
    let triggerCalled = false;

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      // getAutofixState
      if (url.includes("/autofix/") && req.method === "GET") {
        // First call returns ERROR, subsequent calls return COMPLETED
        if (!triggerCalled) {
          return new Response(
            JSON.stringify({
              autofix: {
                run_id: 12_345,
                status: "ERROR",
                steps: [],
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
        return new Response(
          JSON.stringify({
            autofix: {
              run_id: 12_346,
              status: "COMPLETED",
              steps: [],
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Trigger RCA endpoint
      if (url.includes("/autofix/") && req.method === "POST") {
        triggerCalled = true;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const result = await ensureRootCauseAnalysis({
      org: "test-org",
      issueId: "123456789",

      json: true,
    });

    expect(result.status).toBe("COMPLETED");
    expect(triggerCalled).toBe(true); // Should have retried
  });

  test("polls until complete when state is PROCESSING", async () => {
    let fetchCount = 0;

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);

      if (req.method === "GET") {
        fetchCount += 1;

        // First call returns PROCESSING, second returns COMPLETED
        if (fetchCount === 1) {
          return new Response(
            JSON.stringify({
              autofix: {
                run_id: 12_345,
                status: "PROCESSING",
                steps: [],
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        return new Response(
          JSON.stringify({
            autofix: {
              run_id: 12_345,
              status: "COMPLETED",
              steps: [],
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const result = await ensureRootCauseAnalysis({
      org: "test-org",
      issueId: "123456789",

      json: true,
    });

    expect(result.status).toBe("COMPLETED");
    expect(fetchCount).toBeGreaterThan(1); // Polled multiple times
  });

  test("forces new analysis when force flag is true", async () => {
    let triggerCalled = false;

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      // getAutofixState - would return COMPLETED, but force should skip this
      if (url.includes("/autofix/") && req.method === "GET") {
        // After trigger, return new COMPLETED state
        return new Response(
          JSON.stringify({
            autofix: {
              run_id: triggerCalled ? 99_999 : 12_345,
              status: "COMPLETED",
              steps: [],
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Trigger RCA endpoint
      if (url.includes("/autofix/") && req.method === "POST") {
        triggerCalled = true;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const result = await ensureRootCauseAnalysis({
      org: "test-org",
      issueId: "123456789",

      json: true,
      force: true,
    });

    expect(result.status).toBe("COMPLETED");
    expect(triggerCalled).toBe(true); // Should trigger even though state exists
  });

  test("writes progress messages to stdout when not in JSON mode", async () => {
    let stdoutOutput = "";
    let triggerCalled = false;

    // Force rich output so the spinner isn't suppressed in non-TTY test env
    const origPlain = process.env.SENTRY_PLAIN_OUTPUT;
    process.env.SENTRY_PLAIN_OUTPUT = "0";

    // Spy on process.stdout.write to capture spinner output
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutOutput += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      // @ts-expect-error - partial mock
      globalThis.fetch = async (
        input: RequestInfo | URL,
        init?: RequestInit
      ) => {
        const req = new Request(input, init);
        const url = req.url;

        if (url.includes("/autofix/") && req.method === "GET") {
          if (triggerCalled) {
            return new Response(
              JSON.stringify({
                autofix: {
                  run_id: 12_345,
                  status: "COMPLETED",
                  steps: [],
                },
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }
            );
          }
          return new Response(JSON.stringify({ autofix: null }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.includes("/autofix/") && req.method === "POST") {
          triggerCalled = true;
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ detail: "Not found" }), {
          status: 404,
        });
      };

      await ensureRootCauseAnalysis({
        org: "test-org",
        issueId: "123456789",
        json: false, // Not JSON mode, should output progress
      });

      // The poll spinner writes to stdout — check for the spinner's initial message
      expect(stdoutOutput).toContain("Waiting for analysis");
    } finally {
      process.stdout.write = origWrite;
      if (origPlain === undefined) {
        delete process.env.SENTRY_PLAIN_OUTPUT;
      } else {
        process.env.SENTRY_PLAIN_OUTPUT = origPlain;
      }
    }
  });
});

describe("resolveOrgAndIssueId: magic @ selectors", () => {
  test("resolves @latest to the most recent unresolved issue", async () => {
    const { setDefaultOrganization } = await import(
      "../../../src/lib/db/defaults.js"
    );
    setDefaultOrganization("test-org");

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      // listIssuesPaginated: /organizations/test-org/issues/?query=is:unresolved&sort=date&limit=1
      if (
        url.includes("/organizations/test-org/issues/") &&
        url.includes("sort=date")
      ) {
        return new Response(
          JSON.stringify([
            {
              id: "111222333",
              shortId: "CLI-G",
              title: "Latest issue",
              status: "unresolved",
              platform: "javascript",
              type: "error",
              count: "5",
              userCount: 2,
            },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const result = await resolveOrgAndIssueId({
      issueArg: "@latest",
      cwd: getConfigDir(),
      command: "view",
    });

    expect(result.org).toBe("test-org");
    expect(result.issueId).toBe("111222333");
  });

  test("resolves @most_frequent to the highest frequency issue", async () => {
    const { setDefaultOrganization } = await import(
      "../../../src/lib/db/defaults.js"
    );
    setDefaultOrganization("test-org");

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      // listIssuesPaginated: sort=freq
      if (
        url.includes("/organizations/test-org/issues/") &&
        url.includes("sort=freq")
      ) {
        return new Response(
          JSON.stringify([
            {
              id: "444555666",
              shortId: "CLI-H",
              title: "Frequent issue",
              status: "unresolved",
              platform: "python",
              type: "error",
              count: "1000",
              userCount: 50,
            },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const result = await resolveOrgAndIssueId({
      issueArg: "@most_frequent",
      cwd: getConfigDir(),
      command: "view",
    });

    expect(result.org).toBe("test-org");
    expect(result.issueId).toBe("444555666");
  });

  test("resolves org/@latest with explicit org prefix", async () => {
    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      if (
        url.includes("/organizations/my-org/issues/") &&
        url.includes("sort=date")
      ) {
        return new Response(
          JSON.stringify([
            {
              id: "777888999",
              shortId: "BACKEND-Z",
              title: "Latest in my-org",
              status: "unresolved",
              platform: "python",
              type: "error",
              count: "3",
              userCount: 1,
            },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const result = await resolveOrgAndIssueId({
      issueArg: "my-org/@latest",
      cwd: getConfigDir(),
      command: "view",
    });

    expect(result.org).toBe("my-org");
    expect(result.issueId).toBe("777888999");
  });

  test("throws ResolutionError when no unresolved issues found", async () => {
    const { setDefaultOrganization } = await import(
      "../../../src/lib/db/defaults.js"
    );
    setDefaultOrganization("test-org");

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;

      // Return empty list — no unresolved issues
      if (url.includes("/organizations/test-org/issues/")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    const err = await resolveOrgAndIssueId({
      issueArg: "@latest",
      cwd: getConfigDir(),
      command: "view",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ResolutionError);
    expect(String(err)).toContain("no unresolved issues found");
    expect(String(err)).toContain("most recent");
    expect(String(err)).toContain("sentry issue list");
    expect(String(err)).toContain('-q "is:resolved"');

    const eventError = await resolveIssue({
      issueArg: "@latest",
      cwd: getConfigDir(),
      command: "list",
      commandBase: "sentry event",
    }).catch((error) => error);
    expect(eventError).toBeInstanceOf(ResolutionError);
    expect(eventError.hint).toBe(
      'sentry issue list test-org/ -q "is:resolved"'
    );
  });

  test("throws ContextError when org cannot be resolved for bare @selector", async () => {
    // Clear defaults so there's no org context
    const { clearAuth } = await import("../../../src/lib/db/auth.js");
    await clearAuth();

    await expect(
      resolveOrgAndIssueId({
        issueArg: "@latest",
        cwd: getConfigDir(),
        command: "view",
      })
    ).rejects.toThrow("organization");
  });
});

describe("resolveIssue: numeric 404 error handling", () => {
  const getResolveIssueConfigDir = useTestConfigDir("test-resolve-issue-", {
    isolateProjectRoot: true,
  });

  let savedFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    savedFetch = globalThis.fetch;
    await setAuthToken("test-token");
    setOrgRegion("my-org", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  test("numeric 404 throws ResolutionError with ID and short-ID hint", async () => {
    // @ts-expect-error - partial mock
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: "Issue not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });

    const err = await resolveIssue({
      issueArg: "123456789",
      cwd: getResolveIssueConfigDir(),
      command: "view",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ResolutionError);
    // Message includes the numeric ID
    expect(String(err)).toContain("123456789");
    // Message says "not found", not "is required"
    expect(String(err)).toContain("not found");
    // Suggests the short-ID format
    expect(String(err)).toContain("project>-123456789");
  });

  test("numeric non-404 error propagates unchanged", async () => {
    // @ts-expect-error - partial mock
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: "Internal Server Error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });

    await expect(
      resolveIssue({
        issueArg: "123456789",
        cwd: getResolveIssueConfigDir(),
        command: "view",
      })
    ).rejects.not.toBeInstanceOf(ResolutionError);
  });

  test("explicit-org-numeric 404 throws ResolutionError with org and ID", async () => {
    // @ts-expect-error - partial mock
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: "Issue not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });

    const err = await resolveIssue({
      issueArg: "my-org/999999999",
      cwd: getResolveIssueConfigDir(),
      command: "view",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ResolutionError);
    // Message includes the numeric ID
    expect(String(err)).toContain("999999999");
    // Message mentions the org
    expect(String(err)).toContain("my-org");
    // Message says "not found", not "is required"
    expect(String(err)).toContain("not found");
    // Suggests the short-ID format
    expect(String(err)).toContain("project>-999999999");
  });

  test("explicit-org-numeric non-404 error propagates unchanged", async () => {
    // @ts-expect-error - partial mock
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });

    await expect(
      resolveIssue({
        issueArg: "my-org/999999999",
        cwd: getResolveIssueConfigDir(),
        command: "view",
      })
    ).rejects.not.toBeInstanceOf(ResolutionError);
  });
});

describe("resolveIssue: project-search DSN shortcut", () => {
  const getDsnTestConfigDir = useTestConfigDir("test-dsn-shortcut-", {
    isolateProjectRoot: true,
  });

  let dsnOriginalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    dsnOriginalFetch = globalThis.fetch;
    await setAuthToken("test-token");
    setOrgRegion("my-org", DEFAULT_SENTRY_URL);
    // Seed project cache so resolveFromDsn resolves without any API call.
    // orgId is "123" (DSN parser strips the "o" prefix from o123.ingest.*)
    setCachedProject("123", "456", {
      orgSlug: "my-org",
      orgName: "My Org",
      projectSlug: "my-project",
      projectName: "My Project",
      projectId: "456",
    });
  });

  afterEach(() => {
    globalThis.fetch = dsnOriginalFetch;
  });

  test("uses DSN shortcut when project matches, skips listOrganizations", async () => {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const cwd = getDsnTestConfigDir();

    // Write a DSN so detectDsn finds it
    writeFileSync(
      join(cwd, ".env"),
      "SENTRY_DSN=https://abc@o123.ingest.us.sentry.io/456"
    );

    const requests: string[] = [];

    // @ts-expect-error - partial mock
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;
      requests.push(url);

      // Short ID resolution — the only HTTP call the shortcut should make
      if (url.includes("/shortids/MY-PROJECT-5BS/")) {
        return new Response(
          JSON.stringify({
            organizationSlug: "my-org",
            projectSlug: "my-project",
            group: {
              id: "999",
              shortId: "MY-PROJECT-5BS",
              title: "Test Issue",
              status: "unresolved",
              platform: "javascript",
              type: "error",
              count: "1",
              userCount: 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await resolveIssue({
      issueArg: "my-project-5BS",
      cwd,
      command: "view",
    });

    // Shortcut resolved correctly
    expect(result.org).toBe("my-org");
    expect(result.issue.id).toBe("999");

    // The expensive listOrganizations calls were skipped
    expect(requests.some((r) => r.includes("/users/me/regions/"))).toBe(false);
    expect(
      requests.some(
        (r) => r.includes("/organizations/") && !r.includes("/shortids/")
      )
    ).toBe(false);
  });
});

describe("resolveIssue with share URLs", () => {
  useEnvSandbox([
    "SENTRY_AUTH_TOKEN",
    "SENTRY_TOKEN",
    "SENTRY_HOST",
    "SENTRY_URL",
    "SENTRY_ORG",
    "SENTRY_PROJECT",
    "SENTRY_DSN",
  ]);
  beforeEach(resetHostScopingState);
  afterEach(resetHostScopingState);

  const shareId = "aabbccdd11223344aabbccdd11223344";

  test.each([
    [
      "SaaS subdomain",
      "https://test-org.sentry.io",
      "test-org",
      `/share/issue/${shareId}/`,
    ],
    [
      "SaaS org path",
      "https://sentry.io",
      "test-org",
      `/organizations/test-org/share/issue/${shareId}/`,
    ],
    [
      "self-hosted org path",
      "https://sentry.example.com",
      "self-hosted-org",
      `/organizations/self-hosted-org/share/issue/${shareId}/`,
    ],
    [
      "legacy URL with default org",
      "https://sentry.io",
      "test-org",
      `/share/issue/${shareId}/`,
    ],
  ])("resolves %s using the shared issue id", async (name, baseUrl, org, path) => {
    const { setDefaultOrganization } = await import(
      "../../../src/lib/db/defaults.js"
    );
    setDefaultOrganization(
      name === "legacy URL with default org" ? org : "other-org"
    );
    const apiBaseUrl =
      baseUrl === "https://sentry.example.com" ? baseUrl : DEFAULT_SENTRY_URL;
    setAuthToken("test-token", undefined, undefined, { host: apiBaseUrl });
    setOrgRegion(org, apiBaseUrl);
    const requests: Request[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (
        request.url ===
        `${baseUrl}/api/0/organizations/${org}/shared/issues/${shareId}/`
      ) {
        return Response.json({
          id: "12345",
          title: "Shared issue",
          project: { slug: "backend" },
        });
      }
      if (
        new URL(request.url).pathname ===
        `/api/0/organizations/${org}/issues/12345/`
      ) {
        return Response.json({
          id: "12345",
          shortId: "BACKEND-A1",
          title: "Shared issue",
          status: "unresolved",
          platform: "python",
          type: "error",
          count: "5",
          userCount: 3,
        });
      }
      return Response.json({ detail: "Not found" }, { status: 404 });
    });

    const result = await resolveIssue({
      issueArg: `${baseUrl}${path}`,
      cwd: getConfigDir(),
      command: "view",
    });

    expect(result.org).toBe(org);
    expect(result.issue.id).toBe("12345");
    expect(result.issue.shortId).toBe("BACKEND-A1");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.has("Authorization")).toBe(false);
    expect(requests[1]?.headers.get("Authorization")).toBe("Bearer test-token");
  });

  test("requires organization context before requesting a legacy share URL", async () => {
    const requests: string[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push(new Request(input, init).url);
      return Response.json({ detail: "Not found" }, { status: 404 });
    });

    await expect(
      resolveIssue({
        issueArg: `https://sentry.io/share/issue/${shareId}/`,
        cwd: getConfigDir(),
        command: "view",
      })
    ).rejects.toBeInstanceOf(ContextError);
    expect(requests).toEqual([]);
  });

  test("reports an expired share link without fetching issue details", async () => {
    const requests: string[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push(new Request(input, init).url);
      return Response.json({ detail: "Not found" }, { status: 404 });
    });

    await expect(
      resolveIssue({
        issueArg: `https://test-org.sentry.io/share/issue/${shareId}/`,
        cwd: getConfigDir(),
        command: "view",
      })
    ).rejects.toMatchObject({
      name: "ApiError",
      message: "Share link not found or expired",
      status: 404,
    });
    expect(requests).toEqual([
      `https://test-org.sentry.io/api/0/organizations/test-org/shared/issues/${shareId}/`,
    ]);
  });
});
