/** Regression coverage for malformed bearer credentials. */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { shouldAutoAuth } from "../../src/lib/auto-auth.js";
import { getAuthConfig, setAuthToken } from "../../src/lib/db/auth.js";
import { getDatabase } from "../../src/lib/db/index.js";
import { setEnv } from "../../src/lib/env.js";
import {
  AuthError,
  EXIT,
  HostScopeError,
  MalformedAuthTokenError,
  withAuthGuard,
} from "../../src/lib/errors.js";
import {
  getCachedResponse,
  storeCachedResponse,
} from "../../src/lib/response-cache.js";
import {
  getSdkConfig,
  resetAuthenticatedFetch,
} from "../../src/lib/sentry-client.js";
import {
  extractFetchUrl,
  mintSntrysToken,
  mockFetch,
  resetHostScopingState,
  useEnvSandbox,
  useTestConfigDir,
} from "../helpers.js";

const REGION_URL = "https://us.sentry.io";
const RESOURCE_URL = `${REGION_URL}/api/0/organizations/synthetic-org/chunk-upload/`;
const ENV_TOKEN_KEYS = ["SENTRY_AUTH_TOKEN", "SENTRY_TOKEN"] as const;
const ORG_TOKEN = mintSntrysToken({
  iat: 1,
  url: "https://sentry.io",
  org: "synthetic-org",
});
const MALFORMED_TOKEN = ORG_TOKEN.replace(
  "test-secret-tail",
  "te\nst-secret-tail",
);
const EDGE_CONTROLS = `${Array.from({ length: 32 }, (_, code) =>
  String.fromCharCode(code),
).join("")}\x7f`;

describe("authenticated fetch bearer validation", () => {
  useTestConfigDir("sentry-client-auth-");
  useEnvSandbox([
    ...ENV_TOKEN_KEYS,
    "SENTRY_FORCE_ENV_TOKEN",
    "SENTRY_HOST",
    "SENTRY_URL",
    "SENTRY_CLIENT_ID",
  ]);

  let originalFetch: typeof globalThis.fetch;
  let requests: { url: string; authorization: string | null }[];

  /** Mock responses while recording the actual request URL and Authorization. */
  function mockResponses(
    respond: (url: string, authorization: string | null) => Response,
  ): typeof fetch {
    return mockFetch((input, init) => {
      const url = extractFetchUrl(input);
      const authorization = new Headers(init?.headers).get("Authorization");
      requests.push({ url, authorization });
      return Promise.resolve(respond(url, authorization));
    });
  }

  beforeEach(async () => {
    await resetHostScopingState();
    resetAuthenticatedFetch();
    originalFetch = globalThis.fetch;
    requests = [];
    globalThis.fetch = mockResponses(() => new Response("{}", { status: 200 }));
  });

  afterEach(async () => {
    setEnv(process.env);
    globalThis.fetch = originalFetch;
    resetAuthenticatedFetch();
    await resetHostScopingState();
  });

  function request(): Promise<Response> {
    return getSdkConfig(REGION_URL).fetch(RESOURCE_URL);
  }

  /** Simulate credentials persisted before setAuthToken validated its input. */
  function storeLegacyToken(token: string): void {
    setAuthToken("legacy-token");
    getDatabase().query("UPDATE auth SET token = ? WHERE id = 1").run(token);
  }

  test.each([...ENV_TOKEN_KEYS, "stored"])(
    "rejects an internal LF from %s before any request or auth fallback",
    async (source) => {
      if (source === "stored") {
        storeLegacyToken(MALFORMED_TOKEN);
      } else {
        process.env[source] = MALFORMED_TOKEN;
      }

      const error = await withAuthGuard(request).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(AuthError);
      expect(error).toBeInstanceOf(MalformedAuthTokenError);
      const authError = error as AuthError;
      expect(authError.reason).toBe("invalid");
      expect(authError.exitCode).toBe(EXIT.AUTH_INVALID);
      expect(authError.message).toContain("single line");
      expect(authError.cause).toBeUndefined();
      expect(`${authError.message}\n${authError.stack}`).not.toContain(
        MALFORMED_TOKEN,
      );
      expect(shouldAutoAuth(authError, () => true)).toBe(false);
      expect(requests).toEqual([]);
    },
  );

  test.each([
    ["CR", "\r"],
    ["NUL", "\0"],
    ["tab", "\t"],
    ["space", " "],
    ["control character", "\x01"],
    ["DEL", "\x7f"],
    ["non-ASCII byte", "\x80"],
    ["non-ByteString character", "\u0100"],
    ["surrogate pair", "💥"],
  ])("rejects %s in SDK credentials without exposing it", async (_, char) => {
    const token = `synthetic-prefix${char}synthetic-secret`;
    // SDK options use an in-memory env copy, which preserves even NULs.
    // process.env and the SQLite binding truncate NUL-containing strings.
    setEnv({ ...process.env, SENTRY_AUTH_TOKEN: token });
    const error = await request().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({
      reason: "invalid",
      exitCode: EXIT.AUTH_INVALID,
    });
    expect(String(error)).not.toContain(token);
    expect(requests).toEqual([]);
  });

  test.each([
    ["org", ORG_TOKEN],
    ["user", `sntryu_${"a".repeat(64)}`],
    ["opaque legacy/OAuth", "opaque.legacy_token+with/punctuation=~-"],
  ])("preserves a printable %s token", async (_, token) => {
    setAuthToken(token);
    await request();
    expect(requests).toEqual([
      { url: RESOURCE_URL, authorization: `Bearer ${token}` },
    ]);
  });

  test.each(ENV_TOKEN_KEYS)("preserves outer trimming for %s", async (key) => {
    process.env[key] = "\t\n  synthetic-token  \r\n";
    await request();
    expect(requests[0]?.authorization).toBe("Bearer synthetic-token");
  });

  test.each(ENV_TOKEN_KEYS)(
    "trims surrounding C0, DEL and whitespace from SDK %s",
    async (key) => {
      // An isolated SDK environment preserves NULs that process.env cannot.
      setEnv({
        ...process.env,
        [key]: `${EDGE_CONTROLS}\u00a0synthetic-token\ufeff${EDGE_CONTROLS}`,
      });

      await request();

      expect(requests).toEqual([
        { url: RESOURCE_URL, authorization: "Bearer synthetic-token" },
      ]);
    },
  );

  test.each([
    " stored-token ",
    "\t\n\u00a0stored-token\r\n",
    "\x1f\u00a0stored-token\ufeff\x7f",
  ])(
    "trims surrounding controls and whitespace from legacy credentials %#",
    async (token) => {
      storeLegacyToken(token);
      await request();
      expect(requests).toEqual([
        { url: RESOURCE_URL, authorization: "Bearer stored-token" },
      ]);
    },
  );

  test("rejects a whitespace-only stored credential", async () => {
    storeLegacyToken(" \t\r\n ");
    await expect(request()).rejects.toMatchObject({
      name: "MalformedAuthTokenError",
      reason: "invalid",
      exitCode: EXIT.AUTH_INVALID,
    });
    expect(requests).toEqual([]);
  });

  test("looks up Vary: Authorization using the normalized legacy credential", async () => {
    storeLegacyToken("\x1fsynthetic-token\x7f");
    await storeCachedResponse(
      "GET",
      RESOURCE_URL,
      { authorization: "Bearer synthetic-token" },
      Response.json(
        { source: "cache" },
        {
          headers: {
            "Cache-Control": "private, max-age=300",
            Vary: "Authorization",
          },
        },
      ),
    );

    expect(await (await request()).json()).toEqual({ source: "cache" });
    expect(requests).toEqual([]);
  });

  test("stores Vary: Authorization with the credential actually sent", async () => {
    storeLegacyToken("\x1fsynthetic-token\x7f");
    globalThis.fetch = mockResponses(() =>
      Response.json(
        { source: "network" },
        {
          headers: {
            "Cache-Control": "private, max-age=300",
            Vary: "Authorization",
          },
        },
      ),
    );

    await request();

    // Cache writes are fire-and-forget; wait for the entry rather than sleeping.
    await expect
      .poll(async () => {
        const cached = await getCachedResponse("GET", RESOURCE_URL, {
          authorization: "Bearer synthetic-token",
        });
        return cached?.json();
      })
      .toEqual({ source: "network" });
    expect(requests).toEqual([
      { url: RESOURCE_URL, authorization: "Bearer synthetic-token" },
    ]);
  });

  test("checks token host claims after removing surrounding whitespace", async () => {
    const token = mintSntrysToken({
      iat: 1,
      url: "https://other-sentry.example.com",
      org: "synthetic-org",
    });
    storeLegacyToken(` \n${token}\t `);
    await expect(request()).rejects.toBeInstanceOf(HostScopeError);
    expect(requests).toEqual([]);
  });

  test.each(ENV_TOKEN_KEYS)(
    "ignores a malformed %s when stored OAuth takes precedence",
    async (key) => {
      process.env[key] = MALFORMED_TOKEN;
      setAuthToken("stored-token");
      await request();
      expect(requests[0]?.authorization).toBe("Bearer stored-token");
    },
  );

  test("rejects forced malformed env credentials instead of using stored OAuth", async () => {
    process.env.SENTRY_AUTH_TOKEN = MALFORMED_TOKEN;
    process.env.SENTRY_FORCE_ENV_TOKEN = "1";
    setAuthToken("stored-token");
    await expect(request()).rejects.toMatchObject({
      reason: "invalid",
      exitCode: EXIT.AUTH_INVALID,
    });
    expect(requests).toEqual([]);
  });

  test.each([
    { key: "SENTRY_AUTH_TOKEN", forceEnv: false },
    { key: "SENTRY_AUTH_TOKEN", forceEnv: true },
    { key: "SENTRY_TOKEN", forceEnv: true },
  ])(
    "rejects control-only $key without fallback (force-env=$forceEnv)",
    async ({ key, forceEnv }) => {
      if (forceEnv) {
        setAuthToken("stored-token");
      }
      setEnv({
        ...process.env,
        SENTRY_AUTH_TOKEN: undefined,
        SENTRY_TOKEN: "alias-token",
        SENTRY_FORCE_ENV_TOKEN: forceEnv ? "1" : undefined,
        [key]: "\0\x01\x7f",
      });

      await expect(request()).rejects.toMatchObject({
        name: "MalformedAuthTokenError",
        reason: "invalid",
        exitCode: EXIT.AUTH_INVALID,
      });
      expect(requests).toEqual([]);
    },
  );

  test.each([
    "refreshed-token",
    " \nrefreshed-token\r\t",
    "\x1f\nrefreshed-token\r\x7f",
  ])("retries with a normalized valid refreshed bearer %#", async (token) => {
    process.env.SENTRY_CLIENT_ID = "synthetic-client-id";
    setAuthToken("stored-token", 3600, "synthetic-refresh-token");
    globalThis.fetch = mockResponses((url, authorization) => {
      if (url.endsWith("/oauth/token/")) {
        return Response.json({
          access_token: token,
          token_type: "bearer",
          expires_in: 3600,
        });
      }
      return new Response("{}", {
        status: authorization === "Bearer stored-token" ? 401 : 200,
      });
    });

    expect((await request()).status).toBe(200);
    expect(requests).toEqual([
      { url: RESOURCE_URL, authorization: "Bearer stored-token" },
      { url: "https://sentry.io/oauth/token/", authorization: null },
      { url: RESOURCE_URL, authorization: "Bearer refreshed-token" },
    ]);
    expect(getAuthConfig()?.token).toBe("refreshed-token");
  });

  test.each([
    MALFORMED_TOKEN,
    "",
    " \t\n ",
    "opaque-\0-token",
    "opaque-\u0100-token",
  ])(
    "rejects malformed refreshed credentials without retrying the request %#",
    async (token) => {
      process.env.SENTRY_CLIENT_ID = "synthetic-client-id";
      setAuthToken("stored-token", 3600, "synthetic-refresh-token");
      globalThis.fetch = mockResponses((url) => {
        if (url.endsWith("/oauth/token/")) {
          return Response.json({
            access_token: token,
            token_type: "bearer",
            expires_in: 3600,
            refresh_token: "synthetic-refresh-token",
          });
        }
        return new Response("{}", { status: 401 });
      });

      for (let attempt = 0; attempt < 2; attempt++) {
        const error = await request().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(MalformedAuthTokenError);
        expect(error).toMatchObject({
          reason: "invalid",
          exitCode: EXIT.AUTH_INVALID,
        });
        expect((error as Error).cause).toBeUndefined();
        if (token) {
          expect(String(error)).not.toContain(token);
        }
        expect(getAuthConfig()).toMatchObject({
          token: "stored-token",
          refreshToken: "synthetic-refresh-token",
        });
      }
      const refreshAttempt = [
        { url: RESOURCE_URL, authorization: "Bearer stored-token" },
        { url: "https://sentry.io/oauth/token/", authorization: null },
      ];
      expect(requests).toEqual([...refreshAttempt, ...refreshAttempt]);
    },
  );

  test.each(["none", ...ENV_TOKEN_KEYS])(
    "normalizes a proactive refresh with malformed env source %s",
    async (source) => {
      process.env.SENTRY_CLIENT_ID = "synthetic-client-id";
      if (source !== "none") {
        process.env[source] = MALFORMED_TOKEN;
      }
      setAuthToken("expired-token", -1, "synthetic-refresh-token");
      globalThis.fetch = mockResponses((url) =>
        url.endsWith("/oauth/token/")
          ? Response.json({
              access_token: "\x1f \nrefreshed-token\r\t\x7f",
              token_type: "bearer",
              expires_in: 3600,
              refresh_token: "replacement-refresh-token",
            })
          : Response.json({}),
      );

      expect((await request()).status).toBe(200);
      expect(getAuthConfig()).toMatchObject({
        token: "refreshed-token",
        refreshToken: "replacement-refresh-token",
      });
      expect(requests).toEqual([
        { url: "https://sentry.io/oauth/token/", authorization: null },
        { url: RESOURCE_URL, authorization: "Bearer refreshed-token" },
      ]);
    },
  );

  test("rejects malformed proactive refresh before storing or using the token", async () => {
    process.env.SENTRY_CLIENT_ID = "synthetic-client-id";
    setAuthToken("expired-token", -1, "synthetic-refresh-token");
    globalThis.fetch = mockResponses(() =>
      Response.json({
        access_token: "opaque-\0-secret-tail",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "replacement-refresh-token",
      }),
    );

    await expect(request()).rejects.toMatchObject({
      reason: "invalid",
      exitCode: EXIT.AUTH_INVALID,
    });
    expect(getAuthConfig()).toMatchObject({
      token: "expired-token",
      refreshToken: "synthetic-refresh-token",
    });
    expect(requests).toEqual([
      { url: "https://sentry.io/oauth/token/", authorization: null },
    ]);
  });
});
