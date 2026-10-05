import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  API_MAX_PER_PAGE,
  isTextualContentType,
  paginate,
  rawApiRequest,
  throwApiError,
} from "../../../src/lib/api/infrastructure.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { ApiError, HostScopeError } from "../../../src/lib/errors.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

describe("throwApiError", () => {
  test("network failure with Error produces readable message", () => {
    expect(() =>
      throwApiError(
        new TypeError("fetch failed"),
        undefined,
        "Failed to resolve short ID"
      )
    ).toThrow(
      expect.objectContaining({
        message: "Failed to resolve short ID: Network error",
        status: 0,
      })
    );

    try {
      throwApiError(
        new TypeError("fetch failed"),
        undefined,
        "Failed to resolve short ID"
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.detail).toContain("fetch failed");
      expect(apiError.detail).toContain("Unable to reach Sentry API");
      expect(apiError.detail).toContain(
        "Check your internet connection and try again"
      );
    }
  });

  test("network failure with non-Error produces readable message", () => {
    try {
      throwApiError("connection refused", undefined, "Failed to list issues");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.message).toBe("Failed to list issues: Network error");
      expect(apiError.status).toBe(0);
      expect(apiError.detail).toContain("connection refused");
    }
  });

  test("HTTP error with response preserves status and detail", () => {
    const mockResponse = new Response("", {
      status: 400,
      statusText: "Bad Request",
    });

    try {
      throwApiError(
        { detail: "Invalid query syntax" },
        mockResponse,
        "Failed to list issues"
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.message).toBe("Failed to list issues: 400 Bad Request");
      expect(apiError.status).toBe(400);
      expect(apiError.detail).toBe("Invalid query syntax");
    }
  });

  test("HTTP error without detail uses stringified error", () => {
    const mockResponse = new Response("", {
      status: 500,
      statusText: "Internal Server Error",
    });

    try {
      throwApiError("something went wrong", mockResponse, "Failed to fetch");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.message).toBe(
        "Failed to fetch: 500 Internal Server Error"
      );
      expect(apiError.status).toBe(500);
      expect(apiError.detail).toBe("something went wrong");
    }
  });

  test("network failure with ECONNREFUSED-style error", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:443");

    try {
      throwApiError(err, undefined, "Failed to get event");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.message).toBe("Failed to get event: Network error");
      expect(apiError.detail).toContain("ECONNREFUSED");
    }
  });

  test("non-403 errors do not get enriched", () => {
    const mockResponse = new Response("", {
      status: 404,
      statusText: "Not Found",
    });

    try {
      throwApiError(
        { detail: "Resource not found" },
        mockResponse,
        "Failed to get org"
      );
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.enriched403).toBe(false);
      expect(apiError.detail).toBe("Resource not found");
    }
  });

  describe("403 enrichment", () => {
    // Test preload sets SENTRY_AUTH_TOKEN, so isEnvTokenActive() returns true
    // by default in these tests.

    test("does not suggest token scopes for org-policy disabled-feature 403s", () => {
      const mockResponse = new Response("", {
        status: 403,
        statusText: "Forbidden",
      });

      try {
        throwApiError(
          {
            detail: "Your organization has disabled this feature for members.",
          },
          mockResponse,
          "Failed to create project"
        );
      } catch (error) {
        const apiError = error as ApiError;
        expect(apiError.enriched403).toBe(true);
        expect(apiError.detail).toContain("disabled this feature");
        expect(apiError.detail).toContain("org-level policy");
        expect(apiError.detail).not.toContain("SENTRY_AUTH_TOKEN");
      }
    });

    test("enriches 403 with env-var token hints", () => {
      const mockResponse = new Response("", {
        status: 403,
        statusText: "Forbidden",
      });

      try {
        throwApiError(
          { detail: "You do not have permission to perform this action." },
          mockResponse,
          "Failed to get organization"
        );
      } catch (error) {
        const apiError = error as ApiError;
        expect(apiError.enriched403).toBe(true);
        expect(apiError.status).toBe(403);
        expect(apiError.detail).toContain(
          "You do not have permission to perform this action."
        );
        expect(apiError.detail).toContain("SENTRY_AUTH_TOKEN");
        expect(apiError.detail).toContain(
          "https://sentry.io/settings/account/api/auth-tokens/"
        );
      }
    });

    test("extracts specific scope names when present in detail", () => {
      const mockResponse = new Response("", {
        status: 403,
        statusText: "Forbidden",
      });

      try {
        throwApiError(
          {
            detail:
              "You do not have permission. Required scope: org:read, project:read",
          },
          mockResponse,
          "Failed to list issues"
        );
      } catch (error) {
        const apiError = error as ApiError;
        expect(apiError.enriched403).toBe(true);
        expect(apiError.detail).toContain(
          "missing the required scope(s) 'org:read', 'project:read'"
        );
      }
    });

    test("uses generic scope hint when no scope names in detail", () => {
      const mockResponse = new Response("", {
        status: 403,
        statusText: "Forbidden",
      });

      try {
        throwApiError(
          { detail: "You do not have permission to perform this action." },
          mockResponse,
          "Failed to get organization"
        );
      } catch (error) {
        const apiError = error as ApiError;
        expect(apiError.detail).toContain(
          "may lack the required scope for this operation"
        );
      }
    });

    test("handles undefined detail without producing noise", () => {
      const mockResponse = new Response("", {
        status: 403,
        statusText: "Forbidden",
      });

      try {
        throwApiError(
          { detail: undefined },
          mockResponse,
          "Failed to get organization"
        );
      } catch (error) {
        const apiError = error as ApiError;
        expect(apiError.enriched403).toBe(true);
        // Should contain enrichment hints
        expect(apiError.detail).toContain("SENTRY_AUTH_TOKEN");
        // Should NOT contain noisy fallback strings
        expect(apiError.detail).not.toMatch(/^undefined/);
        expect(apiError.detail).not.toContain("{}");
      }
    });

    test("handles null detail without producing noise", () => {
      const mockResponse = new Response("", {
        status: 403,
        statusText: "Forbidden",
      });

      try {
        throwApiError(
          { detail: null },
          mockResponse,
          "Failed to get organization"
        );
      } catch (error) {
        const apiError = error as ApiError;
        expect(apiError.enriched403).toBe(true);
        expect(apiError.detail).toContain("SENTRY_AUTH_TOKEN");
        // Should NOT contain noisy fallback strings
        expect(apiError.detail).not.toMatch(/^null/);
        expect(apiError.detail).not.toContain('{"detail":null}');
      }
    });

    describe("with OAuth token (no env var)", () => {
      let savedAuthToken: string | undefined;
      let savedToken: string | undefined;

      beforeEach(() => {
        savedAuthToken = process.env.SENTRY_AUTH_TOKEN;
        savedToken = process.env.SENTRY_TOKEN;
        delete process.env.SENTRY_AUTH_TOKEN;
        delete process.env.SENTRY_TOKEN;
      });

      afterEach(() => {
        if (savedAuthToken !== undefined) {
          process.env.SENTRY_AUTH_TOKEN = savedAuthToken;
        } else {
          delete process.env.SENTRY_AUTH_TOKEN;
        }
        if (savedToken !== undefined) {
          process.env.SENTRY_TOKEN = savedToken;
        } else {
          delete process.env.SENTRY_TOKEN;
        }
      });

      test("does not suggest re-authentication for org-policy disabled-feature 403s", () => {
        const mockResponse = new Response("", {
          status: 403,
          statusText: "Forbidden",
        });

        try {
          throwApiError(
            {
              detail:
                "Your organization has disabled this feature for members.",
            },
            mockResponse,
            "Failed to create project"
          );
        } catch (error) {
          const apiError = error as ApiError;
          expect(apiError.enriched403).toBe(true);
          expect(apiError.detail).toContain("disabled this feature");
          expect(apiError.detail).toContain("org-level policy");
          expect(apiError.detail).not.toContain("Re-authenticate");
          expect(apiError.detail).not.toContain("sentry auth login");
        }
      });

      test("suggests re-authentication for OAuth tokens", () => {
        const mockResponse = new Response("", {
          status: 403,
          statusText: "Forbidden",
        });

        try {
          throwApiError(
            {
              detail: "You do not have permission to perform this action.",
            },
            mockResponse,
            "Failed to get organization"
          );
        } catch (error) {
          const apiError = error as ApiError;
          expect(apiError.enriched403).toBe(true);
          expect(apiError.detail).toContain(
            "You may not have access to this resource."
          );
          expect(apiError.detail).toContain("sentry auth login");
          // Should NOT mention SENTRY_AUTH_TOKEN
          expect(apiError.detail).not.toContain("SENTRY_AUTH_TOKEN");
        }
      });

      test("suggests --scope when specific scopes are detected in 403 detail", () => {
        const mockResponse = new Response("", {
          status: 403,
          statusText: "Forbidden",
        });

        try {
          throwApiError(
            {
              detail:
                "You do not have permission. Required scope: event:read, project:read",
            },
            mockResponse,
            "Failed to list issues"
          );
        } catch (error) {
          const apiError = error as ApiError;
          expect(apiError.enriched403).toBe(true);
          expect(apiError.detail).toContain(
            "missing the required scope(s) 'event:read', 'project:read'"
          );
          expect(apiError.detail).toContain(
            "sentry auth refresh --scope event:read --scope project:read"
          );
          // Should NOT mention env var or web UI
          expect(apiError.detail).not.toContain("SENTRY_AUTH_TOKEN");
          expect(apiError.detail).not.toContain("auth-tokens/");
        }
      });
    });
  });

  describe("401 enrichment", () => {
    // Test preload sets SENTRY_AUTH_TOKEN, so isEnvTokenActive() returns true
    // by default in these tests.

    test("uses 'not recognized or has been revoked' for invalid token", () => {
      const mockResponse = new Response("", {
        status: 401,
        statusText: "Unauthorized",
      });

      try {
        throwApiError(
          { detail: "Invalid token" },
          mockResponse,
          "Failed to list organizations"
        );
      } catch (error) {
        const apiError = error as ApiError;
        expect(apiError.status).toBe(401);
        expect(apiError.message).toBe(
          "Failed to list organizations: 401 Unauthorized"
        );
        expect(apiError.detail).toContain("Invalid token");
        expect(apiError.detail).toContain("SENTRY_AUTH_TOKEN");
        expect(apiError.detail).toContain("not recognized or has been revoked");
        expect(apiError.detail).toContain(
          "https://sentry.io/settings/account/api/auth-tokens/"
        );
      }
    });

    test("uses 'has expired' for Token expired detail", () => {
      const mockResponse = new Response("", {
        status: 401,
        statusText: "Unauthorized",
      });

      try {
        throwApiError(
          { detail: "Token expired" },
          mockResponse,
          "Failed to list organizations"
        );
      } catch (error) {
        const apiError = error as ApiError;
        expect(apiError.status).toBe(401);
        expect(apiError.detail).toContain("Token expired");
        expect(apiError.detail).toContain("SENTRY_AUTH_TOKEN");
        expect(apiError.detail).toContain("has expired");
        expect(apiError.detail).not.toContain("not recognized");
        expect(apiError.detail).toContain(
          "https://sentry.io/settings/account/api/auth-tokens/"
        );
      }
    });

    test("falls back to 'not recognized' when detail is absent", () => {
      const mockResponse = new Response("", {
        status: 401,
        statusText: "Unauthorized",
      });

      try {
        throwApiError(
          { detail: undefined },
          mockResponse,
          "Failed to list organizations"
        );
      } catch (error) {
        const apiError = error as ApiError;
        expect(apiError.status).toBe(401);
        expect(apiError.detail).toContain("SENTRY_AUTH_TOKEN");
        expect(apiError.detail).toContain("not recognized or has been revoked");
        expect(apiError.detail).not.toMatch(/^undefined/);
        expect(apiError.detail).not.toContain("{}");
      }
    });

    test("treats member-disabled-over-limit as a seat-limit issue, not auth", () => {
      const mockResponse = new Response("", {
        status: 401,
        statusText: "Unauthorized",
      });

      let captured: ApiError | undefined;
      try {
        throwApiError(
          {
            detail: {
              code: "member-disabled-over-limit",
              message: "Organization over member limit",
              extra: { next: "/organizations/chisme/disabled-member/" },
            },
          },
          mockResponse,
          "Failed to list teams"
        );
      } catch (error) {
        captured = error as ApiError;
      }

      expect(captured).toBeDefined();
      expect(captured?.status).toBe(401);
      expect(captured?.detail).toContain("over its member limit");
      expect(captured?.detail).toContain("billing/seat-limit");
      // The fix must NOT give the misleading re-auth advice for this case.
      expect(captured?.detail).not.toContain("sentry auth login");
      expect(captured?.detail).not.toContain("session has expired");
      expect(captured?.detail).not.toContain("SENTRY_AUTH_TOKEN");
    });

    describe("with OAuth token (no env var)", () => {
      let savedAuthToken: string | undefined;
      let savedToken: string | undefined;

      beforeEach(() => {
        savedAuthToken = process.env.SENTRY_AUTH_TOKEN;
        savedToken = process.env.SENTRY_TOKEN;
        delete process.env.SENTRY_AUTH_TOKEN;
        delete process.env.SENTRY_TOKEN;
      });

      afterEach(() => {
        if (savedAuthToken !== undefined) {
          process.env.SENTRY_AUTH_TOKEN = savedAuthToken;
        } else {
          delete process.env.SENTRY_AUTH_TOKEN;
        }
        if (savedToken !== undefined) {
          process.env.SENTRY_TOKEN = savedToken;
        } else {
          delete process.env.SENTRY_TOKEN;
        }
      });

      test("suggests re-authentication for OAuth tokens", () => {
        const mockResponse = new Response("", {
          status: 401,
          statusText: "Unauthorized",
        });

        try {
          throwApiError(
            { detail: "Authentication credentials were not provided." },
            mockResponse,
            "Failed to list organizations"
          );
        } catch (error) {
          const apiError = error as ApiError;
          expect(apiError.status).toBe(401);
          expect(apiError.detail).toContain("session has expired");
          expect(apiError.detail).toContain("sentry auth login");
          // Should NOT mention SENTRY_AUTH_TOKEN
          expect(apiError.detail).not.toContain("SENTRY_AUTH_TOKEN");
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// isTextualContentType + rawApiRequest binary handling (getsentry/cli#1303)
// ---------------------------------------------------------------------------

describe("isTextualContentType", () => {
  test.each([
    [null, true],
    [undefined as unknown as null, true],
    ["", true],
    ["   ", true],
    ["application/json", true],
    ["application/json; charset=utf-8", true],
    ["APPLICATION/JSON", true],
    ["text/plain", true],
    ["text/html; charset=utf-8", true],
    ["application/problem+json", true],
    ["application/vnd.api+json", true],
    ["application/xml", true],
    ["application/atom+xml", true],
    ["application/yaml", true],
    ["application/x-yaml", true],
    ["application/javascript", true],
    // Binary / unknown → false (allowlist default)
    ["image/png", false],
    ["application/png", false],
    ["application/octet-stream", false],
    ["application/zip", false],
    ["application/pdf", false],
    ["application/x-dmp", false],
    ["image/jpeg", false],
    ["audio/mpeg", false],
    ["video/mp4", false],
    ["multipart/form-data", false],
  ] as const)("%s → %s", (input, expected) => {
    // Treat undefined like missing header for the null case already covered.
    expect(isTextualContentType(input ?? null)).toBe(expected);
  });
});

describe("rawApiRequest binary handling", () => {
  useTestConfigDir("raw-api-binary-");

  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await setAuthToken("test-token");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("rejects an absolute base URL outside the token trust scope", async () => {
    setAuthToken("test-token", undefined, undefined, {
      host: "https://sentry.io",
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      rawApiRequest("organizations/", {
        baseUrl: "https://example.invalid",
      })
    ).rejects.toBeInstanceOf(HostScopeError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("returns Uint8Array for image/png without UTF-8 corruption", async () => {
    // Real PNG signature: 89 50 4e 47 0d 0a 1a 0a — the leading 0x89 is not
    // valid UTF-8 and would become EF BF BD if response.text() were used.
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
    ]);

    globalThis.fetch = mockFetch(
      async () =>
        new Response(pngBytes, {
          status: 200,
          headers: { "content-type": "image/png" },
        })
    );

    const result = await rawApiRequest(
      "projects/org/proj/events/abc/attachments/1/?download=1"
    );

    expect(result.status).toBe(200);
    expect(result.body).toBeInstanceOf(Uint8Array);
    const body = result.body as Uint8Array;
    expect(Array.from(body.slice(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    // Must NOT contain the UTF-8 replacement sequence EF BF BD
    expect(Array.from(body.slice(0, 3))).not.toEqual([0xef, 0xbf, 0xbd]);
    expect(body).toEqual(pngBytes);
  });

  test("returns Uint8Array for application/octet-stream", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x80]);
    globalThis.fetch = mockFetch(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        })
    );

    const result = await rawApiRequest("debug-files/1/download/");
    expect(result.body).toBeInstanceOf(Uint8Array);
    expect(result.body).toEqual(bytes);
  });

  test("still parses JSON for application/json", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );

    const result = await rawApiRequest("organizations/");
    expect(result.body).toEqual({ ok: true });
  });

  test("still parses JSON when Content-Type is missing", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ slug: "acme" }), {
          status: 200,
        })
    );

    const result = await rawApiRequest("organizations/acme/");
    expect(result.body).toEqual({ slug: "acme" });
  });

  test("returns plain text string for text/plain non-JSON", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "text/plain" },
        })
    );

    const result = await rawApiRequest("some/text/");
    expect(result.body).toBe("not json");
  });

  test("returns the HTTP status text with the response", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response("", {
          status: 404,
          statusText: "Not Found",
        })
    );

    const result = await rawApiRequest("missing/");
    expect(result.status).toBe(404);
    expect(result.statusText).toBe("Not Found");
    expect(result.body).toBe("");
  });
});

// ---------------------------------------------------------------------------
// paginate helper (getsentry/cli#1473)
// ---------------------------------------------------------------------------

describe("paginate", () => {
  test("caps perPage at API_MAX_PER_PAGE", async () => {
    const spy = vi.fn().mockResolvedValue({ data: [] });
    await paginate({ limit: 200 }, spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(API_MAX_PER_PAGE, undefined);
  });

  test("uses defaultLimit when limit is undefined", async () => {
    const spy = vi.fn().mockResolvedValue({ data: [] });
    await paginate({}, spy, 25);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(25, undefined);
  });

  test("forwards initial cursor", async () => {
    const spy = vi.fn().mockResolvedValue({ data: [] });
    await paginate({ cursor: "abc", limit: 5 }, spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(5, "abc");
  });

  test("passes literal limit as perPage below cap", async () => {
    const spy = vi.fn().mockResolvedValue({ data: [] });
    await paginate({ limit: 5 }, spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(5, undefined);
  });

  test("accumulates across pages when limit exceeds cap", async () => {
    const spy = vi.fn((perPage: number, cursor: string | undefined) => {
      const offset = cursor ? Number(cursor) : 0;
      const data = Array.from({ length: perPage }, (_, i) => offset + i);
      return Promise.resolve({
        data,
        nextCursor: String(offset + perPage),
      });
    });

    const result = await paginate({ limit: 150 }, spy);
    expect(result.data).toEqual(Array.from({ length: 150 }, (_, i) => i));
    expect(spy.mock.calls.map(([perPage]) => perPage)).toEqual([
      API_MAX_PER_PAGE,
      50,
    ]);
    expect(result.nextCursor).toBe("150");
  });

  test("drops nextCursor when a page exceeds the remaining budget", async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce({
        data: Array.from({ length: 100 }, (_, i) => i),
        nextCursor: "c1",
      })
      .mockResolvedValueOnce({
        data: Array.from({ length: 100 }, (_, i) => 100 + i),
        nextCursor: "c2",
      });

    const result = await paginate({ limit: 150 }, spy);
    expect(result.data).toHaveLength(150);
    expect(result.nextCursor).toBeUndefined();
    expect(spy.mock.calls.map(([perPage]) => perPage)).toEqual([
      API_MAX_PER_PAGE,
      50,
    ]);
  });
});
