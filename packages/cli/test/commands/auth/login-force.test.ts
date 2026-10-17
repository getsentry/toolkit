/**
 * `sentry auth login --force --token` against a real test database: the
 * stored login for the token's server is replaced only once the new token
 * checks out, and accounts on other servers are never touched.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";

const { loginCommand } = await import("../../../src/commands/auth/login.js");

import { listAccounts } from "../../../src/lib/db/accounts.js";
import {
  getActiveAccountId,
  getAuthToken,
  setAuthToken,
} from "../../../src/lib/db/auth.js";
import { getDatabase } from "../../../src/lib/db/index.js";
import { getUserInfo, setUserInfo } from "../../../src/lib/db/user.js";
import { ApiError, AuthError } from "../../../src/lib/errors.js";
import { useEnvSandbox, useTestConfigDir } from "../../helpers.js";

type LoginFunc = (
  this: unknown,
  flags: { token?: string; force: boolean; timeout: number; url?: string },
  email?: string,
) => Promise<void>;

useTestConfigDir("auth-login-force-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
]);

const SAAS = "https://sentry.io";
const ACME = "https://sentry.acme.com";

function createContext() {
  return {
    stdout: { write: vi.fn(() => true) },
    stderr: { write: vi.fn(() => true) },
    cwd: "/tmp",
  };
}

function addAccount(
  token: string,
  userId: string,
  email: string,
  username?: string,
): string {
  const id = setAuthToken(token, undefined, undefined, {
    host: SAAS,
    newAccount: true,
  });
  setUserInfo({ userId, email, username });
  return id;
}

describe("login --force --token", () => {
  let func: LoginFunc;

  beforeEach(async () => {
    vi.spyOn(apiClient, "listOrganizationsUncached").mockResolvedValue([]);
    func = (await loginCommand.loader()) as unknown as LoginFunc;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a rejected token keeps the active account and its credentials", async () => {
    const other = addAccount("other-token", "1", "other@example.com");
    const active = addAccount("old-token", "2", "jane@example.com");
    vi.spyOn(apiClient, "getUserRegions").mockRejectedValue(
      new ApiError("Unauthorized", 401),
    );

    await expect(
      func.call(createContext(), {
        token: "bad-token",
        force: true,
        timeout: 900,
      }),
    ).rejects.toBeInstanceOf(AuthError);

    expect(getActiveAccountId()).toBe(active);
    expect(getAuthToken()).toBe("old-token");
    expect(getUserInfo()?.email).toBe("jane@example.com");
    expect(listAccounts().map((a) => a.id)).toEqual([other, active]);
  });

  test("a valid token replaces the active account with the new identity", async () => {
    const other = addAccount("other-token", "1", "other@example.com");
    addAccount("old-token", "2", "jane@example.com");
    vi.spyOn(apiClient, "getUserRegions").mockResolvedValue([]);
    vi.spyOn(apiClient, "getCurrentUser").mockResolvedValue({
      id: "3",
      email: "bob@example.com",
    });

    await func.call(createContext(), {
      token: "new-token",
      force: true,
      timeout: 900,
    });

    expect(getAuthToken()).toBe("new-token");
    expect(getUserInfo()?.email).toBe("bob@example.com");
    expect(listAccounts().map((a) => [a.id === other, a.email])).toEqual([
      [true, "other@example.com"],
      [false, "bob@example.com"],
    ]);
  });

  test("--url for another server keeps the active account and adds one there", async () => {
    const saas = addAccount("saas-token", "1", "jane@example.com");
    vi.spyOn(apiClient, "getUserRegions").mockResolvedValue([]);
    vi.spyOn(apiClient, "getCurrentUser").mockResolvedValue({
      id: "7",
      email: "jane@acme.com",
    });

    await func.call(createContext(), {
      token: "acme-token",
      force: true,
      timeout: 900,
      url: ACME,
    });

    expect(listAccounts().map((a) => [a.id === saas, a.email, a.host])).toEqual(
      [
        [true, "jane@example.com", SAAS],
        [false, "jane@acme.com", ACME],
      ],
    );
  });

  test("--url replaces that server's stored login, not the active account", async () => {
    const acme = setAuthToken("old-acme-token", undefined, undefined, {
      host: ACME,
      newAccount: true,
    });
    setUserInfo({ userId: "7", email: "jane@acme.com" });
    const saas = addAccount("saas-token", "1", "jane@example.com");
    vi.spyOn(apiClient, "getUserRegions").mockResolvedValue([]);
    vi.spyOn(apiClient, "getCurrentUser").mockResolvedValue({
      id: "8",
      email: "bob@acme.com",
    });

    await func.call(createContext(), {
      token: "new-acme-token",
      force: true,
      timeout: 900,
      url: ACME,
    });

    const accounts = listAccounts();
    expect(accounts.map((a) => [a.id === saas, a.email, a.host])).toEqual([
      [true, "jane@example.com", SAAS],
      [false, "bob@acme.com", ACME],
    ]);
    expect(accounts.some((a) => a.id === acme)).toBe(false);
  });

  test("a transient validation failure keeps the previous account active", async () => {
    const active = addAccount("old-token", "2", "jane@example.com");
    const cause = new ApiError("Server error", 503);
    vi.spyOn(apiClient, "getUserRegions").mockRejectedValue(cause);

    // `--force`, and adding an account by naming it (no re-auth prompt).
    for (const [force, email] of [
      [true, undefined],
      [false, "bob@example.com"],
    ] as const) {
      await expect(
        func.call(
          createContext(),
          { token: "maybe-good", force, timeout: 900 },
          email,
        ),
      ).rejects.toBe(cause);

      expect(getActiveAccountId()).toBe(active);
      expect(getAuthToken()).toBe("old-token");
      expect(listAccounts().map((a) => a.id)).toEqual([active]);
    }
  });

  test("a transient validation failure with no other account keeps the token", async () => {
    const cause = new ApiError("Server error", 503);
    vi.spyOn(apiClient, "getUserRegions").mockRejectedValue(cause);

    await expect(
      func.call(createContext(), {
        token: "maybe-good",
        force: true,
        timeout: 900,
      }),
    ).rejects.toBe(cause);

    expect(getAuthToken()).toBe("maybe-good");
  });

  test("a transient failure keeps the token when the previous account can't authenticate", async () => {
    const stale = addAccount("old-token", "2", "jane@example.com");
    getDatabase()
      .query("UPDATE accounts SET token = NULL WHERE account_id = ?")
      .run(stale);
    const cause = new ApiError("Server error", 503);
    vi.spyOn(apiClient, "getUserRegions").mockRejectedValue(cause);

    await expect(
      func.call(createContext(), {
        token: "maybe-good",
        force: true,
        timeout: 900,
      }),
    ).rejects.toBe(cause);

    expect(getAuthToken()).toBe("maybe-good");
  });

  test("re-login as the same user keeps the known username", async () => {
    addAccount("old-token", "2", "jane@example.com", "jane");
    vi.spyOn(apiClient, "getUserRegions").mockResolvedValue([]);
    vi.spyOn(apiClient, "getCurrentUser").mockResolvedValue({
      id: "2",
      email: "jane@example.com",
    });

    await func.call(createContext(), {
      token: "new-token",
      force: true,
      timeout: 900,
    });

    expect(getAuthToken()).toBe("new-token");
    expect(listAccounts().map((a) => a.username)).toEqual(["jane"]);
  });

  test("never shows the previous user when the new user can't be fetched", async () => {
    addAccount("old-token", "2", "jane@example.com");
    vi.spyOn(apiClient, "getUserRegions").mockResolvedValue([]);
    vi.spyOn(apiClient, "getCurrentUser").mockRejectedValue(
      new Error("network down"),
    );

    await func.call(createContext(), {
      token: "new-token",
      force: true,
      timeout: 900,
    });

    expect(getAuthToken()).toBe("new-token");
    expect(getUserInfo()).toBeUndefined();
    expect(listAccounts()).toHaveLength(1);
  });
});
