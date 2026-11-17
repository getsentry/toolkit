import { beforeEach, describe, expect, test, vi } from "vitest";

const { retrieveApiIndexMock } = vi.hoisted(() => ({
  retrieveApiIndexMock: vi.fn(),
}));

vi.mock("@sentry/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/api")>()),
  retrieveApiIndex: retrieveApiIndexMock,
}));

vi.mock("../../../src/lib/sentry-client.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/lib/sentry-client.js")
  >()),
  getControlSiloUrl: () => "https://sentry.io",
}));

import { getCurrentAuthScopes } from "../../../src/lib/api/auth.js";
import { ApiError } from "../../../src/lib/errors.js";

describe("getCurrentAuthScopes", () => {
  beforeEach(() => retrieveApiIndexMock.mockReset());

  test("reads effective token scopes from the API index", async () => {
    retrieveApiIndexMock.mockResolvedValue({
      data: {
        version: "0",
        auth: { scopes: ["org:read", "team:admin"] },
        user: null,
      },
      response: new Response(),
    });

    await expect(getCurrentAuthScopes()).resolves.toEqual([
      "org:read",
      "team:admin",
    ]);
    expect(retrieveApiIndexMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://sentry.io" }),
    );
  });

  test("returns null when the API index reports no authenticated token", async () => {
    retrieveApiIndexMock.mockResolvedValue({
      data: { version: "0", auth: null, user: null },
      response: new Response(),
    });

    await expect(getCurrentAuthScopes()).resolves.toBeNull();
  });

  test("reports a 401 from an invalid bearer as an ApiError", async () => {
    retrieveApiIndexMock.mockResolvedValue({
      error: { detail: "Invalid token" },
      response: new Response(null, { status: 401 }),
    });

    const thrown = await getCurrentAuthScopes().catch((error) => error);
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown).toMatchObject({ status: 401 });
  });
});
