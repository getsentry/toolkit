/**
 * Logout Command Tests
 *
 * Tests for the logoutCommand func() in src/commands/auth/logout.ts against a
 * real test database: single-account logout, multi-account logout (active,
 * by selector, --all), and the env-token-aware branches.
 *
 * Success output goes to stdout via the rendering pipeline; error cases throw
 * typed errors (AuthError, ResolutionError).
 */

import { describe, expect, test, vi } from "vitest";
import { logoutCommand } from "../../../src/commands/auth/logout.js";
import { listAccounts } from "../../../src/lib/db/accounts.js";
import { getAuthToken, setAuthToken } from "../../../src/lib/db/auth.js";
import { getDefaultUrl, setDefaultUrl } from "../../../src/lib/db/defaults.js";
import { getDbPath } from "../../../src/lib/db/index.js";
import { setUserInfo } from "../../../src/lib/db/user.js";
import { AuthError, ResolutionError } from "../../../src/lib/errors.js";
import { useEnvSandbox, useTestConfigDir } from "../../helpers.js";

type LogoutFunc = (
  this: unknown,
  flags: { url?: string },
  ...selectors: string[]
) => Promise<void>;

useTestConfigDir("auth-logout-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
]);

function createContext() {
  const stdoutChunks: string[] = [];
  return {
    context: {
      stdout: {
        write: vi.fn((s: string) => {
          stdoutChunks.push(s);
        }),
      },
      stderr: {
        write: vi.fn((_s: string) => {
          /* captured by mock */
        }),
      },
      cwd: "/tmp",
    },
    getOutput: () => stdoutChunks.join(""),
  };
}

async function loadFunc(): Promise<LogoutFunc> {
  return (await logoutCommand.loader()) as unknown as LogoutFunc;
}

function addAccount(
  token: string,
  host: string,
  user: { userId: string; email: string },
): void {
  setAuthToken(token, undefined, undefined, { host, newAccount: true });
  setUserInfo(user);
}

describe("logoutCommand.func", () => {
  test("not authenticated: returns loggedOut false with message", async () => {
    const func = await loadFunc();
    const { context, getOutput } = createContext();

    await func.call(context, {});

    expect(getOutput()).toContain("Not currently authenticated");
  });

  test("single stored account: removes it and reports the config path", async () => {
    addAccount("only-token", "https://sentry.io", {
      userId: "1",
      email: "me@example.com",
    });
    const func = await loadFunc();
    const { context, getOutput } = createContext();

    await func.call(context, {});

    expect(listAccounts()).toEqual([]);
    expect(getAuthToken()).toBeUndefined();
    expect(getOutput()).toContain("Logged out of me@example.com");
    expect(getOutput()).toContain(getDbPath());
  });

  test("env token only (SENTRY_AUTH_TOKEN): throws AuthError with env var message", async () => {
    process.env.SENTRY_AUTH_TOKEN = "sntrys_env_123";
    const func = await loadFunc();
    const { context } = createContext();

    const error = await func.call(context, {}).catch((e) => e);

    expect(error).toBeInstanceOf(AuthError);
    const msg = (error as AuthError).message;
    expect(msg).toContain("SENTRY_AUTH_TOKEN");
    expect(msg).toContain("environment variable");
    expect(msg).toContain("Unset");
  });

  test("env token only (SENTRY_TOKEN): shows correct env var name in error", async () => {
    process.env.SENTRY_TOKEN = "sntrys_token_456";
    const func = await loadFunc();
    const { context } = createContext();

    const error = await func.call(context, {}).catch((e) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toContain("SENTRY_TOKEN");
  });

  test("stored OAuth with env var set: removes stored account (env var still present)", async () => {
    process.env.SENTRY_AUTH_TOKEN = "sntrys_env_123";
    addAccount("stored-token", "https://sentry.io", {
      userId: "1",
      email: "me@example.com",
    });
    const func = await loadFunc();
    const { context, getOutput } = createContext();

    await func.call(context, {});

    expect(listAccounts()).toEqual([]);
    expect(getOutput()).toContain("Logged out of");
  });
});

describe("logoutCommand.func with several accounts", () => {
  test("logs out of the active account and activates the most recent remaining one", async () => {
    addAccount("work-token", "https://sentry.io", {
      userId: "1",
      email: "work@example.com",
    });
    addAccount("personal-token", "https://sentry.io", {
      userId: "2",
      email: "personal@example.com",
    });
    const func = await loadFunc();
    const { context, getOutput } = createContext();

    await func.call(context, {});

    const remaining = listAccounts();
    expect(remaining.map((a) => a.email)).toEqual(["work@example.com"]);
    expect(remaining[0]?.active).toBe(true);
    expect(getAuthToken()).toBe("work-token");
    expect(getOutput()).toContain("Now using: work@example.com on sentry.io");
  });

  test("logging out of a self-hosted account points the default URL at the next account", async () => {
    addAccount("saas-token", "https://sentry.io", {
      userId: "1",
      email: "saas@example.com",
    });
    addAccount("self-token", "https://sentry.example.com", {
      userId: "1",
      email: "self@example.com",
    });
    setDefaultUrl("https://sentry.example.com");
    const func = await loadFunc();
    const { context } = createContext();

    await func.call(context, {});

    expect(getAuthToken()).toBe("saas-token");
    expect(getDefaultUrl()).toBeNull();
  });

  test("logs out of a named account without changing the active one", async () => {
    addAccount("work-token", "https://sentry.io", {
      userId: "1",
      email: "work@example.com",
    });
    addAccount("personal-token", "https://sentry.io", {
      userId: "2",
      email: "personal@example.com",
    });
    const func = await loadFunc();
    const { context } = createContext();

    await func.call(context, {}, "work@example.com");

    expect(listAccounts().map((a) => a.email)).toEqual([
      "personal@example.com",
    ]);
    expect(getAuthToken()).toBe("personal-token");
  });

  test("unknown account selector throws ResolutionError", async () => {
    addAccount("work-token", "https://sentry.io", {
      userId: "1",
      email: "work@example.com",
    });
    const func = await loadFunc();
    const { context } = createContext();

    await expect(
      func.call(context, {}, "nobody@example.com"),
    ).rejects.toBeInstanceOf(ResolutionError);
    expect(listAccounts()).toHaveLength(1);
  });

  test("'all' removes every stored account", async () => {
    addAccount("work-token", "https://sentry.io", {
      userId: "1",
      email: "work@example.com",
    });
    addAccount("self-token", "https://sentry.example.com", {
      userId: "1",
      email: "work@example.com",
    });
    const func = await loadFunc();
    const { context, getOutput } = createContext();

    await func.call(context, {}, "all");

    expect(listAccounts()).toEqual([]);
    expect(getAuthToken()).toBeUndefined();
    expect(getOutput()).toContain("Logged out of all 2 accounts");
  });

  test("logs out of several comma- or space-separated accounts", async () => {
    addAccount("a-token", "https://sentry.io", {
      userId: "1",
      email: "a@example.com",
    });
    addAccount("b-token", "https://sentry.io", {
      userId: "2",
      email: "b@example.com",
    });
    addAccount("c-token", "https://sentry.io", {
      userId: "3",
      email: "c@example.com",
    });
    const func = await loadFunc();
    const { context, getOutput } = createContext();

    await func.call(context, {}, "a@example.com,c@example.com");

    expect(listAccounts().map((a) => a.email)).toEqual(["b@example.com"]);
    expect(getAuthToken()).toBe("b-token");
    expect(getOutput()).toContain("Logged out of 2 accounts");

    addAccount("d-token", "https://sentry.io", {
      userId: "4",
      email: "d@example.com",
    });
    await func.call(context, {}, "b@example.com", "d@example.com");
    expect(listAccounts()).toEqual([]);
  });

  test("--url picks the account on that server when an email is stored twice", async () => {
    addAccount("saas-token", "https://sentry.io", {
      userId: "1",
      email: "jane@example.com",
    });
    addAccount("self-token", "https://sentry.example.com", {
      userId: "1",
      email: "jane@example.com",
    });
    const func = await loadFunc();
    const { context } = createContext();

    await expect(
      func.call(context, {}, "jane@example.com"),
    ).rejects.toBeInstanceOf(ResolutionError);

    await func.call(
      context,
      { url: "https://sentry.example.com" },
      "jane@example.com",
    );

    expect(listAccounts().map((a) => a.host)).toEqual(["https://sentry.io"]);
  });

  test("does not log out of a fuzzy match, only suggests it", async () => {
    addAccount("work-token", "https://sentry.io", {
      userId: "1",
      email: "work@example.com",
    });
    const func = await loadFunc();
    const { context } = createContext();

    const error = await func.call(context, {}, "work").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResolutionError);
    expect(String((error as Error).message)).toContain(
      "Did you mean work@example.com",
    );
    expect(listAccounts()).toHaveLength(1);
  });
});
