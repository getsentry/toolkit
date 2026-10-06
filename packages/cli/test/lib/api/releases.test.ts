/**
 * Release API Function Tests
 *
 * Tests the real API function bodies by mocking globalThis.fetch.
 * This ensures the functions correctly call the SDK, pass parameters,
 * and transform responses.
 *
 * The `setCommitsAuto` tests additionally use `vi.mock()` to stub the
 * git helpers (`getRepositoryName`, etc.) because `setCommitsAuto` reads
 * them at runtime. `getRepositoryName` is a controllable `vi.fn()` so
 * individual tests can change its return value (e.g. null for the
 * "no git remote" path).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Controllable git-helper mocks. `setCommitsAuto` calls these at runtime to
// build the `refs` array sent to Sentry.
const { mockGetRepositoryName } = vi.hoisted(() => ({
  mockGetRepositoryName: vi.fn((): string | null => "getsentry/cli"),
}));

vi.mock("../../../src/lib/git.js", () => ({
  getRepositoryName: mockGetRepositoryName,
  getHeadCommit: () => "abc123def456789012345678901234567890abcd",
  isInsideGitWorkTree: () => true,
  isShallowRepository: () => false,
  getCommitLog: () => [],
  getUncommittedFiles: () => [],
  parseRemoteUrl: (url: string) => url,
}));

// Dynamic import: must run AFTER vi.mock() so setCommitsAuto picks up
// the mocked git helpers.
const {
  createRelease,
  createReleaseDeploy,
  deleteRelease,
  getRelease,
  listReleaseDeploys,
  listReleasesPaginated,
  setCommitsAuto,
  setCommitsLocal,
  updateRelease,
} = await import("../../../src/lib/api/releases.js");

import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { classifySilenced } from "../../../src/lib/error-reporting.js";
import { EXIT, isUserError } from "../../../src/lib/errors.js";
import type { SentryDeploy, SentryRelease } from "../../../src/types/index.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("api-releases-");

const SAMPLE_RELEASE: SentryRelease = {
  id: 1,
  version: "1.0.0",
  shortVersion: "1.0.0",
  status: "open",
  dateCreated: "2025-01-01T00:00:00Z",
  dateReleased: null,
  firstEvent: null,
  lastEvent: null,
  ref: null,
  url: null,
  commitCount: 0,
  deployCount: 0,
  newGroups: 0,
  authors: [],
  projects: [
    {
      id: 1,
      slug: "test-project",
      name: "Test Project",
      platform: "javascript",
      platforms: ["javascript"],
      hasHealthData: false,
      newGroups: 0,
    },
  ],
  data: {},
  versionInfo: null,
};

const SAMPLE_DEPLOY: SentryDeploy = {
  id: "42",
  environment: "production",
  dateStarted: null,
  dateFinished: "2025-01-01T12:00:00Z",
  name: null,
  url: null,
};

let originalFetch: typeof globalThis.fetch;

/** Create a Link header for pagination */
function linkHeader(cursor: string, hasResults: boolean): string {
  return `<https://us.sentry.io/api/0/next/>; rel="next"; results="${hasResults}"; cursor="${cursor}"`;
}

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  await setAuthToken("test-token");
  setOrgRegion("test-org", "https://us.sentry.io");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// =============================================================================
// getRelease
// =============================================================================

describe("getRelease", () => {
  test("fetches a release by version", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      expect(req.url).toContain("/releases/1.0.0/");
      return new Response(JSON.stringify(SAMPLE_RELEASE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const release = await getRelease("test-org", "1.0.0");

    expect(release.version).toBe("1.0.0");
    expect(release.shortVersion).toBe("1.0.0");
    expect(release.id).toBe(1);
  });
});

// =============================================================================
// createRelease
// =============================================================================

describe("createRelease", () => {
  test("creates a release with version and projects", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      expect(req.method).toBe("POST");
      const body = (await req.json()) as {
        version: string;
        projects: string[];
      };
      expect(body.version).toBe("1.0.0");
      expect(body.projects).toEqual(["test-project"]);
      return new Response(JSON.stringify(SAMPLE_RELEASE), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });

    const release = await createRelease("test-org", {
      version: "1.0.0",
      projects: ["test-project"],
    });

    expect(release.version).toBe("1.0.0");
    expect(release.projects).toHaveLength(1);
  });
});

// =============================================================================
// updateRelease
// =============================================================================

describe("updateRelease", () => {
  test("updates a release with dateReleased", async () => {
    const updated = { ...SAMPLE_RELEASE, dateReleased: "2025-06-15T00:00:00Z" };
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      expect(req.method).toBe("PUT");
      expect(req.url).toContain("/releases/1.0.0/");
      const body = (await req.json()) as { dateReleased: string };
      expect(body.dateReleased).toBe("2025-06-15T00:00:00Z");
      return new Response(JSON.stringify(updated), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const release = await updateRelease("test-org", "1.0.0", {
      dateReleased: "2025-06-15T00:00:00Z",
    });

    expect(release.dateReleased).toBe("2025-06-15T00:00:00Z");
  });
});

// =============================================================================
// deleteRelease
// =============================================================================

describe("deleteRelease", () => {
  test("deletes a release", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      expect(req.method).toBe("DELETE");
      expect(req.url).toContain("/releases/1.0.0/");
      return new Response(null, { status: 204 });
    });

    // Should not throw
    await deleteRelease("test-org", "1.0.0");
  });
});

// =============================================================================
// listReleaseDeploys
// =============================================================================

describe("listReleaseDeploys", () => {
  test("returns deploys for a release", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      expect(req.url).toContain("/releases/1.0.0/deploys/");
      return new Response(JSON.stringify([SAMPLE_DEPLOY]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const deploys = await listReleaseDeploys("test-org", "1.0.0");

    expect(deploys).toHaveLength(1);
    expect(deploys[0].environment).toBe("production");
    expect(deploys[0].id).toBe("42");
  });
});

// =============================================================================
// createReleaseDeploy
// =============================================================================

describe("createReleaseDeploy", () => {
  test("creates a deploy for a release", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      expect(req.method).toBe("POST");
      expect(req.url).toContain("/releases/1.0.0/deploys/");
      const body = (await req.json()) as { environment: string };
      expect(body.environment).toBe("production");
      return new Response(JSON.stringify(SAMPLE_DEPLOY), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });

    const deploy = await createReleaseDeploy("test-org", "1.0.0", {
      environment: "production",
    });

    expect(deploy.environment).toBe("production");
    expect(deploy.id).toBe("42");
  });
});

// =============================================================================
// setCommitsAuto
// =============================================================================

describe("setCommitsAuto", () => {
  const SAMPLE_REPO = {
    id: "1",
    name: "getsentry/cli",
    url: "https://github.com/getsentry/cli",
    provider: { id: "integrations:github", name: "GitHub" },
    status: "active",
  };

  beforeEach(() => {
    // Reset the git-helper mock to the default (cli repo). Individual tests
    // can override via mockGetRepositoryName.mockReturnValueOnce(null) or
    // mockReturnValue("...").
    mockGetRepositoryName.mockReturnValue("getsentry/cli");
  });

  test("lists repos, discovers HEAD, fetches previous commit, and sends refs", async () => {
    const withCommits = { ...SAMPLE_RELEASE, commitCount: 5 };
    const requests: { method: string; url: string }[] = [];

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      requests.push({ method: req.method, url: req.url });

      // List org repositories (SDK uses /repos/ endpoint)
      if (req.url.includes("/repos/")) {
        expect(req.method).toBe("GET");
        return new Response(JSON.stringify([SAMPLE_REPO]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Previous release commit lookup
      if (req.url.includes("/previous-with-commits/")) {
        expect(req.method).toBe("GET");
        return new Response(
          JSON.stringify({
            lastCommit: { id: "prev000000000000000000000000000000000000" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // PUT refs on the release
      expect(req.method).toBe("PUT");
      expect(req.url).toContain("/releases/1.0.0/");
      const body = (await req.json()) as {
        refs: Array<{
          repository: string;
          commit: string;
          previousCommit?: string;
        }>;
      };
      expect(body.refs).toEqual([
        {
          repository: "getsentry/cli",
          commit: "abc123def456789012345678901234567890abcd",
          previousCommit: "prev000000000000000000000000000000000000",
        },
      ]);
      return new Response(JSON.stringify(withCommits), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const release = await setCommitsAuto("test-org", "1.0.0", "/tmp");

    expect(release.commitCount).toBe(5);
  });

  test("throws ApiError when org has no repositories", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    await expect(setCommitsAuto("test-org", "1.0.0", "/tmp")).rejects.toThrow(
      /No repository integrations/
    );
  });

  test.each([
    { body: { ok: true }, status: 200 },
    { body: "unexpected response", status: 202 },
    { body: null, status: 200 },
  ])("rejects a non-array repository response (%j) before updating the release", async ({
    body,
    status,
  }) => {
    const requests: { method: string; pathname: string }[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input!, init);
      requests.push({
        method: request.method,
        pathname: new URL(request.url).pathname,
      });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    });

    const error = await setCommitsAuto("test-org", "1.0.0", "/tmp").catch(
      (caught: unknown) => caught
    );
    expect(error).toMatchObject({
      name: "ApiError",
      exitCode: EXIT.API,
      message: "Failed to list repositories: unexpected response format",
      status,
      endpoint: "/api/0/organizations/test-org/repos/",
    });
    expect(isUserError(error)).toBe(false);
    expect(classifySilenced(error)).toBeNull();
    expect(requests).toEqual([
      { method: "GET", pathname: "/api/0/organizations/test-org/repos/" },
    ]);
  });

  test("throws ValidationError when no repo matches local remote", async () => {
    const otherRepo = { ...SAMPLE_REPO, name: "getsentry/sentry" };
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify([otherRepo]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    await expect(setCommitsAuto("test-org", "1.0.0", "/tmp")).rejects.toThrow(
      /No Sentry repository matching/
    );
  });

  test("paginates through multiple pages to find matching repo", async () => {
    const withCommits = { ...SAMPLE_RELEASE, commitCount: 3 };
    const otherRepo = { ...SAMPLE_REPO, id: "2", name: "getsentry/sentry" };
    let repoRequestCount = 0;

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);

      if (req.url.includes("/repos/")) {
        repoRequestCount += 1;
        if (repoRequestCount === 1) {
          // First page: different repo, with a next cursor
          return new Response(JSON.stringify([otherRepo]), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              Link: '<https://us.sentry.io/api/0/next/>; rel="next"; results="true"; cursor="page2:0:0"',
            },
          });
        }
        // Second page: the matching repo, no next cursor
        return new Response(JSON.stringify([SAMPLE_REPO]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Previous release commit lookup (no previous release)
      if (req.url.includes("/previous-with-commits/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // PUT refs on the release
      return new Response(JSON.stringify(withCommits), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const release = await setCommitsAuto("test-org", "1.0.0", "/tmp");

    expect(release.commitCount).toBe(3);
    expect(repoRequestCount).toBe(2);
  });

  test("throws an actionable ValidationError when no git remote is configured", async () => {
    mockGetRepositoryName.mockReturnValue(null);

    // A missing 'origin' remote (e.g. a fresh `git init`) is an expected
    // precondition, not a crash. It must surface as a CliError (exit 21,
    // rendered via format() — no stack trace) with actionable guidance, and
    // keep field "repository" so default mode can fall back to local git.
    await expect(
      setCommitsAuto("test-org", "1.0.0", "/tmp")
    ).rejects.toMatchObject({
      name: "ValidationError",
      field: "repository",
      exitCode: 21,
    });

    await expect(setCommitsAuto("test-org", "1.0.0", "/tmp")).rejects.toThrow(
      /Could not determine the repository from the local git remote/
    );
    await expect(setCommitsAuto("test-org", "1.0.0", "/tmp")).rejects.toThrow(
      /--local/
    );
  });
});

// =============================================================================
// setCommitsLocal
// =============================================================================

describe("setCommitsLocal", () => {
  test("sends explicit commits to the API", async () => {
    const withCommits = { ...SAMPLE_RELEASE, commitCount: 2 };
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      expect(req.method).toBe("PUT");
      const body = (await req.json()) as {
        commits: Array<{ id: string; message: string }>;
      };
      expect(body.commits).toHaveLength(1);
      expect(body.commits[0].id).toBe("abc123");
      return new Response(JSON.stringify(withCommits), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const release = await setCommitsLocal("test-org", "1.0.0", [
      {
        id: "abc123",
        message: "fix: something",
        author_name: "Test",
        author_email: "test@example.com",
        timestamp: "2025-01-01T00:00:00Z",
      },
    ]);

    expect(release.commitCount).toBe(2);
  });
});

// =============================================================================
// listReleasesPaginated
// =============================================================================

describe("listReleasesPaginated", () => {
  test("returns a page of releases with cursor", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      expect(req.url).toContain("/releases/");
      return new Response(JSON.stringify([SAMPLE_RELEASE]), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          link: linkHeader("abc:0:0", true),
        },
      });
    });

    const result = await listReleasesPaginated("test-org", { perPage: 25 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].version).toBe("1.0.0");
    expect(result.nextCursor).toBe("abc:0:0");
  });

  test("returns no cursor when no more pages", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify([SAMPLE_RELEASE]), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            link: linkHeader("abc:0:0", false),
          },
        })
    );

    const result = await listReleasesPaginated("test-org");

    expect(result.data).toHaveLength(1);
    expect(result.nextCursor).toBeUndefined();
  });

  test("passes query and sort options", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      const url = new URL(req.url);
      expect(url.searchParams.get("query")).toBe("1.0");
      expect(url.searchParams.get("sort")).toBe("date");
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await listReleasesPaginated("test-org", {
      query: "1.0",
      sort: "date",
    });

    expect(result.data).toHaveLength(0);
  });
});
