import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SentryApiService } from "./client";

describe("responseCache", () => {
  afterEach(() => mswServer.resetHandlers());

  function fakeCache(user: Record<string, unknown> | undefined) {
    return {
      lookup: vi.fn(async () =>
        user
          ? {
              kind: "hit" as const,
              response: Response.json(user),
              createdAt: Date.now(),
              size: 0,
            }
          : undefined,
      ),
      store: vi.fn(async () => {}),
      invalidate: vi.fn(async () => {}),
    };
  }

  it("serves a hit without calling the API, under the cache's identity", async () => {
    const apiCalled = vi.fn();
    mswServer.use(
      http.get("https://sentry.io/api/0/auth/", () => {
        apiCalled();
        return HttpResponse.json({ id: "1", name: "API", email: "a@x.io" });
      }),
    );
    const cache = fakeCache({ id: "2", name: "Cached", email: "c@x.io" });
    const api = new SentryApiService({
      accessToken: "token",
      responseCache: { identity: "identity-a", cache },
    });

    expect(await api.getAuthenticatedUser()).toMatchObject({ name: "Cached" });
    expect(apiCalled).not.toHaveBeenCalled();
    expect(cache.lookup).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://sentry.io/api/0/auth/",
        identity: "identity-a",
      }),
    );
  });

  it("stores a miss under the cache's identity", async () => {
    mswServer.use(
      http.get("https://sentry.io/api/0/auth/", ({ request }) =>
        HttpResponse.json({
          id: "1",
          name: request.headers.get("Authorization"),
          email: "a@x.io",
        }),
      ),
    );
    const cache = fakeCache(undefined);
    const api = new SentryApiService({
      accessToken: "token",
      responseCache: { identity: "identity-a", cache },
    });

    // Authorization is unchanged by the caching transport.
    expect(await api.getAuthenticatedUser()).toMatchObject({
      name: "Bearer token",
    });
    expect(cache.store).toHaveBeenCalledWith(
      expect.objectContaining({ identity: "identity-a" }),
      expect.any(Response),
    );
  });

  it("is not used without an access token", async () => {
    mswServer.use(
      http.get("https://sentry.io/api/0/auth/", () =>
        HttpResponse.json({ id: "1", name: "API", email: "a@x.io" }),
      ),
    );
    const cache = fakeCache({ id: "2", name: "Cached", email: "c@x.io" });
    const api = new SentryApiService({
      responseCache: { identity: "identity-a", cache },
    });

    expect(await api.getAuthenticatedUser()).toMatchObject({ name: "API" });
    expect(cache.lookup).not.toHaveBeenCalled();
  });
});
