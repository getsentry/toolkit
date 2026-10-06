/**
 * Tests for createProjectWithDsn — verifies project and DSN caches are
 * seeded after project creation.
 *
 * Issue #745: After `sentry project create` or `sentry init`, resolved
 * project info wasn't saved to the local DB, forcing the next command to
 * re-scan files and hit the API.
 */

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as Sentry from "@sentry/node-core/light";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createProjectWithDsn,
  listProjects,
} from "../../../src/lib/api/projects.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import {
  getCachedProjectByDsnKey,
  getCachedProjectBySlug,
} from "../../../src/lib/db/project-cache.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import type { SentryProject } from "../../../src/types/index.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

const projectCacheMocks = vi.hoisted(() => ({
  cacheProjectsForOrg: vi.fn(),
  setCachedProjectByDsnKey: vi.fn(),
  restoreActual: () => {
    /* set in vi.mock factory */
  },
}));

vi.mock("../../../src/lib/db/project-cache.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/lib/db/project-cache.js")
    >();
  projectCacheMocks.cacheProjectsForOrg.mockImplementation(
    actual.cacheProjectsForOrg
  );
  projectCacheMocks.setCachedProjectByDsnKey.mockImplementation(
    actual.setCachedProjectByDsnKey
  );
  projectCacheMocks.restoreActual = () => {
    projectCacheMocks.cacheProjectsForOrg.mockImplementation(
      actual.cacheProjectsForOrg
    );
    projectCacheMocks.setCachedProjectByDsnKey.mockImplementation(
      actual.setCachedProjectByDsnKey
    );
  };
  return {
    ...actual,
    cacheProjectsForOrg: (
      ...args: Parameters<typeof actual.cacheProjectsForOrg>
    ) => projectCacheMocks.cacheProjectsForOrg(...args),
    setCachedProjectByDsnKey: (
      ...args: Parameters<typeof actual.setCachedProjectByDsnKey>
    ) => projectCacheMocks.setCachedProjectByDsnKey(...args),
  };
});

useTestConfigDir("api-projects-test-");

const SAMPLE_PROJECT: SentryProject = {
  id: "42",
  slug: "my-new-project",
  name: "My New Project",
  organization: { id: "1", slug: "test-org", name: "Test Org" },
};

const SAMPLE_DSN = "https://abc123publickey@o1.ingest.us.sentry.io/42";

const SAMPLE_KEY = {
  id: "key-1",
  isActive: true,
  dsn: {
    public: SAMPLE_DSN,
    secret: "https://abc123publickey:secret@o1.ingest.us.sentry.io/42",
    csp: "https://o1.ingest.us.sentry.io/api/42/csp-report/?sentry_key=abc123publickey",
    security: "",
    minidump: "",
    unreal: "",
    cdn: "",
  },
  label: "Default",
  name: "Default",
  rateLimit: null,
  secret: "secret",
  public: "abc123publickey",
  projectId: 42,
  dateCreated: "2025-01-01T00:00:00Z",
};

let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  await setAuthToken("test-token");
  setOrgRegion("test-org", "https://us.sentry.io");
  projectCacheMocks.restoreActual();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  projectCacheMocks.restoreActual();
});

function spyCaptureException(): {
  captureSpy: ReturnType<typeof vi.spyOn>;
  restore: () => void;
} {
  const captureSpy = vi.spyOn(Sentry, "captureException");
  const withScopeSpy = vi.spyOn(Sentry, "withScope");
  withScopeSpy.mockImplementation((fn: (scope: unknown) => void) => {
    fn({
      setTag() {
        /* noop */
      },
      setContext() {
        /* noop */
      },
      setFingerprint() {
        /* noop */
      },
    });
  });
  return {
    captureSpy,
    restore() {
      captureSpy.mockRestore();
      withScopeSpy.mockRestore();
    },
  };
}

/**
 * Build a mock fetch that responds to the project-create POST and then
 * the client-keys GET that `tryGetPrimaryDsn` fires.
 */
function mockCreateAndKeysFlow(options?: {
  /** Return empty keys (no DSN available) */
  emptyKeys?: boolean;
}): typeof fetch {
  let callIndex = 0;
  return mockFetch(async (input, init) => {
    const req = new Request(input!, init);
    callIndex += 1;

    // First call: POST to create the project
    if (callIndex === 1) {
      return new Response(JSON.stringify(SAMPLE_PROJECT), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Second call: GET to list project client keys
    if (callIndex === 2) {
      const keys = options?.emptyKeys ? [] : [SAMPLE_KEY];
      return new Response(JSON.stringify(keys), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(
      `Unexpected fetch call #${callIndex}: ${req.method} ${req.url}`
    );
  });
}

describe("createProjectWithDsn", () => {
  test("seeds project cache after creation", async () => {
    globalThis.fetch = mockCreateAndKeysFlow();

    const result = await createProjectWithDsn("test-org", "test-team", {
      name: "My New Project",
    });

    expect(result.project.slug).toBe("my-new-project");
    expect(result.dsn).toBe(SAMPLE_DSN);

    // Verify project cache was populated
    const cached = getCachedProjectBySlug("test-org", "my-new-project");
    expect(cached).toBeDefined();
    expect(cached!.orgSlug).toBe("test-org");
    expect(cached!.projectSlug).toBe("my-new-project");
    expect(cached!.projectName).toBe("My New Project");
    expect(cached!.projectId).toBe("42");
  });

  test("seeds DSN-based project cache when DSN is available", async () => {
    globalThis.fetch = mockCreateAndKeysFlow();

    await createProjectWithDsn("test-org", "test-team", {
      name: "My New Project",
    });

    // The public key from the DSN should be cached
    const cached = getCachedProjectByDsnKey("abc123publickey");
    expect(cached).toBeDefined();
    expect(cached!.orgSlug).toBe("test-org");
    expect(cached!.projectSlug).toBe("my-new-project");
    expect(cached!.projectName).toBe("My New Project");
    expect(cached!.projectId).toBe("42");
  });

  test("seeds project cache but not DSN cache when no DSN returned", async () => {
    globalThis.fetch = mockCreateAndKeysFlow({ emptyKeys: true });

    const result = await createProjectWithDsn("test-org", "test-team", {
      name: "My New Project",
    });

    expect(result.dsn).toBeNull();

    // Project cache should still be populated
    const cached = getCachedProjectBySlug("test-org", "my-new-project");
    expect(cached).toBeDefined();
    expect(cached!.projectSlug).toBe("my-new-project");

    // DSN cache should NOT be populated (no DSN to extract key from)
    const dsnCached = getCachedProjectByDsnKey("abc123publickey");
    expect(dsnCached).toBeUndefined();
  });

  test("uses organization name from response when available", async () => {
    globalThis.fetch = mockCreateAndKeysFlow();

    await createProjectWithDsn("test-org", "test-team", {
      name: "My New Project",
    });

    const cached = getCachedProjectBySlug("test-org", "my-new-project");
    expect(cached).toBeDefined();
    // The org name comes from SAMPLE_PROJECT.organization.name
    expect(cached!.orgName).toBe("Test Org");
  });

  test("falls back to slug for org name when organization.name is missing", async () => {
    const projectWithoutOrgName: SentryProject = {
      ...SAMPLE_PROJECT,
      organization: { id: "1", slug: "test-org" },
    };

    let callIndex = 0;
    globalThis.fetch = mockFetch(async (input, init) => {
      callIndex += 1;

      if (callIndex === 1) {
        return new Response(JSON.stringify(projectWithoutOrgName), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }

      const req = new Request(input!, init);
      if (callIndex === 2) {
        return new Response(JSON.stringify([SAMPLE_KEY]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      throw new Error(
        `Unexpected fetch call #${callIndex}: ${req.method} ${req.url}`
      );
    });

    await createProjectWithDsn("test-org", "test-team", {
      name: "My New Project",
    });

    const cached = getCachedProjectBySlug("test-org", "my-new-project");
    expect(cached).toBeDefined();
    // Should fall back to orgSlug when name is missing
    expect(cached!.orgName).toBe("test-org");
  });

  test("reports project-cache write failures to Sentry without failing creation", async () => {
    globalThis.fetch = mockCreateAndKeysFlow();
    projectCacheMocks.cacheProjectsForOrg.mockImplementation(() => {
      throw new Error("disk full");
    });
    const { captureSpy, restore } = spyCaptureException();
    try {
      const result = await createProjectWithDsn("test-org", "test-team", {
        name: "My New Project",
      });
      expect(result.project.id).toBe("42");
      expect(result.dsn).toBe(SAMPLE_DSN);
      expect(captureSpy).toHaveBeenCalledTimes(1);
      expect(captureSpy.mock.calls[0]?.[0]).toMatchObject({
        message: "disk full",
      });
    } finally {
      restore();
    }
  });

  test("reports DSN-key cache write failures to Sentry without failing creation", async () => {
    globalThis.fetch = mockCreateAndKeysFlow();
    projectCacheMocks.setCachedProjectByDsnKey.mockImplementation(() => {
      throw new Error("dsn cache locked");
    });
    const { captureSpy, restore } = spyCaptureException();
    try {
      const result = await createProjectWithDsn("test-org", "test-team", {
        name: "My New Project",
      });
      expect(result.project.slug).toBe("my-new-project");
      expect(result.dsn).toBe(SAMPLE_DSN);
      expect(captureSpy).toHaveBeenCalledTimes(1);
      expect(captureSpy.mock.calls[0]?.[0]).toMatchObject({
        message: "dsn cache locked",
      });
    } finally {
      restore();
    }
  });
});

describe("listProjects cache seeding", () => {
  test("reports cache write failures to Sentry without failing the list", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify([SAMPLE_PROJECT]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    projectCacheMocks.cacheProjectsForOrg.mockImplementation(() => {
      throw new Error("disk full");
    });
    const { captureSpy, restore } = spyCaptureException();
    try {
      const result = await listProjects("test-org");
      expect(result).toHaveLength(1);
      expect(result[0]?.slug).toBe("my-new-project");
      expect(captureSpy).toHaveBeenCalledTimes(1);
      expect(captureSpy.mock.calls[0]?.[0]).toMatchObject({
        message: "disk full",
      });
    } finally {
      restore();
    }
  });
});
