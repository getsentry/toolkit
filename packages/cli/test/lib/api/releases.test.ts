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
const { mockGetRepositoryName, mockIsInsideGitWorkTree } = vi.hoisted(() => ({
  mockGetRepositoryName: vi.fn((): string | null => "getsentry/cli"),
  mockIsInsideGitWorkTree: vi.fn(() => true),
}));

vi.mock("../../../src/lib/git.js", async (importOriginal) => ({
  normalizeSha: (
    await importOriginal<typeof import("../../../src/lib/git.js")>()
  ).normalizeSha,
  isSameRepository: (
    await importOriginal<typeof import("../../../src/lib/git.js")>()
  ).isSameRepository,
  parseRemoteUrl: (
    await importOriginal<typeof import("../../../src/lib/git.js")>()
  ).parseRemoteUrl,
  getRepositoryName: mockGetRepositoryName,
  getHeadCommit: () => "abc123def456789012345678901234567890abcd",
  isInsideGitWorkTree: mockIsInsideGitWorkTree,
  isShallowRepository: () => false,
  getCommitLog: () => [],
  getUncommittedFiles: () => [],
}));

// Dynamic import: must run AFTER vi.mock() so setCommitsAuto picks up
// the mocked git helpers.
const {
  createRelease,
  createReleaseDeploy,
  deleteRelease,
  explainSetCommitsError,
  getRelease,
  listReleaseDeploys,
  listReleasesPaginated,
  setCommitsAuto,
  setCommitsWithRefs,
  setCommitsLocal,
  updateRelease,
} = await import("../../../src/lib/api/releases.js");

import { setAuthToken } from "../../../src/lib/db/auth.js";
import { CONFIG_DIR_ENV_VAR } from "../../../src/lib/db/index.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { withEnv } from "../../../src/lib/env.js";
import { classifySilenced } from "../../../src/lib/error-reporting.js";
import { ApiError, EXIT, isUserError } from "../../../src/lib/errors.js";
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
  setAuthToken("test-token");
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
    mockIsInsideGitWorkTree.mockReturnValue(true);
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
        const params = new URL(req.url).searchParams;
        expect(params.get("query")).toBe("getsentry/cli");
        expect(params.get("per_page")).toBe("100");
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
          { status: 200, headers: { "Content-Type": "application/json" } },
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

  test("fetches the previous release commit concurrently with the repository lookup", async () => {
    const withCommits = { ...SAMPLE_RELEASE, commitCount: 2 };
    let releaseRepos: (() => void) | undefined;
    const reposGate = new Promise<void>((resolve) => {
      releaseRepos = resolve;
    });
    let previousRequestedBeforeReposResolved = false;
    let reposResolved = false;

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);

      if (req.url.includes("/repos/")) {
        await reposGate;
        reposResolved = true;
        return new Response(JSON.stringify([SAMPLE_REPO]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (req.url.includes("/previous-with-commits/")) {
        previousRequestedBeforeReposResolved = !reposResolved;
        // Unblock the repository lookup only once the previous-release
        // request is in flight; a sequential implementation would deadlock.
        releaseRepos?.();
        return new Response(
          JSON.stringify({
            lastCommit: { id: "prev000000000000000000000000000000000000" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      const body = (await req.json()) as {
        refs: Array<{ previousCommit?: string }>;
      };
      expect(body.refs[0]?.previousCommit).toBe(
        "prev000000000000000000000000000000000000",
      );
      return new Response(JSON.stringify(withCommits), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const release = await setCommitsAuto("test-org", "1.0.0", "/tmp");

    expect(previousRequestedBeforeReposResolved).toBe(true);
    expect(release.commitCount).toBe(2);
  });

  test("throws ApiError when org has no repositories", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(
      setCommitsAuto("test-org", "1.0.0", "/tmp"),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: expect.stringMatching(/No repository integrations/),
      endpoint: "organizations/test-org/repos/",
      detail: expect.stringMatching(
        /Connect GitHub, GitLab, Bitbucket, or Azure DevOps.*\/settings\/integrations\/\?category=source%20code%20management[\s\S]*--local/,
      ),
    });
  });

  test("leaves --local out of the no-integration error outside a git checkout", async () => {
    mockIsInsideGitWorkTree.mockReturnValue(false);
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const error = await setCommitsAuto("test-org", "1.0.0", "/tmp").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).detail).not.toContain("--local");
  });

  test.each([
    { body: { ok: true }, status: 200 },
    { body: "unexpected response", status: 202 },
    { body: null, status: 200 },
  ])(
    "rejects a non-array repository response (%j) before updating the release",
    async ({ body, status }) => {
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
        (caught: unknown) => caught,
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
      // The previous-release lookup runs concurrently with the repository
      // lookup, so only assert on the repository request and that the
      // release was never updated.
      expect(
        requests.filter(({ pathname }) => pathname.endsWith("/repos/")),
      ).toEqual([
        { method: "GET", pathname: "/api/0/organizations/test-org/repos/" },
      ]);
      expect(requests.some(({ method }) => method === "PUT")).toBe(false);
    },
  );

  test("throws ValidationError when the name filter matches nothing but the org has repos", async () => {
    const otherRepo = {
      ...SAMPLE_REPO,
      name: "getsentry/sentry",
      url: "https://github.com/getsentry/sentry",
    };
    const repoQueries: (string | null)[] = [];

    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(new Request(input!, init).url);
      if (!url.pathname.endsWith("/repos/")) {
        // Concurrent previous-release lookup
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const params = url.searchParams;
      repoQueries.push(params.get("query"));
      const repos = params.get("query") ? [] : [otherRepo];
      return new Response(JSON.stringify(repos), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await expect(setCommitsAuto("test-org", "1.0.0", "/tmp")).rejects.toThrow(
      /No Sentry repository matching/,
    );
    // Full path first, then the last segment (GitLab display names), then
    // the unfiltered "does the org have any repositories" check.
    expect(repoQueries).toEqual(["getsentry/cli", "cli", null]);
  });

  test("throws ValidationError when no repo matches local remote", async () => {
    const otherRepo = {
      ...SAMPLE_REPO,
      name: "getsentry/sentry",
      url: "https://github.com/getsentry/sentry",
    };
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify([otherRepo]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(setCommitsAuto("test-org", "1.0.0", "/tmp")).rejects.toThrow(
      /No Sentry repository matching/,
    );
  });

  test("paginates through multiple pages to find matching repo", async () => {
    const withCommits = { ...SAMPLE_RELEASE, commitCount: 3 };
    const otherRepo = {
      ...SAMPLE_REPO,
      id: "2",
      name: "getsentry/sentry",
      url: "https://github.com/getsentry/sentry",
    };
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
    mockIsInsideGitWorkTree.mockReturnValueOnce(false);

    // A missing 'origin' remote (e.g. a fresh `git init`) is an expected
    // precondition, not a crash. It must surface as a CliError (exit 21,
    // rendered via format() — no stack trace) with actionable guidance, and
    // keep field "repository" so default mode can fall back to local git.
    // An empty env keeps the CI runner's own variables out of the lookup.
    const error = await withEnv({}, () =>
      setCommitsAuto("test-org", "1.0.0", "/tmp"),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "ValidationError",
      field: "repository",
      exitCode: 21,
    });
    expect((error as Error).message).toMatch(
      /no 'origin' git remote and no CI repository variables/,
    );
    const message = (error as Error).message;
    expect(message).toContain(
      "sentry release set-commits test-org/1.0.0 --commit owner/repo@<commit-sha>",
    );
    // Without .git, adding a remote or reading local history cannot help.
    expect(message).not.toMatch(/--local|git remote add/);
    expect(message).toMatch(/Docker builds often exclude .git/);
  });

  test("suggests adding a remote in a git checkout without one", async () => {
    mockGetRepositoryName.mockReturnValue(null);

    const error = await withEnv({}, () =>
      setCommitsAuto("test-org", "1.0.0", "/tmp"),
    ).catch((caught: unknown) => caught);

    const message = (error as Error).message;
    expect(message).toContain("git remote add origin <url>");
    expect(message).toContain(
      "sentry release set-commits test-org/1.0.0 --local",
    );
    expect(message).not.toMatch(/Docker/);
  });

  test("skips Vercel preview builds and says why", async () => {
    mockGetRepositoryName.mockReturnValue(null);
    // The bundler plugins skip commit association on previews on purpose,
    // so --auto must not pick up VERCEL_GIT_* there.
    const error = await withEnv(
      {
        VERCEL: "1",
        VERCEL_TARGET_ENV: "preview",
        VERCEL_GIT_REPO_OWNER: "getsentry",
        VERCEL_GIT_REPO_SLUG: "cli",
        VERCEL_GIT_COMMIT_SHA: "1234567890abcdef1234567890abcdef12345678",
      },
      () => setCommitsAuto("test-org", "1.0.0", "/tmp"),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "ValidationError",
      field: "repository",
    });
    expect((error as Error).message).toMatch(
      /Vercel builds have no .git directory/,
    );
  });

  test("uses the CI repository and commit when there is no git remote", async () => {
    mockGetRepositoryName.mockReturnValue(null);
    const ciSha = "1234567890abcdef1234567890abcdef12345678";
    const repoQueries: (string | null)[] = [];
    let sentRefs: unknown;

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      if (req.url.includes("/repos/")) {
        repoQueries.push(new URL(req.url).searchParams.get("query"));
        return new Response(JSON.stringify([SAMPLE_REPO]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (req.url.includes("/previous-with-commits/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      sentRefs = ((await req.json()) as { refs: unknown }).refs;
      return new Response(JSON.stringify(SAMPLE_RELEASE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    // A Docker build without .git still gets the CI variables.
    await withEnv(
      {
        // Keep the test database; leave out the runner's own CI variables.
        [CONFIG_DIR_ENV_VAR]: process.env[CONFIG_DIR_ENV_VAR],
        SENTRY_CLI_NO_TELEMETRY: "1",
        GITHUB_REPOSITORY: "getsentry/cli",
        GITHUB_SHA: ciSha,
      },
      () => setCommitsAuto("test-org", "1.0.0", "/tmp"),
    );

    expect(repoQueries).toEqual(["getsentry/cli"]);
    expect(sentRefs).toEqual([{ repository: "getsentry/cli", commit: ciSha }]);
  });

  // Sentry names GitLab repositories by their display path; the remote has
  // the slugs, which GitLab derives from the display names.
  test.each([
    {
      remote: "acme/web/storefront",
      name: "Acme Corp / Web / Storefront",
      queries: ["acme/web/storefront", "storefront"],
    },
    {
      remote: "acme/web/my-store_front",
      name: "Acme Corp / Web / My Store Front",
      queries: ["acme/web/my-store_front", "my-store_front", "my store front"],
    },
  ])(
    "matches GitLab repository '$name' by its URL path",
    async ({ remote, name, queries }) => {
      mockGetRepositoryName.mockReturnValue(remote);
      const gitlabRepo = {
        ...SAMPLE_REPO,
        name,
        url: `https://gitlab.com/${remote}`,
        provider: { id: "integrations:gitlab", name: "GitLab" },
      };
      const repoQueries: (string | null)[] = [];
      let sentRefs: unknown;

      globalThis.fetch = mockFetch(async (input, init) => {
        const req = new Request(input!, init);
        if (req.url.includes("/repos/")) {
          const query = new URL(req.url).searchParams.get("query");
          repoQueries.push(query);
          // The server filters with a case-insensitive "name contains".
          const matches =
            query &&
            gitlabRepo.name.toLowerCase().includes(query.toLowerCase());
          return new Response(JSON.stringify(matches ? [gitlabRepo] : []), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (req.url.includes("/previous-with-commits/")) {
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        sentRefs = ((await req.json()) as { refs: unknown }).refs;
        return new Response(JSON.stringify(SAMPLE_RELEASE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await setCommitsAuto("test-org", "1.0.0", "/tmp");

      expect(repoQueries).toEqual(queries);
      expect(sentRefs).toEqual([
        {
          repository: name,
          commit: "abc123def456789012345678901234567890abcd",
        },
      ]);
    },
  );

  test("suggests similar repositories and the settings page when nothing matches", async () => {
    const renamed = {
      ...SAMPLE_REPO,
      name: "getsentry/cli-legacy",
      url: "https://github.com/getsentry/cli-legacy",
    };
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(new Request(input!, init).url);
      if (!url.pathname.endsWith("/repos/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const repos = url.searchParams.get("query") === "cli" ? [renamed] : [];
      return new Response(JSON.stringify(repos), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const error = await setCommitsAuto("test-org", "1.0.0", "/tmp").catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      name: "ValidationError",
      field: "repository",
    });
    const message = (error as Error).message;
    expect(message).toMatch(
      /No Sentry repository matching 'getsentry\/cli' \(from the 'origin' git remote\)/,
    );
    expect(message).toMatch(
      /similarly named repositories: getsentry\/cli-legacy/,
    );
    expect(message).toContain(
      "sentry release set-commits test-org/1.0.0 --commit 'getsentry/cli-legacy@abc123def456789012345678901234567890abcd'",
    );
    expect(message).toMatch(/settings\/repos\//);
  });
  // Sentry names Azure DevOps repositories by the bare repository name; the
  // Azure Pipelines URL has `org/project/_git/repo`.
  test("matches an Azure Repos repository from Azure Pipelines by its URL path", async () => {
    mockGetRepositoryName.mockReturnValue(null);
    const ciSha = "1234567890abcdef1234567890abcdef12345678";
    const repoUrl = "https://dev.azure.com/acme/web/_git/storefront";
    const azureRepo = {
      ...SAMPLE_REPO,
      name: "storefront",
      url: repoUrl,
      provider: { id: "integrations:vsts", name: "Azure DevOps" },
    };
    const repoQueries: (string | null)[] = [];
    let sentRefs: unknown;

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      if (req.url.includes("/repos/")) {
        const query = new URL(req.url).searchParams.get("query") ?? "";
        repoQueries.push(query);
        const matches = azureRepo.name.includes(query.toLowerCase());
        return new Response(JSON.stringify(matches ? [azureRepo] : []), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (req.url.includes("/previous-with-commits/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      sentRefs = ((await req.json()) as { refs: unknown }).refs;
      return new Response(JSON.stringify(SAMPLE_RELEASE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await withEnv(
      {
        [CONFIG_DIR_ENV_VAR]: process.env[CONFIG_DIR_ENV_VAR],
        SENTRY_CLI_NO_TELEMETRY: "1",
        BUILD_REPOSITORY_URI: repoUrl,
        BUILD_SOURCEVERSION: ciSha,
      },
      () => setCommitsAuto("test-org", "1.0.0", "/tmp"),
    );

    expect(repoQueries).toEqual(["acme/web/_git/storefront", "storefront"]);
    expect(sentRefs).toEqual([{ repository: "storefront", commit: ciSha }]);
  });

  test.each([
    {
      case: "skips a display name whose URL points to another project",
      hits: [
        {
          name: "Acme / Web",
          url: "https://gitlab.com/acme-archive/acme/web",
        },
        { name: "Acme Corp / Web", url: "https://gitlab.com/acme/web" },
      ],
      expected: "Acme Corp / Web",
    },
    {
      case: "matches a display name when the repository has no URL",
      hits: [{ name: "Acme / Web", url: null }],
      expected: "Acme / Web",
    },
  ])("$case", async ({ hits, expected }) => {
    mockGetRepositoryName.mockReturnValue("acme/web");
    let sentRefs: unknown;

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      if (req.url.includes("/repos/")) {
        const query = new URL(req.url).searchParams.get("query") ?? "";
        const repos = hits
          .filter((hit) => hit.name.toLowerCase().includes(query))
          .map((hit) => ({ ...SAMPLE_REPO, ...hit }));
        return new Response(JSON.stringify(repos), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (req.url.includes("/previous-with-commits/")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      sentRefs = ((await req.json()) as { refs: unknown }).refs;
      return new Response(JSON.stringify(SAMPLE_RELEASE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await setCommitsAuto("test-org", "1.0.0", "/tmp");

    expect(sentRefs).toEqual([
      {
        repository: expected,
        commit: "abc123def456789012345678901234567890abcd",
      },
    ]);
  });
});

describe("setCommitsWithRefs", () => {
  test.each([".", ".."])(
    "rejects a bare dot release version %s before making a request",
    async (version) => {
      const fetchMock = vi.fn<typeof globalThis.fetch>();
      globalThis.fetch = fetchMock;

      await expect(
        setCommitsWithRefs("test-org", version, []),
      ).rejects.toMatchObject({ name: "ValidationError", field: "version" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test("rejects a bare dot organization before making a request", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    globalThis.fetch = fetchMock;

    await expect(setCommitsWithRefs("..", "1.0.0", [])).rejects.toMatchObject({
      name: "ValidationError",
      field: "organization",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("keeps a slash in a release version within the org release endpoint", async () => {
    const requestPaths: string[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input!, init);
      requestPaths.push(new URL(request.url).pathname);
      return new Response(JSON.stringify(SAMPLE_RELEASE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await setCommitsWithRefs("test-org", "release/feature", []);
    expect(requestPaths).toEqual([
      "/api/0/organizations/test-org/releases/release%2Ffeature/",
    ]);
  });
});

describe("explainSetCommitsError", () => {
  const REFS = [
    {
      repository: "AutonomousBusinessUnits/platform",
      commit: "def456",
      previousCommit: "abc123",
    },
  ];
  /** The server's 400 for a ref whose repository the org doesn't have. */
  const invalidRepoError = (name: string) =>
    new ApiError(
      "API request failed: 400 Bad Request",
      400,
      JSON.stringify({ refs: [`Invalid repository names: ${name}`] }),
      "organizations/test-org/releases/1.0.0/",
    );
  const repo = (name: string, url?: string) => ({
    id: name,
    name,
    url,
    provider: { id: "integrations:github", name: "GitHub" },
    status: "active",
  });
  /** Answer every repository search with `repos`. */
  const reposResponse = (repos: unknown[]) =>
    mockFetch(
      async () =>
        new Response(JSON.stringify(repos), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

  test.each([
    new ApiError("API request failed: 400 Bad Request", 400, "Invalid SHA"),
    new ApiError("API request failed: 500", 500, "Invalid repository names: x"),
    new Error("boom"),
  ])("returns other errors unchanged (%s)", async (error) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    globalThis.fetch = fetchMock;

    expect(await explainSetCommitsError("test-org", "1.0.0", REFS, error)).toBe(
      error,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("names the repository Sentry has when only the case differs", async () => {
    globalThis.fetch = reposResponse([
      repo(
        "autonomousbusinessunits/platform",
        "https://github.com/autonomousbusinessunits/platform",
      ),
    ]);

    const error = await explainSetCommitsError(
      "test-org",
      "1.0.0",
      REFS,
      invalidRepoError("AutonomousBusinessUnits/platform"),
    );

    expect(error).toMatchObject({
      name: "ValidationError",
      field: "commit.repository",
    });
    const { message } = error as Error;
    expect(message).toContain(
      "has no repository named 'AutonomousBusinessUnits/platform'",
    );
    expect(message).toContain(
      "sentry release set-commits test-org/1.0.0 --commit 'autonomousbusinessunits/platform@abc123..def456'",
    );
  });

  test("links the integration directory when the org has no repositories", async () => {
    globalThis.fetch = reposResponse([]);

    const error = await explainSetCommitsError(
      "test-org",
      "1.0.0",
      REFS,
      invalidRepoError("AutonomousBusinessUnits/platform"),
    );

    expect(error).toMatchObject({ field: "commit.repository" });
    const { message } = error as Error;
    expect(message).toContain("It has no repositories yet");
    expect(message).toMatch(
      /\/settings\/integrations\/\?category=source%20code%20management/,
    );
    expect(classifySilenced(error)).toBe("user_config");
  });

  test("suggests similar repositories and links the repository settings", async () => {
    globalThis.fetch = reposResponse([repo("AutonomousBusinessUnits/web")]);

    const error = await explainSetCommitsError(
      "test-org",
      "1.0.0",
      REFS,
      invalidRepoError("AutonomousBusinessUnits/platform"),
    );

    const { message } = error as Error;
    expect(message).toContain(
      "It has similarly named repositories: AutonomousBusinessUnits/web.",
    );
    expect(message).toContain(
      "--commit 'AutonomousBusinessUnits/web@abc123..def456'",
    );
    expect(message).toContain("sentry repo list test-org/");
    expect(message).toMatch(/\/settings\/repos\//);
  });

  test("still links the repository settings when the lookup fails", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ detail: "boom" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const error = await explainSetCommitsError(
      "test-org",
      "1.0.0",
      REFS,
      invalidRepoError("AutonomousBusinessUnits/platform"),
    );

    expect(error).toMatchObject({ field: "commit.repository" });
    expect((error as Error).message).toMatch(/\/settings\/repos\//);
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
        }),
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

  test.each(["sessions", "users", "crash_free_sessions", "crash_free_users"])(
    "requests flattened results when sorting by %s",
    async (sort) => {
      let flatten: string | null = null;
      globalThis.fetch = mockFetch(async (input, init) => {
        const url = new URL(new Request(input!, init).url);
        flatten = url.searchParams.get("flatten");
        // Sentry rejects session sorts unless the results are flattened.
        if (flatten !== "1") {
          return new Response(
            JSON.stringify({
              detail:
                "sorting by crash statistics requires flattening (flatten=1)",
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify([SAMPLE_RELEASE]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await listReleasesPaginated("test-org", { sort });

      expect(flatten).toBe("1");
      expect(result.data).toHaveLength(1);
    },
  );

  test("does not flatten date-sorted results", async () => {
    let flatten: string | null = "unset";
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(new Request(input!, init).url);
      flatten = url.searchParams.get("flatten");
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await listReleasesPaginated("test-org", { sort: "date" });

    expect(flatten).toBeNull();
  });
});
