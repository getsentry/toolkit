import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../src/lib/api/infrastructure.js", () => ({
  apiRequestToRegion: vi.fn(),
}));

import { getCurrentAuthScopes } from "../../../src/lib/api/auth.js";
import { apiRequestToRegion } from "../../../src/lib/api/infrastructure.js";

describe("getCurrentAuthScopes", () => {
  beforeEach(() => vi.mocked(apiRequestToRegion).mockReset());

  test("reads effective token scopes from the API index", async () => {
    vi.mocked(apiRequestToRegion).mockResolvedValue({
      data: { auth: { scopes: ["org:read", "team:admin"] } },
      headers: new Headers(),
    });

    await expect(getCurrentAuthScopes()).resolves.toEqual([
      "org:read",
      "team:admin",
    ]);
    expect(apiRequestToRegion).toHaveBeenCalledWith(
      expect.any(String),
      "",
      expect.objectContaining({ schema: expect.any(Object) })
    );
  });

  test("returns null when the API index reports no authenticated token", async () => {
    vi.mocked(apiRequestToRegion).mockResolvedValue({
      data: { auth: null },
      headers: new Headers(),
    });

    await expect(getCurrentAuthScopes()).resolves.toBeNull();
  });

  test("preserves a 401 from an invalid bearer", async () => {
    const error = new Error("401 Unauthorized");
    vi.mocked(apiRequestToRegion).mockImplementationOnce(async () => {
      throw error;
    });

    let thrown: unknown;
    try {
      await getCurrentAuthScopes();
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBe(error);
  });
});
