import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  clearAuth,
  getAuthConfig,
  getCredentialContext,
  refreshToken,
  setAuthToken,
} from "../../../src/lib/db/auth.js";
import { ConfigError } from "../../../src/lib/errors.js";
import { useEnvSandbox, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("auth-refresh-cas-");
useEnvSandbox([
  "SENTRY_CLIENT_ID",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
]);
const originalFetch = globalThis.fetch;

function deferred<T>() {
  const state: { resolve?: (value: T) => void } = {};
  const promise = new Promise<T>((resolve) => {
    state.resolve = resolve;
  });
  return { promise, resolve: (value: T) => state.resolve?.(value) };
}

beforeEach(async () => {
  process.env.SENTRY_CLIENT_ID = "test-client-id";
  delete process.env.SENTRY_AUTH_TOKEN;
  delete process.env.SENTRY_TOKEN;
  delete process.env.SENTRY_FORCE_ENV_TOKEN;
  await clearAuth();
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await clearAuth();
});

function startPausedRefresh(response: ReturnType<typeof deferred<Response>>) {
  const started = deferred<URL>();
  globalThis.fetch = async (input) => {
    started.resolve(new URL(new Request(input).url));
    return await response.promise;
  };
  setAuthToken("old-access", 3600, "old-refresh", {
    host: "https://old.example.com",
  });
  return { pending: refreshToken({ force: true }), started: started.promise };
}

describe("OAuth refresh compare-and-swap", () => {
  test("a late successful refresh never overwrites a newer login", async () => {
    const response = deferred<Response>();
    const { pending, started } = startPausedRefresh(response);
    expect((await started).origin).toBe("https://old.example.com");
    setAuthToken("new-access", 3600, "new-refresh", {
      host: "https://new.example.com",
    });
    response.resolve(
      Response.json({
        access_token: "late-access",
        refresh_token: "late-refresh",
        expires_in: 3600,
        token_type: "bearer",
      })
    );
    await expect(pending).rejects.toThrow("Active credentials changed");
    expect(getAuthConfig()).toMatchObject({
      token: "new-access",
      refreshToken: "new-refresh",
    });
    expect(getCredentialContext()?.host).toBe("https://new.example.com");
  });

  test("a late invalid_grant never clears a newer login", async () => {
    const response = deferred<Response>();
    const { pending, started } = startPausedRefresh(response);
    await started;
    setAuthToken("new-access", 3600, "new-refresh", {
      host: "https://new.example.com",
    });
    response.resolve(
      Response.json(
        { error: "invalid_grant", error_description: "Refresh rejected" },
        { status: 400 }
      )
    );
    await expect(pending).rejects.toThrow("refresh credential was rejected");
    expect(getAuthConfig()).toMatchObject({
      token: "new-access",
      refreshToken: "new-refresh",
    });
    expect(getCredentialContext()?.host).toBe("https://new.example.com");
  });

  test("an unexpected refresh failure retains the stored credential", async () => {
    setAuthToken("current-access", 3600, "current-refresh", {
      host: "https://control.example.com",
    });
    globalThis.fetch = async (input, init) => {
      expect(new Request(input).url).toBe(
        "https://control.example.com/oauth/token/"
      );
      expect(init?.redirect).toBe("error");
      return new Response("temporary server failure", { status: 503 });
    };

    await expect(refreshToken({ force: true })).rejects.toThrow(
      "Token refresh failed"
    );
    expect(getAuthConfig()).toMatchObject({
      token: "current-access",
      refreshToken: "current-refresh",
    });
  });

  test("an invalid explicit credential host never falls back to SaaS", () => {
    setAuthToken("current-access", undefined, undefined, {
      host: "https://control.example.com",
    });
    expect(() =>
      setAuthToken("replacement-access", undefined, undefined, {
        host: "https://user:password@evil.example.net",
      })
    ).toThrow(ConfigError);
    expect(getAuthConfig()?.token).toBe("current-access");
    expect(getCredentialContext()?.host).toBe("https://control.example.com");
  });
});
