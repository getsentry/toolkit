import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  ApiAuthenticationError,
  ApiNotFoundError,
  createApiError,
} from "../../api-client";
import { UserInputError } from "../../errors";
import type { ServerContext } from "../../types";
import {
  apiServiceFromContext,
  handleApiError,
  withApiErrorHandling,
} from "./api";

describe("apiServiceFromContext", () => {
  afterEach(() => mswServer.resetHandlers());

  function contextWithCache(
    overrides: Partial<ServerContext> = {},
  ): ServerContext & {
    responseCache: NonNullable<ServerContext["responseCache"]>;
  } {
    return {
      accessToken: "token",
      constraints: {},
      responseCache: {
        identity: "identity-a",
        cache: {
          lookup: vi.fn(async () => undefined),
          store: vi.fn(async () => {}),
          invalidate: vi.fn(async () => {}),
        },
      },
      ...overrides,
    };
  }

  function mockAuth() {
    mswServer.use(
      http.get("https://sentry.io/api/0/auth/", () =>
        HttpResponse.json({ id: "1", name: "User", email: "a@x.io" }),
      ),
    );
  }

  it("uses the context's response cache", async () => {
    mockAuth();
    const context = contextWithCache();
    await apiServiceFromContext(context).getAuthenticatedUser();
    expect(context.responseCache.cache.lookup).toHaveBeenCalled();
  });

  it("drops the response cache when a credential router swaps tokens", async () => {
    mockAuth();
    const context = contextWithCache({
      credentialRouter: {
        resolve: vi.fn(),
        list: vi.fn(),
      },
    });
    await apiServiceFromContext(context).getAuthenticatedUser();
    expect(context.responseCache.cache.lookup).not.toHaveBeenCalled();
  });
});

describe("handleApiError", () => {
  it("converts 404 errors with params to list all parameters", () => {
    const error = new ApiNotFoundError("Not Found");

    expect(() =>
      handleApiError(error, {
        organizationSlug: "my-org",
        issueId: "PROJ-123",
      }),
    ).toThrow(UserInputError);

    expect(() =>
      handleApiError(error, {
        organizationSlug: "my-org",
        issueId: "PROJ-123",
      }),
    ).toThrow(
      "Resource not found (404): Not Found\nPlease verify these parameters are correct:\n  - organizationSlug: 'my-org'\n  - issueId: 'PROJ-123'",
    );
  });

  it("converts 404 errors with multiple params including nullish values", () => {
    const error = new ApiNotFoundError("Not Found");

    expect(() =>
      handleApiError(error, {
        organizationSlug: "my-org",
        projectSlug: "my-project",
        query: undefined,
        sortBy: null,
        limit: 0,
        emptyString: "",
      }),
    ).toThrow(
      "Resource not found (404): Not Found\nPlease verify these parameters are correct:\n  - organizationSlug: 'my-org'\n  - projectSlug: 'my-project'\n  - limit: '0'",
    );
  });

  it("converts 404 errors with no params to generic message", () => {
    const error = new ApiNotFoundError("Not Found");

    expect(() => handleApiError(error, {})).toThrow(
      "API error (404): Not Found",
    );
  });

  it("converts 400 errors to UserInputError", () => {
    const error = createApiError("Invalid parameters", 400);

    expect(() => handleApiError(error)).toThrow(UserInputError);

    expect(() => handleApiError(error)).toThrow(
      "API error (400): Invalid parameters",
    );
  });

  it("converts 403 errors to UserInputError with access message", () => {
    const error = createApiError("Forbidden", 403);

    expect(() => handleApiError(error)).toThrow("API error (403): Forbidden");
  });

  it("re-throws non-API errors unchanged", () => {
    const error = new Error("Network error");

    expect(() => handleApiError(error)).toThrow(error);
  });

  it("re-throws 401 errors unchanged (not UserInputError)", () => {
    const error = new ApiAuthenticationError("Unauthorized");

    expect(() => handleApiError(error)).toThrow(ApiAuthenticationError);
    expect(() => handleApiError(error)).not.toThrow(UserInputError);
  });
});

describe("withApiErrorHandling", () => {
  it("returns successful results unchanged", async () => {
    const result = await withApiErrorHandling(
      async () => ({ id: "123", title: "Test Issue" }),
      { issueId: "PROJ-123" },
    );

    expect(result).toEqual({ id: "123", title: "Test Issue" });
  });

  it("handles errors through handleApiError", async () => {
    const error = new ApiNotFoundError("Not Found");

    await expect(
      withApiErrorHandling(
        async () => {
          throw error;
        },
        {
          organizationSlug: "my-org",
          issueId: "PROJ-123",
        },
      ),
    ).rejects.toThrow(
      "Resource not found (404): Not Found\nPlease verify these parameters are correct:\n  - organizationSlug: 'my-org'\n  - issueId: 'PROJ-123'",
    );
  });
});
