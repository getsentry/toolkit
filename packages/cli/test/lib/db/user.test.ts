/**
 * User Info Storage Tests
 */

import { beforeEach, describe, expect, test } from "vitest";
import { listAccounts } from "../../../src/lib/db/accounts.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { getDatabase } from "../../../src/lib/db/index.js";
import {
  clearUserInfo,
  getUserInfo,
  setUserInfo,
} from "../../../src/lib/db/user.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("test-user-");

describe("getUserInfo", () => {
  test("returns undefined when no user info stored", () => {
    const result = getUserInfo();
    expect(result).toBeUndefined();
  });

  test("returns undefined when the active account has no user yet", () => {
    setAuthToken("token");
    expect(getUserInfo()).toBeUndefined();
  });

  test("returns stored user info", () => {
    setAuthToken("token");
    setUserInfo({
      userId: "12345",
      email: "test@example.com",
      username: "testuser",
    });

    const result = getUserInfo();
    expect(result).toEqual({
      userId: "12345",
      email: "test@example.com",
      username: "testuser",
      name: undefined,
    });
  });

  test("returns stored user info with name", () => {
    setAuthToken("token");
    setUserInfo({
      userId: "12345",
      email: "test@example.com",
      username: "testuser",
      name: "Test User",
    });

    const result = getUserInfo();
    expect(result).toEqual({
      userId: "12345",
      email: "test@example.com",
      username: "testuser",
      name: "Test User",
    });
  });

  test("handles missing email, username, and name", () => {
    setAuthToken("token");
    setUserInfo({ userId: "12345" });

    const result = getUserInfo();
    expect(result).toEqual({
      userId: "12345",
      email: undefined,
      username: undefined,
      name: undefined,
    });
  });
});

describe("setUserInfo", () => {
  beforeEach(() => {
    setAuthToken("token");
  });
  test("stores user info with all fields", () => {
    setUserInfo({
      userId: "user123",
      email: "user@test.com",
      username: "myuser",
      name: "My User",
    });

    const result = getUserInfo();
    expect(result?.userId).toBe("user123");
    expect(result?.email).toBe("user@test.com");
    expect(result?.username).toBe("myuser");
    expect(result?.name).toBe("My User");
  });

  test("overwrites existing user info", () => {
    setUserInfo({ userId: "first", email: "first@test.com", name: "First" });
    setUserInfo({ userId: "second", email: "second@test.com", name: "Second" });

    const result = getUserInfo();
    expect(result?.userId).toBe("second");
    expect(result?.email).toBe("second@test.com");
    expect(result?.name).toBe("Second");
  });

  test("stores user info with only userId", () => {
    setUserInfo({ userId: "minimal" });

    const result = getUserInfo();
    expect(result?.userId).toBe("minimal");
    expect(result?.email).toBeUndefined();
    expect(result?.username).toBeUndefined();
    expect(result?.name).toBeUndefined();
  });

  test("stores user info with name but no username", () => {
    setUserInfo({
      userId: "user456",
      email: "user@test.com",
      name: "Display Name",
    });

    const result = getUserInfo();
    expect(result?.userId).toBe("user456");
    expect(result?.email).toBe("user@test.com");
    expect(result?.username).toBeUndefined();
    expect(result?.name).toBe("Display Name");
  });
});

describe("setUserInfo with several stored accounts", () => {
  test("is a no-op when no account is active", () => {
    setUserInfo({ userId: "nobody" });
    expect(listAccounts()).toEqual([]);
  });

  test("records user info on the active account only", () => {
    setAuthToken("first", undefined, undefined, {
      host: "https://sentry.io",
    });
    setUserInfo({ userId: "1", email: "one@example.com" });
    setAuthToken("second", undefined, undefined, {
      host: "https://sentry.io",
      newAccount: true,
    });
    setUserInfo({ userId: "2", email: "two@example.com" });

    expect(
      listAccounts().map((a) => ({ email: a.email, active: a.active })),
    ).toEqual([
      { email: "one@example.com", active: false },
      { email: "two@example.com", active: true },
    ]);
  });

  test("folds a re-login of the same user on the same host into one account", () => {
    setAuthToken("old", undefined, undefined, { host: "https://sentry.io" });
    setUserInfo({ userId: "1", email: "one@example.com" });
    setAuthToken("new", undefined, undefined, {
      host: "https://sentry.io",
      newAccount: true,
    });
    setUserInfo({ userId: "1", email: "one@example.com" });

    const accounts = listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.active).toBe(true);
  });

  test("keeps the stored username when an OAuth re-login reports none", () => {
    setAuthToken("old", undefined, undefined, { host: "https://sentry.io" });
    setUserInfo({ userId: "1", email: "one@example.com", username: "one" });
    setAuthToken("new", undefined, undefined, {
      host: "https://sentry.io",
      newAccount: true,
    });
    setUserInfo({ userId: "1", email: "one@example.com" });

    expect(listAccounts().map((a) => a.username)).toEqual(["one"]);
  });

  test("folds a re-login on another SaaS region into one account", () => {
    setAuthToken("old", undefined, undefined, { host: "https://sentry.io" });
    setUserInfo({ userId: "1", email: "one@example.com" });
    setAuthToken("new", undefined, undefined, {
      host: "https://us.sentry.io",
      newAccount: true,
    });
    setUserInfo({ userId: "1", email: "one@example.com" });

    expect(listAccounts().map((a) => a.host)).toEqual(["https://us.sentry.io"]);
  });

  test("keeps the same user id on different hosts as separate accounts", () => {
    setAuthToken("saas", undefined, undefined, { host: "https://sentry.io" });
    setUserInfo({ userId: "1" });
    setAuthToken("self-hosted", undefined, undefined, {
      host: "https://sentry.example.com",
      newAccount: true,
    });
    setUserInfo({ userId: "1" });

    expect(listAccounts().map((a) => a.host)).toEqual([
      "https://sentry.io",
      "https://sentry.example.com",
    ]);
  });
});

describe("identity writes and the refresh version", () => {
  function updatedAt(): number | undefined {
    const row = getDatabase()
      .query("SELECT updated_at FROM accounts WHERE is_active = 1")
      .get() as { updated_at: number } | null;
    return row?.updated_at;
  }

  test("setUserInfo leaves updated_at alone so in-flight refreshes still save", () => {
    setAuthToken("token", 3600, "refresh");
    getDatabase().query("UPDATE accounts SET updated_at = 1").run();

    setUserInfo({ userId: "1", email: "one@example.com" });

    expect(updatedAt()).toBe(1);
  });

  test("clearUserInfo forgets the identity and leaves updated_at alone", () => {
    setAuthToken("token");
    setUserInfo({ userId: "1", email: "one@example.com", username: "one" });
    getDatabase().query("UPDATE accounts SET updated_at = 1").run();

    clearUserInfo();

    expect(getUserInfo()).toBeUndefined();
    expect(updatedAt()).toBe(1);
  });
});
