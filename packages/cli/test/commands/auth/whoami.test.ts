/**
 * Whoami Command Tests
 *
 * Tests for the whoamiCommand func() in src/commands/auth/whoami.ts.
 * Uses spyOn to mock api-client, db/auth, and db/user to cover all
 * branches without real HTTP calls or database access.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { whoamiCommand } from "../../../src/commands/auth/whoami.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";

vi.mock("../../../src/lib/db/auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/db/auth.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as dbAuth from "../../../src/lib/db/auth.js";

vi.mock("../../../src/lib/db/user.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/db/user.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as dbUser from "../../../src/lib/db/user.js";
import {
  AuthError,
  CliError,
  ResolutionError,
} from "../../../src/lib/errors.js";
import { mintSntrysToken } from "../../helpers.js";

type WhoamiFlags = { readonly json: boolean };

/** Command function type extracted from loader result */
type WhoamiFunc = (this: unknown, flags: WhoamiFlags) => Promise<void>;

const FULL_USER = {
  id: "42",
  name: "Jane Doe",
  username: "janedoe",
  email: "jane@example.com",
};

const EMAIL_ONLY_USER = {
  id: "99",
  email: "anon@example.com",
};

const ID_ONLY_USER = {
  id: "7",
};

/**
 * OAuth-style token used when the test doesn't care about token type and
 * just needs `getAuthToken()` to return something non-org/non-user-PAT.
 */
const OAUTH_TOKEN = "17faa5dfa5e64d5a9b3e8bf7c4d5e6f7a8b9c0d1e2f3a4b567ee";

/** Well-formed sntrys_ token with parseable claim. */
const ORG_TOKEN = mintSntrysToken({
  iat: 1_700_000_000,
  url: "https://sentry.acme.com",
  region_url: "https://us.sentry.acme.com",
  org: "acme",
});

/** Well-formed sntrys_ token without org field (older tokens). */
const ORG_TOKEN_NO_ORG = mintSntrysToken({
  iat: 1_700_000_000,
  url: "https://sentry.io",
  region_url: "https://us.sentry.io",
});

/** sntrys_ token whose claim lacks iat — parseSntrysClaim returns undefined. */
const MALFORMED_ORG_TOKEN = mintSntrysToken({
  url: "https://sentry.acme.com",
  org: "acme",
});

function createContext() {
  const output: string[] = [];
  const context = {
    stdout: {
      write: vi.fn((s: string) => {
        output.push(s);
      }),
    },
    stderr: {
      write: vi.fn((_s: string) => {
        /* no-op */
      }),
    },
    cwd: "/tmp",
  };
  const getOutput = () => output.join("");
  return { context, getOutput };
}

describe("whoamiCommand.func", () => {
  let isAuthenticatedSpy: ReturnType<typeof spyOn>;
  let getAuthTokenSpy: ReturnType<typeof spyOn>;
  let getCurrentUserSpy: ReturnType<typeof spyOn>;
  let setUserInfoSpy: ReturnType<typeof spyOn>;
  let func: WhoamiFunc;

  beforeEach(async () => {
    isAuthenticatedSpy = vi.spyOn(dbAuth, "isAuthenticated");
    getAuthTokenSpy = vi.spyOn(dbAuth, "getAuthToken");
    getCurrentUserSpy = vi.spyOn(apiClient, "getCurrentUser");
    setUserInfoSpy = vi.spyOn(dbUser, "setUserInfo");
    // Default token type: OAuth (not org, not PAT). Tests that need a
    // different type override this mock within their own block.
    getAuthTokenSpy.mockReturnValue(OAUTH_TOKEN);
    func = (await whoamiCommand.loader()) as unknown as WhoamiFunc;
  });

  afterEach(() => {
    isAuthenticatedSpy.mockRestore();
    getAuthTokenSpy.mockRestore();
    getCurrentUserSpy.mockRestore();
    setUserInfoSpy.mockRestore();
  });

  describe("unauthenticated", () => {
    let getAuthConfigSpy: ReturnType<typeof spyOn>;
    let savedAuthToken: string | undefined;

    beforeEach(() => {
      savedAuthToken = process.env.SENTRY_AUTH_TOKEN;
      delete process.env.SENTRY_AUTH_TOKEN;
      getAuthConfigSpy = vi
        .spyOn(dbAuth, "getAuthConfig")
        .mockReturnValue(undefined);
      // With no stored auth, getAuthToken returns undefined, and the
      // natural AuthError bubbles up from getCurrentUser().
      getAuthTokenSpy.mockReturnValue(undefined);
      getCurrentUserSpy.mockRejectedValue(new AuthError("not_authenticated"));
    });

    afterEach(() => {
      getAuthConfigSpy.mockRestore();
      if (savedAuthToken !== undefined) {
        process.env.SENTRY_AUTH_TOKEN = savedAuthToken;
      }
    });

    test("throws AuthError(not_authenticated) when no token stored", async () => {
      isAuthenticatedSpy.mockReturnValue(false);

      const { context } = createContext();

      await expect(func.call(context, { json: false })).rejects.toBeInstanceOf(
        AuthError
      );
    });

    test("does not call setUserInfo when not authenticated", async () => {
      isAuthenticatedSpy.mockReturnValue(false);

      const { context } = createContext();

      try {
        await func.call(context, { json: false });
      } catch {
        // AuthError is expected
      }

      expect(setUserInfoSpy).not.toHaveBeenCalled();
    });
  });

  describe("org auth token — well-formed claim", () => {
    beforeEach(() => {
      getAuthTokenSpy.mockReturnValue(ORG_TOKEN);
    });

    test("yields org identity instead of calling the API", async () => {
      const { context, getOutput } = createContext();
      await func.call(context, { json: false });

      expect(getCurrentUserSpy).not.toHaveBeenCalled();
      expect(setUserInfoSpy).not.toHaveBeenCalled();
      const out = getOutput();
      expect(out).toContain("Organization auth token");
      expect(out).toContain("acme");
      expect(out).toContain("https://sentry.acme.com");
    });

    test("JSON output includes type, organization, url, and regionUrl", async () => {
      const { context, getOutput } = createContext();
      await func.call(context, { json: true });

      const parsed = JSON.parse(getOutput());
      expect(parsed.type).toBe("org-auth-token");
      expect(parsed.organization).toBe("acme");
      expect(parsed.url).toBe("https://sentry.acme.com");
      expect(parsed.regionUrl).toBe("https://us.sentry.acme.com");
    });
  });

  describe("org auth token — well-formed claim without org field", () => {
    beforeEach(() => {
      getAuthTokenSpy.mockReturnValue(ORG_TOKEN_NO_ORG);
    });

    test("yields output without organization row", async () => {
      const { context, getOutput } = createContext();
      await func.call(context, { json: false });

      expect(getCurrentUserSpy).not.toHaveBeenCalled();
      const out = getOutput();
      expect(out).toContain("Organization auth token");
      expect(out).toContain("https://sentry.io");
      expect(out).not.toContain("acme");
    });

    test("JSON output omits organization when claim has no org", async () => {
      const { context, getOutput } = createContext();
      await func.call(context, { json: true });

      const parsed = JSON.parse(getOutput());
      expect(parsed.type).toBe("org-auth-token");
      expect(parsed).not.toHaveProperty("organization");
      expect(parsed.url).toBe("https://sentry.io");
    });
  });

  describe("org auth token — malformed claim", () => {
    test("throws ResolutionError when claim parsing fails", async () => {
      getAuthTokenSpy.mockReturnValue(MALFORMED_ORG_TOKEN);

      const { context } = createContext();

      const promise = func.call(context, { json: false });
      await expect(promise).rejects.toBeInstanceOf(ResolutionError);
      await expect(promise).rejects.toBeInstanceOf(CliError);
      await expect(promise).rejects.not.toBeInstanceOf(AuthError);

      expect(getCurrentUserSpy).not.toHaveBeenCalled();
      expect(setUserInfoSpy).not.toHaveBeenCalled();
    });

    test("error message points to auth status and org list", async () => {
      getAuthTokenSpy.mockReturnValue(MALFORMED_ORG_TOKEN);

      const { context } = createContext();

      try {
        await func.call(context, { json: false });
        throw new Error("expected ResolutionError");
      } catch (err) {
        expect(err).toBeInstanceOf(ResolutionError);
        const msg = (err as ResolutionError).message;
        expect(msg).toContain("Organization auth tokens");
        expect(msg.toLowerCase()).toContain("user");
        expect(msg).toContain("sentry auth status");
        expect(msg).toContain("sentry org list");
      }
    });
  });

  describe("user PAT (sntryu_) passes through", () => {
    test("sntryu_ token calls getCurrentUser normally", async () => {
      getAuthTokenSpy.mockReturnValue("sntryu_personaltoken");
      getCurrentUserSpy.mockResolvedValue(FULL_USER);
      setUserInfoSpy.mockReturnValue(undefined);

      const { context, getOutput } = createContext();
      await func.call(context, { json: false });

      expect(getCurrentUserSpy).toHaveBeenCalled();
      expect(getOutput()).toContain("Jane Doe");
    });
  });

  describe("human output", () => {
    test("displays name and email for full user", async () => {
      isAuthenticatedSpy.mockReturnValue(true);
      getCurrentUserSpy.mockResolvedValue(FULL_USER);
      setUserInfoSpy.mockReturnValue(undefined);

      const { context, getOutput } = createContext();
      await func.call(context, { json: false });

      const out = getOutput();
      expect(out).toContain("Jane Doe");
      expect(out).toContain("jane@example.com");
    });

    test("falls back to email when no name", async () => {
      isAuthenticatedSpy.mockReturnValue(true);
      getCurrentUserSpy.mockResolvedValue(EMAIL_ONLY_USER);
      setUserInfoSpy.mockReturnValue(undefined);

      const { context, getOutput } = createContext();
      await func.call(context, { json: false });

      expect(getOutput()).toContain("anon@example.com");
    });

    test("falls back to user ID when no name or email", async () => {
      isAuthenticatedSpy.mockReturnValue(true);
      getCurrentUserSpy.mockResolvedValue(ID_ONLY_USER);
      setUserInfoSpy.mockReturnValue(undefined);

      const { context, getOutput } = createContext();
      await func.call(context, { json: false });

      expect(getOutput()).toContain("7");
    });

    test("updates DB cache with fetched user info", async () => {
      isAuthenticatedSpy.mockReturnValue(true);
      getCurrentUserSpy.mockResolvedValue(FULL_USER);
      setUserInfoSpy.mockReturnValue(undefined);

      const { context } = createContext();
      await func.call(context, { json: false });

      expect(setUserInfoSpy).toHaveBeenCalledWith({
        userId: "42",
        name: "Jane Doe",
        username: "janedoe",
        email: "jane@example.com",
      });
    });

    test("still displays identity when DB cache write fails", async () => {
      isAuthenticatedSpy.mockReturnValue(true);
      getCurrentUserSpy.mockResolvedValue(FULL_USER);
      setUserInfoSpy.mockImplementation(() => {
        throw new Error("read-only filesystem");
      });

      const { context, getOutput } = createContext();
      // Must not throw — output must still be shown
      await func.call(context, { json: false });

      expect(getOutput()).toContain("Jane Doe");
    });
  });

  describe("--json output", () => {
    test("outputs valid JSON with all fields", async () => {
      isAuthenticatedSpy.mockReturnValue(true);
      getCurrentUserSpy.mockResolvedValue(FULL_USER);
      setUserInfoSpy.mockReturnValue(undefined);

      const { context, getOutput } = createContext();
      await func.call(context, { json: true });

      const parsed = JSON.parse(getOutput());
      expect(parsed.id).toBe("42");
      expect(parsed.name).toBe("Jane Doe");
      expect(parsed.username).toBe("janedoe");
      expect(parsed.email).toBe("jane@example.com");
    });

    test("omits missing optional fields from output", async () => {
      isAuthenticatedSpy.mockReturnValue(true);
      getCurrentUserSpy.mockResolvedValue(ID_ONLY_USER);
      setUserInfoSpy.mockReturnValue(undefined);

      const { context, getOutput } = createContext();
      await func.call(context, { json: true });

      const parsed = JSON.parse(getOutput());
      expect(parsed.id).toBe("7");
      // Optional fields absent from the API response are omitted from JSON
      // (not normalized to null). Use --fields to select specific fields.
      expect(parsed).not.toHaveProperty("name");
      expect(parsed).not.toHaveProperty("username");
      expect(parsed).not.toHaveProperty("email");
    });

    test("still updates DB cache when --json is used", async () => {
      isAuthenticatedSpy.mockReturnValue(true);
      getCurrentUserSpy.mockResolvedValue(FULL_USER);
      setUserInfoSpy.mockReturnValue(undefined);

      const { context } = createContext();
      await func.call(context, { json: true });

      expect(setUserInfoSpy).toHaveBeenCalledWith({
        userId: "42",
        name: "Jane Doe",
        username: "janedoe",
        email: "jane@example.com",
      });
    });
  });
});
