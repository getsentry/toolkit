/**
 * Multi-account storage tests.
 *
 * Covers storing several logins, switching and removing accounts, selector
 * resolution, and that credential failures never silently move a request
 * onto another stored account.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  accountSelectorOf,
  accountSelectorParts,
  findAccounts,
  getAccountRow,
  getActiveAccountRow,
  isSameServer,
  listAccounts,
  serverKey,
} from "../../../src/lib/db/accounts.js";
import {
  getActiveAccountId,
  getAuthToken,
  getIdentityFingerprint,
  refreshToken,
  removeAccount,
  setActiveAccount,
  setAuthToken,
} from "../../../src/lib/db/auth.js";
import { getDatabase } from "../../../src/lib/db/index.js";
import {
  getCachedIssueOrg,
  setCachedIssueOrg,
} from "../../../src/lib/db/issue-org-cache.js";
import { getUserInfo, setUserInfo } from "../../../src/lib/db/user.js";
import { AuthError, ConfigError } from "../../../src/lib/errors.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as oauth from "../../../src/lib/oauth.js";
import { useEnvSandbox, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("accounts-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
]);

function login(
  token: string,
  host: string,
  user: { userId: string; email?: string; username?: string },
  refresh?: string,
): string {
  const id = setAuthToken(token, refresh ? 3600 : undefined, refresh, {
    host,
    newAccount: true,
  });
  setUserInfo(user);
  return id;
}

describe("storing several accounts", () => {
  test("a new login is added alongside the previous one and becomes active", () => {
    const work = login("work-token", "https://sentry.io", {
      userId: "1",
      email: "work@example.com",
    });
    const personal = login("personal-token", "https://sentry.io", {
      userId: "2",
      email: "personal@example.com",
    });

    expect(listAccounts().map((a) => [a.id, a.active])).toEqual([
      [work, false],
      [personal, true],
    ]);
    expect(getAuthToken()).toBe("personal-token");
    expect(getUserInfo()?.email).toBe("personal@example.com");
  });

  test("an access-token update without newAccount stays on the active account", () => {
    const id = login("first", "https://sentry.example.com", { userId: "1" });

    expect(setAuthToken("second")).toBe(id);
    expect(listAccounts()).toHaveLength(1);
    expect(getAuthToken()).toBe("second");
    expect(getActiveAccountRow()?.host).toBe("https://sentry.example.com");
  });
});

describe("setActiveAccount", () => {
  test("switches the credential, identity, and user info in use", () => {
    const work = login("work-token", "https://sentry.io", {
      userId: "1",
      email: "work@example.com",
    });
    login("personal-token", "https://sentry.io", {
      userId: "2",
      email: "personal@example.com",
    });
    const personalIdentity = getIdentityFingerprint();

    setActiveAccount(work);

    expect(getActiveAccountId()).toBe(work);
    expect(getAuthToken()).toBe("work-token");
    expect(getUserInfo()?.email).toBe("work@example.com");
    expect(getIdentityFingerprint()).not.toBe(personalIdentity);
  });

  test("rejects an unknown account id", () => {
    login("token", "https://sentry.io", { userId: "1" });
    expect(() => setActiveAccount("missing")).toThrow(ConfigError);
  });
});

describe("removeAccount", () => {
  test("removing an inactive account keeps the active one", async () => {
    const work = login("work-token", "https://sentry.io", { userId: "1" });
    const personal = login("personal-token", "https://sentry.io", {
      userId: "2",
    });

    expect(await removeAccount(work)).toBe(personal);
    expect(getAuthToken()).toBe("personal-token");
  });

  test("removing the active account leaves none active unless promoteNext is set", async () => {
    login("work-token", "https://sentry.io", { userId: "1" });
    const personal = login("personal-token", "https://sentry.io", {
      userId: "2",
    });

    expect(await removeAccount(personal)).toBeUndefined();
    expect(getAuthToken()).toBeUndefined();
    expect(listAccounts()).toHaveLength(1);
  });

  test("promoteNext activates the most recently updated remaining account", async () => {
    const work = login("work-token", "https://sentry.io", { userId: "1" });
    const personal = login("personal-token", "https://sentry.io", {
      userId: "2",
    });

    expect(await removeAccount(personal, { promoteNext: true })).toBe(work);
    expect(getAuthToken()).toBe("work-token");
  });

  test("promoteNext follows account switches, not login order", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const a = login("a-token", "https://sentry.io", { userId: "1" });
      vi.setSystemTime(2000);
      const b = login("b-token", "https://sentry.io", { userId: "2" });
      vi.setSystemTime(3000);
      login("c-token", "https://sentry.io", { userId: "3" });
      vi.setSystemTime(4000);
      setActiveAccount(b);
      vi.setSystemTime(5000);
      setActiveAccount(a);

      expect(await removeAccount(a, { promoteNext: true })).toBe(b);
      expect(getAuthToken()).toBe("b-token");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("account changes clear identity-unscoped caches", () => {
  test("a new login drops issue-org mappings from the previous account", () => {
    login("work-token", "https://sentry.io", { userId: "1" });
    setCachedIssueOrg("123", "org-foo");

    login("other-token", "https://sentry.example.com", { userId: "2" });

    expect(getCachedIssueOrg("123")).toBeUndefined();
  });
});

describe("legacy accounts without a host", () => {
  test("switching to one backfills its host before it is used", async () => {
    const { resetEnvTokenHostForTesting } =
      await import("../../../src/lib/env-token-host.js");
    delete process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;
    resetEnvTokenHostForTesting();
    getDatabase()
      .query(
        "INSERT INTO accounts (account_id, token, host, is_active, updated_at) VALUES ('legacy', 'legacy-token', NULL, 0, ?)",
      )
      .run(Date.now());
    login("self-hosted-token", "https://sentry.example.com", { userId: "1" });

    setActiveAccount("legacy");

    expect(getAccountRow("legacy")?.host).toBe("https://sentry.io");
  });
});

describe("credential failures stay on the failing account", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("an expired token without a refresh token is dropped without switching accounts", async () => {
    const work = login("work-token", "https://sentry.io", { userId: "1" });
    const expired = setAuthToken("expired-token", -1, undefined, {
      host: "https://sentry.io",
      newAccount: true,
    });
    setUserInfo({ userId: "2", email: "expired@example.com" });

    await expect(refreshToken()).rejects.toBeInstanceOf(AuthError);

    expect(getActiveAccountId()).toBe(expired);
    expect(getAuthToken()).toBeUndefined();
    const accounts = listAccounts();
    expect(accounts.find((a) => a.id === expired)?.usable).toBe(false);
    expect(accounts.find((a) => a.id === work)?.usable).toBe(true);
    // The account (and who it belongs to) is kept so it can be re-used.
    expect(getUserInfo()?.email).toBe("expired@example.com");
  });

  test("a rejected refresh invalidates only the refreshing account", async () => {
    const work = login("work-token", "https://sentry.io", { userId: "1" });
    const personal = login(
      "personal-token",
      "https://sentry.io",
      { userId: "2" },
      "personal-refresh",
    );
    vi.spyOn(oauth, "refreshAccessToken").mockRejectedValue(
      new AuthError("invalid", "refresh rejected"),
    );

    await expect(refreshToken({ force: true })).rejects.toBeInstanceOf(
      AuthError,
    );

    expect(getActiveAccountId()).toBe(personal);
    expect(getAuthToken()).toBeUndefined();
    setActiveAccount(work);
    expect(getAuthToken()).toBe("work-token");
  });
});

describe("findAccounts", () => {
  test("matches by id, email, username, or user id (case-insensitive)", () => {
    const id = login("token", "https://sentry.io", {
      userId: "42",
      email: "Jane@Example.com",
      username: "jane",
    });

    for (const selector of [id, "jane@example.com", "JANE", "42"]) {
      expect(findAccounts(selector).map((a) => a.id)).toEqual([id]);
    }
    expect(findAccounts("nobody")).toEqual([]);
  });

  test("returns every match for an ambiguous selector and narrows with @host", () => {
    const saas = login("saas", "https://sentry.io", {
      userId: "1",
      email: "jane@example.com",
    });
    const selfHosted = login("self", "https://sentry.example.com", {
      userId: "1",
      email: "jane@example.com",
    });

    expect(findAccounts("jane@example.com")).toHaveLength(2);
    expect(findAccounts("jane@example.com@sentry.io").map((a) => a.id)).toEqual(
      [saas],
    );
    expect(
      findAccounts("jane@example.com@sentry.example.com").map((a) => a.id),
    ).toEqual([selfHosted]);
  });

  test("narrows with <who>:<server>, the notation accountSelectorOf shows", () => {
    const saas = login("saas", "https://sentry.io", {
      userId: "1",
      email: "jane@example.com",
    });
    const selfHosted = login("self", "https://sentry.example.com:9000", {
      userId: "1",
      email: "jane@example.com",
      username: "jane",
    });

    const [saasAccount, selfAccount] = [saas, selfHosted].map((id) =>
      listAccounts().find((a) => a.id === id),
    );
    expect(saasAccount && accountSelectorOf(saasAccount)).toBe(
      "jane@example.com:sentry.io",
    );
    expect(selfAccount && accountSelectorOf(selfAccount)).toBe(
      "jane@example.com:sentry.example.com:9000",
    );
    expect(selfAccount && accountSelectorParts(selfAccount)).toEqual({
      who: "jane@example.com",
      server: "sentry.example.com:9000",
    });
    for (const selector of [
      "jane@example.com:sentry.io",
      "jane@example.com:us.sentry.io",
      "JANE@example.com:https://sentry.io",
    ]) {
      expect(findAccounts(selector).map((a) => a.id)).toEqual([saas]);
    }
    for (const selector of [
      "jane@example.com:sentry.example.com:9000",
      "jane:sentry.example.com:9000",
    ]) {
      expect(findAccounts(selector).map((a) => a.id)).toEqual([selfHosted]);
    }
    expect(findAccounts("jane@example.com:sentry.example.com")).toEqual([]);
  });

  test("an HTTP account's selector keeps its scheme, so it round-trips", () => {
    login("saas", "https://sentry.io", {
      userId: "1",
      email: "jane@example.com",
    });
    const local = login("local", "http://localhost:8000", {
      userId: "1",
      email: "jane@example.com",
    });

    const account = listAccounts().find((a) => a.id === local);
    const selector = account && accountSelectorOf(account);
    expect(selector).toBe("jane@example.com:http://localhost:8000");
    expect(account && accountSelectorParts(account)).toEqual({
      who: "jane@example.com",
      server: "http://localhost:8000",
    });
    expect(findAccounts(selector ?? "").map((a) => a.id)).toEqual([local]);
    // A bare host means HTTPS, which is a different server.
    expect(findAccounts("jane@example.com:localhost:8000")).toEqual([]);
  });
});

describe("serverKey", () => {
  test("is shared by every SaaS origin, and otherwise by the same origin only", () => {
    const groups = [
      [
        "https://sentry.io",
        "https://us.sentry.io",
        "https://de.sentry.io/api/0/",
      ],
      ["https://sentry.example.com", "https://sentry.example.com/path"],
      ["https://sentry.example.com:9000"],
      ["http://sentry.example.com"],
    ];
    const keys = groups.map((urls) => new Set(urls.map(serverKey)));
    for (const set of keys) {
      expect(set.size).toBe(1);
      expect(set.has(undefined)).toBe(false);
    }
    expect(new Set(keys.flatMap((set) => [...set])).size).toBe(groups.length);
    expect(isSameServer("https://us.sentry.io", "https://sentry.io")).toBe(
      true,
    );
    expect(serverKey("not a url")).toBeUndefined();
    expect(isSameServer("not a url", "not a url")).toBe(false);
  });
});
