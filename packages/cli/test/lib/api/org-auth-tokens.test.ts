import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  createOrganizationAuthTokenMock,
  deleteOrganizationAuthTokenMock,
  listOrganizationAuthTokensMock,
} = vi.hoisted(() => ({
  createOrganizationAuthTokenMock: vi.fn(),
  deleteOrganizationAuthTokenMock: vi.fn(),
  listOrganizationAuthTokensMock: vi.fn(),
}));

vi.mock("@sentry/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/api")>();
  return {
    ...actual,
    createOrganizationAuthToken: createOrganizationAuthTokenMock,
    deleteOrganizationAuthToken: deleteOrganizationAuthTokenMock,
    listOrganizationAuthTokens: listOrganizationAuthTokensMock,
  };
});

vi.mock("../../../src/lib/sentry-client.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/lib/sentry-client.js")
  >()),
  getControlSiloUrl: () => "https://sentry.io",
}));

import {
  createOrgAuthToken,
  deleteOrgAuthToken,
  listOrgAuthTokens,
} from "../../../src/lib/api/org-auth-tokens.js";
import { ApiError } from "../../../src/lib/errors.js";

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
    createOrganizationAuthTokenMock.mockReset();
    deleteOrganizationAuthTokenMock.mockReset();
    listOrganizationAuthTokensMock.mockReset();
  });

  test("lists tokens from the control silo", async () => {
    listOrganizationAuthTokensMock.mockResolvedValue({
      data: [token],
      response: new Response(),
    });

    await expect(listOrgAuthTokens("my-org")).resolves.toEqual([token]);
    expect(listOrganizationAuthTokensMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://sentry.io",
        path: { organization_id_or_slug: "my-org" },
      }),
    );
  });

  test("rejects a token list that doesn't match the schema", async () => {
    listOrganizationAuthTokensMock.mockResolvedValue({
      data: [{ id: 7 }],
      response: new Response(),
    });

    await expect(listOrgAuthTokens("my-org")).rejects.toThrow();
  });

  test("creates a token with only a name", async () => {
    createOrganizationAuthTokenMock.mockResolvedValue({
      data: { ...token, token: "sntrys_secret" },
      response: new Response(null, { status: 201 }),
    });

    const created = await createOrgAuthToken("my-org", "ci");
    expect(created.token).toBe("sntrys_secret");
    expect(createOrganizationAuthTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://sentry.io",
        path: { organization_id_or_slug: "my-org" },
        body: { name: "ci" },
      }),
    );
  });

  test("deletes a token by ID", async () => {
    deleteOrganizationAuthTokenMock.mockResolvedValue({
      data: {},
      response: new Response(null, { status: 204 }),
    });

    await deleteOrgAuthToken("my-org", "7");
    expect(deleteOrganizationAuthTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://sentry.io",
        path: { organization_id_or_slug: "my-org", token_id: "7" },
      }),
    );
  });

  test("keeps the HTTP status on errors", async () => {
    deleteOrganizationAuthTokenMock.mockResolvedValue({
      error: { detail: "You do not have permission" },
      response: new Response(null, { status: 403, statusText: "Forbidden" }),
    });

    await expect(deleteOrgAuthToken("my-org", "7")).rejects.toMatchObject({
      name: ApiError.name,
      status: 403,
    });
  });
});
