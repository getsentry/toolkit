import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../src/lib/api/infrastructure.js", () => ({
  apiRequestToRegion: vi.fn(),
  apiRequestToRegionNoContent: vi.fn(),
}));

vi.mock("../../../src/lib/sentry-client.js", () => ({
  getControlSiloUrl: () => "https://sentry.io",
}));

import {
  apiRequestToRegion,
  apiRequestToRegionNoContent,
} from "../../../src/lib/api/infrastructure.js";
import {
  createOrgAuthToken,
  deleteOrgAuthToken,
  listOrgAuthTokens,
} from "../../../src/lib/api/org-auth-tokens.js";

const token = {
  id: "7",
  name: "ci",
  scopes: ["org:ci"],
  tokenLastCharacters: "abcd",
  dateCreated: "2026-01-01T00:00:00Z",
  dateLastUsed: null,
};

describe("org auth token API", () => {
  beforeEach(() => {
    vi.mocked(apiRequestToRegion).mockReset();
    vi.mocked(apiRequestToRegionNoContent).mockReset();
  });

  test("lists tokens from the control silo", async () => {
    vi.mocked(apiRequestToRegion).mockResolvedValue({
      data: [token],
      headers: new Headers(),
    });

    await expect(listOrgAuthTokens("my-org")).resolves.toEqual([token]);
    expect(apiRequestToRegion).toHaveBeenCalledWith(
      "https://sentry.io",
      "/organizations/my-org/org-auth-tokens/",
      expect.objectContaining({ schema: expect.any(Object) }),
    );
  });

  test("creates a token with only a name", async () => {
    vi.mocked(apiRequestToRegion).mockResolvedValue({
      data: { ...token, token: "sntrys_secret" },
      headers: new Headers(),
    });

    const created = await createOrgAuthToken("my-org", "ci");
    expect(created.token).toBe("sntrys_secret");
    expect(apiRequestToRegion).toHaveBeenCalledWith(
      "https://sentry.io",
      "/organizations/my-org/org-auth-tokens/",
      expect.objectContaining({ method: "POST", body: { name: "ci" } }),
    );
  });

  test("deletes a token by ID", async () => {
    vi.mocked(apiRequestToRegionNoContent).mockResolvedValue();

    await deleteOrgAuthToken("my-org", "7");
    expect(apiRequestToRegionNoContent).toHaveBeenCalledWith(
      "https://sentry.io",
      "/organizations/my-org/org-auth-tokens/7/",
      { method: "DELETE" },
    );
  });
});
