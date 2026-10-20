import { afterEach, describe, it, expect, vi } from "vitest";
import "urlpattern-polyfill";
import {
  verifyConstraintsAccess,
  type CachedConstraints,
  type CacheOptions,
} from "./constraint-utils";

/**
 * Create a mock KVNamespace for testing cache behavior.
 */
function createMockKV(options?: {
  getResult?: CachedConstraints | null;
  getError?: Error;
  putError?: Error;
}): KVNamespace {
  let stored = options?.getResult ?? null;
  let expiresAt = Number.POSITIVE_INFINITY;
  return {
    get: vi.fn().mockImplementation(async () => {
      if (options?.getError) throw options.getError;
      return Date.now() < expiresAt ? stored : null;
    }),
    put: vi
      .fn()
      .mockImplementation(
        async (
          _key: string,
          value: string,
          { expirationTtl }: { expirationTtl: number },
        ) => {
          if (options?.putError) throw options.putError;
          stored = JSON.parse(value);
          expiresAt = Date.now() + expirationTtl * 1000;
        },
      ),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

/**
 * Override the project HTTP response while keeping the shared org interceptor.
 * The Node-side fetchMock cannot follow workerd's fake timeout clock.
 */
function mockProjectResponse(
  respond: (url: URL) => Response | Promise<Response>,
) {
  const originalFetch = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const projectUrl =
      "https://us.sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/";
    if (url === projectUrl || url === `${projectUrl}?collapse=organization`) {
      return Promise.resolve(respond(new URL(url)));
    }
    return originalFetch(input, init);
  });
}

describe("verifyConstraintsAccess", () => {
  const token = "test-token";
  const host = "sentry.io";

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns ok with empty constraints when no org constraint provided", async () => {
    const result = await verifyConstraintsAccess(
      { organizationSlug: null, projectSlug: null },
      { accessToken: token, sentryHost: host },
    );
    expect(result).toEqual({
      ok: true,
      constraints: {
        organizationSlug: null,
        projectSlug: null,
        regionUrl: null,
      },
    });
  });

  it("fails when access token is missing, null, undefined, or empty", async () => {
    const testCases = [
      { accessToken: "", label: "empty" },
      { accessToken: null, label: "null" },
      { accessToken: undefined, label: "undefined" },
    ];

    for (const { accessToken, label } of testCases) {
      const result = await verifyConstraintsAccess(
        { organizationSlug: "org", projectSlug: null },
        { accessToken, sentryHost: host },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
        expect(result.message).toBe(
          "Missing access token for constraint verification",
        );
      }
    }
  });

  it("successfully verifies org access and returns constraints with regionUrl", async () => {
    const result = await verifyConstraintsAccess(
      { organizationSlug: "sentry-mcp-evals", projectSlug: null },
      { accessToken: token, sentryHost: host },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.constraints).toEqual({
        organizationSlug: "sentry-mcp-evals",
        projectSlug: null,
        regionUrl: "https://us.sentry.io",
        projectCapabilities: null,
      });
    }
  });

  it("successfully verifies org and project access", async () => {
    const result = await verifyConstraintsAccess(
      { organizationSlug: "sentry-mcp-evals", projectSlug: "cloudflare-mcp" },
      { accessToken: token, sentryHost: host },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.constraints).toEqual({
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        regionUrl: "https://us.sentry.io",
        projectCapabilities: {
          profiles: false,
          replays: false,
          logs: false,
          traces: false,
        },
      });
    }
  });

  it("collapses organization metadata while preserving project capabilities", async () => {
    let projectUrl: URL | undefined;
    mockProjectResponse((url) => {
      projectUrl = url;
      return Response.json({
        id: "123",
        slug: "cloudflare-mcp",
        name: "Cloudflare MCP",
        organization: { id: "456", slug: "sentry-mcp-evals" },
        hasProfiles: true,
        hasReplays: false,
        hasLogs: true,
        firstTransactionEvent: false,
      });
    });

    const result = await verifyConstraintsAccess(
      { organizationSlug: "sentry-mcp-evals", projectSlug: "cloudflare-mcp" },
      { accessToken: token, sentryHost: host },
    );

    expect(projectUrl?.searchParams.get("collapse")).toBe("organization");
    expect(result).toEqual({
      ok: true,
      constraints: {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        regionUrl: "https://us.sentry.io",
        projectCapabilities: {
          profiles: true,
          replays: false,
          logs: true,
          traces: false,
        },
      },
    });
  });

  it("fails when org does not exist", async () => {
    const result = await verifyConstraintsAccess(
      { organizationSlug: "nonexistent-org", projectSlug: null },
      { accessToken: token, sentryHost: host },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.message).toBe("Organization 'nonexistent-org' not found");
    }
  });

  it("fails when project does not exist", async () => {
    const result = await verifyConstraintsAccess(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "nonexistent-project",
      },
      { accessToken: token, sentryHost: host },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.message).toBe(
        "Project 'nonexistent-project' not found in organization 'sentry-mcp-evals'",
      );
    }
  });

  describe("caching", () => {
    it("reuses a project timeout for 60 seconds, then refreshes capabilities", async () => {
      vi.useFakeTimers();
      let notifyProjectStarted!: () => void;
      const projectStarted = new Promise<void>((resolve) => {
        notifyProjectStarted = resolve;
      });
      const projectResponse = mockProjectResponse(() => {
        notifyProjectStarted();
        return new Promise(() => {});
      });
      const kv = createMockKV();
      const cache: CacheOptions = {
        kv,
        userId: "timeout-user",
        waitUntil: vi.fn(),
      };
      const constraints = {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
      };
      const options = { accessToken: token, sentryHost: host, cache };
      const firstRequest = verifyConstraintsAccess(constraints, options);
      await projectStarted;
      await vi.advanceTimersByTimeAsync(5000);

      const timedOut = await firstRequest;
      projectResponse.mockRestore();
      expect(timedOut).toEqual({
        ok: true,
        constraints: {
          ...constraints,
          regionUrl: "https://us.sentry.io",
          projectCapabilities: null,
        },
      });
      expect(cache.waitUntil).toHaveBeenCalledOnce();
      await vi.mocked(cache.waitUntil).mock.calls[0][0];
      expect(kv.put).toHaveBeenCalledWith(
        "caps:v1:timeout-user:sentry.io:sentry-mcp-evals:project:cloudflare-mcp",
        expect.any(String),
        { expirationTtl: 60 },
      );

      await vi.advanceTimersByTimeAsync(59_999);
      expect(await verifyConstraintsAccess(constraints, options)).toEqual(
        timedOut,
      );
      expect(kv.put).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1);
      expect(await verifyConstraintsAccess(constraints, options)).toMatchObject(
        {
          ok: true,
          constraints: {
            projectCapabilities: {
              profiles: false,
              replays: false,
              logs: false,
              traces: false,
            },
          },
        },
      );
      await vi.mocked(cache.waitUntil).mock.calls[1][0];
      expect(kv.put).toHaveBeenLastCalledWith(
        "caps:v1:timeout-user:sentry.io:sentry-mcp-evals:project:cloudflare-mcp",
        expect.any(String),
        { expirationTtl: 900 },
      );
    });

    it.each([401, 403, 404])(
      "does not cache a project verification failure with HTTP %i",
      async (status) => {
        mockProjectResponse(
          () =>
            new Response(JSON.stringify({ detail: "Project access denied" }), {
              status,
              headers: { "Content-Type": "application/json" },
            }),
        );
        const kv = createMockKV();
        const cache: CacheOptions = {
          kv,
          userId: "denied-user",
          waitUntil: vi.fn(),
        };

        const result = await verifyConstraintsAccess(
          {
            organizationSlug: "sentry-mcp-evals",
            projectSlug: "cloudflare-mcp",
          },
          { accessToken: token, sentryHost: host, cache },
        );

        expect(result).toMatchObject({ ok: false, status });
        expect(kv.put).not.toHaveBeenCalled();
        expect(cache.waitUntil).not.toHaveBeenCalled();
      },
    );

    const cachedData: CachedConstraints = {
      regionUrl: "https://us.sentry.io",
      projectCapabilities: {
        profiles: true,
        replays: false,
        logs: true,
        traces: false,
      },
      cachedAt: Date.now(),
    };

    it("returns cached data without making API calls on cache hit", async () => {
      const mockKV = createMockKV({ getResult: cachedData });
      const cache: CacheOptions = {
        kv: mockKV,
        userId: "user-123",
        waitUntil: vi.fn(),
      };

      const result = await verifyConstraintsAccess(
        { organizationSlug: "sentry-mcp-evals", projectSlug: "cloudflare-mcp" },
        { accessToken: token, sentryHost: host, cache },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.constraints).toEqual({
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "cloudflare-mcp",
          regionUrl: "https://us.sentry.io",
          projectCapabilities: {
            profiles: true,
            replays: false,
            logs: true,
            traces: false,
          },
        });
      }

      // Verify cache was checked
      expect(mockKV.get).toHaveBeenCalledOnce();
      expect(mockKV.get).toHaveBeenCalledWith(
        "caps:v1:user-123:sentry.io:sentry-mcp-evals:project:cloudflare-mcp",
        "json",
      );

      // Verify no cache write on hit (data already cached)
      expect(mockKV.put).not.toHaveBeenCalled();
    });

    it("fetches from API and populates cache on cache miss", async () => {
      const mockKV = createMockKV({ getResult: null });
      const cache: CacheOptions = {
        kv: mockKV,
        userId: "user-456",
        waitUntil: vi.fn(),
      };

      const result = await verifyConstraintsAccess(
        { organizationSlug: "sentry-mcp-evals", projectSlug: "cloudflare-mcp" },
        { accessToken: token, sentryHost: host, cache },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should have fetched from API
        expect(result.constraints).toEqual({
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "cloudflare-mcp",
          regionUrl: "https://us.sentry.io",
          projectCapabilities: {
            profiles: false,
            replays: false,
            logs: false,
            traces: false,
          },
        });
      }

      // Verify cache was checked
      expect(mockKV.get).toHaveBeenCalledOnce();

      await vi.mocked(cache.waitUntil).mock.calls[0][0];

      // Verify cache was written with correct key and TTL
      expect(mockKV.put).toHaveBeenCalledOnce();
      expect(mockKV.put).toHaveBeenCalledWith(
        "caps:v1:user-456:sentry.io:sentry-mcp-evals:project:cloudflare-mcp",
        expect.any(String),
        { expirationTtl: 900 },
      );

      // Verify cached data structure
      const cachedJson = vi.mocked(mockKV.put).mock.calls[0][1] as string;
      const parsed = JSON.parse(cachedJson);
      expect(parsed).toMatchObject({
        regionUrl: "https://us.sentry.io",
        projectCapabilities: {
          profiles: false,
          replays: false,
          logs: false,
          traces: false,
        },
        cachedAt: expect.any(Number),
      });
    });

    it("proceeds without cache when cache read fails", async () => {
      const mockKV = createMockKV({ getError: new Error("KV unavailable") });
      const cache: CacheOptions = {
        kv: mockKV,
        userId: "user-789",
        waitUntil: vi.fn(),
      };

      const result = await verifyConstraintsAccess(
        { organizationSlug: "sentry-mcp-evals", projectSlug: "cloudflare-mcp" },
        { accessToken: token, sentryHost: host, cache },
      );

      // Should still succeed by fetching from API
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.constraints.organizationSlug).toBe("sentry-mcp-evals");
        expect(result.constraints.projectSlug).toBe("cloudflare-mcp");
      }

      // Verify cache read was attempted
      expect(mockKV.get).toHaveBeenCalledOnce();
    });

    it("succeeds even when cache write fails", async () => {
      const mockKV = createMockKV({
        getResult: null,
        putError: new Error("KV write failed"),
      });
      const cache: CacheOptions = {
        kv: mockKV,
        userId: "user-write-fail",
        waitUntil: vi.fn(),
      };

      const result = await verifyConstraintsAccess(
        { organizationSlug: "sentry-mcp-evals", projectSlug: "cloudflare-mcp" },
        { accessToken: token, sentryHost: host, cache },
      );

      // Should still succeed despite cache write failure
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.constraints.organizationSlug).toBe("sentry-mcp-evals");
        expect(result.constraints.projectSlug).toBe("cloudflare-mcp");
      }

      await expect(
        vi.mocked(cache.waitUntil).mock.calls[0][0],
      ).resolves.toBeUndefined();

      // Verify cache write was attempted
      expect(mockKV.put).toHaveBeenCalledOnce();
    });

    it("uses cache for org-only verification", async () => {
      const orgOnlyCached: CachedConstraints = {
        regionUrl: "https://us.sentry.io",
        projectCapabilities: null,
        cachedAt: Date.now(),
      };
      const mockKV = createMockKV({ getResult: orgOnlyCached });
      const cache: CacheOptions = {
        kv: mockKV,
        userId: "user-org-only",
        waitUntil: vi.fn(),
      };

      const result = await verifyConstraintsAccess(
        { organizationSlug: "sentry-mcp-evals", projectSlug: null },
        { accessToken: token, sentryHost: host, cache },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.constraints).toEqual({
          organizationSlug: "sentry-mcp-evals",
          projectSlug: null,
          regionUrl: "https://us.sentry.io",
          projectCapabilities: null,
        });
      }

      expect(mockKV.get).toHaveBeenCalledOnce();
      expect(mockKV.get).toHaveBeenCalledWith(
        "caps:v1:user-org-only:sentry.io:sentry-mcp-evals:org",
        "json",
      );
      expect(mockKV.put).not.toHaveBeenCalled();
    });

    it("uses distinct cache keys for org-only and '__org__' project constraints", async () => {
      const mockKV = createMockKV({ getResult: cachedData });
      const cache: CacheOptions = {
        kv: mockKV,
        userId: "user-sentinel",
        waitUntil: vi.fn(),
      };

      const orgOnlyResult = await verifyConstraintsAccess(
        { organizationSlug: "sentry-mcp-evals", projectSlug: null },
        { accessToken: token, sentryHost: host, cache },
      );
      const projectResult = await verifyConstraintsAccess(
        { organizationSlug: "sentry-mcp-evals", projectSlug: "__org__" },
        { accessToken: token, sentryHost: host, cache },
      );

      expect(orgOnlyResult.ok).toBe(true);
      expect(projectResult.ok).toBe(true);
      expect(mockKV.get).toHaveBeenNthCalledWith(
        1,
        "caps:v1:user-sentinel:sentry.io:sentry-mcp-evals:org",
        "json",
      );
      expect(mockKV.get).toHaveBeenNthCalledWith(
        2,
        "caps:v1:user-sentinel:sentry.io:sentry-mcp-evals:project:__org__",
        "json",
      );
    });

    it("writes KV cache after org-only verification on miss", async () => {
      const mockKV = createMockKV({ getResult: null });
      const cache: CacheOptions = {
        kv: mockKV,
        userId: "user-org-cache-write",
        waitUntil: vi.fn(),
      };

      const result = await verifyConstraintsAccess(
        { organizationSlug: "sentry-mcp-evals", projectSlug: null },
        { accessToken: token, sentryHost: host, cache },
      );

      expect(result.ok).toBe(true);
      expect(mockKV.get).toHaveBeenCalledOnce();
      await vi.mocked(cache.waitUntil).mock.calls[0][0];
      expect(mockKV.put).toHaveBeenCalledOnce();
      expect(mockKV.put).toHaveBeenCalledWith(
        "caps:v1:user-org-cache-write:sentry.io:sentry-mcp-evals:org",
        expect.any(String),
        { expirationTtl: 900 },
      );
      const parsed = JSON.parse(
        vi.mocked(mockKV.put).mock.calls[0][1] as string,
      );
      expect(parsed).toMatchObject({
        regionUrl: "https://us.sentry.io",
        projectCapabilities: null,
        cachedAt: expect.any(Number),
      });
    });
  });
});
