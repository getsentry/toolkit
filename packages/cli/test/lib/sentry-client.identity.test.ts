/** Authenticated transport cache ownership across changes to stored credentials. */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  getAuthToken,
  getIdentityFingerprint,
  setAuthToken,
} from "../../src/lib/db/auth.js";
import { withEnv } from "../../src/lib/env.js";
import { getSdkConfig } from "../../src/lib/sentry-client.js";
import { mockFetch, useEnvSandbox, useTestConfigDir } from "../helpers.js";

const HOST = "https://synthetic.example.invalid";
const ENDPOINT = `${HOST}/api/0/organizations/synthetic-org/projects/`;
const TOKENS = { A: "synthetic-token-a", B: "synthetic-token-b" };
type Owner = keyof typeof TOKENS;

function deferred() {
  let resolve = () => {
    // Assigned by the promise executor before this helper returns.
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("authenticated response cache identity", () => {
  const getConfigDir = useTestConfigDir("sentry-client-identity-");
  useEnvSandbox([
    "SENTRY_AUTH_TOKEN",
    "SENTRY_TOKEN",
    "SENTRY_FORCE_ENV_TOKEN",
    "SENTRY_NO_CACHE",
    "SENTRY_HOST",
    "SENTRY_URL",
    "SENTRY_CUSTOM_HEADERS",
  ]);

  let originalFetch: typeof globalThis.fetch;
  let requests: Array<string | null>;
  let pendingResponse: ReturnType<typeof deferred> | undefined;
  let requestStarted: ReturnType<typeof deferred> | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    requests = [];
    pendingResponse = undefined;
    requestStarted = undefined;
    process.env.SENTRY_HOST = HOST;
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== ENDPOINT) {
        throw new Error("Unexpected test request");
      }
      const authorization = request.headers.get("Authorization");
      const owner = authorization === `Bearer ${TOKENS.A}` ? "A" : "B";
      requests.push(authorization);
      requestStarted?.resolve();
      await pendingResponse?.promise;
      // No Vary header: credential isolation must hold independently of it.
      return Response.json(
        { owner },
        { headers: { "Cache-Control": "private, max-age=300" } },
      );
    });
    login("A");
  });

  afterEach(() => {
    pendingResponse?.resolve();
    globalThis.fetch = originalFetch;
  });

  function invocation<T>(run: () => T): T {
    return withEnv({ ...process.env }, run);
  }

  function login(owner: Owner): void {
    setAuthToken(TOKENS[owner], 3600, `synthetic-refresh-${owner}`);
  }

  async function requestBody() {
    const response = await getSdkConfig(HOST).fetch(ENDPOINT);
    return response.json();
  }

  async function waitForCacheEntries(count: number): Promise<void> {
    await vi.waitUntil(async () => {
      const files = await readdir(
        join(getConfigDir(), "cache", "responses"),
      ).catch(() => []);
      return files.filter((file) => file.endsWith(".json")).length === count;
    });
  }

  test("a session change before sending cannot cache B's response under A", async () => {
    await invocation(async () => {
      expect(getAuthToken()).toBe(TOKENS.A);
      getIdentityFingerprint();
      invocation(() => login("B"));

      expect(await requestBody()).toEqual({ owner: "B" });
      await waitForCacheEntries(1);
    });

    await invocation(async () => {
      login("A");
      expect(await requestBody()).toEqual({ owner: "A" });
      await waitForCacheEntries(2);
    });
    expect(requests).toEqual([`Bearer ${TOKENS.B}`, `Bearer ${TOKENS.A}`]);
  });

  test("an existing invocation cannot reuse A's cache after switching to B", async () => {
    await invocation(async () => {
      expect(await requestBody()).toEqual({ owner: "A" });
      await waitForCacheEntries(1);
      invocation(() => login("B"));

      expect(await requestBody()).toEqual({ owner: "B" });
      await waitForCacheEntries(2);
    });
    expect(requests).toEqual([`Bearer ${TOKENS.A}`, `Bearer ${TOKENS.B}`]);
  });

  test("access tokens with an empty refresh token keep separate cache identities", async () => {
    await invocation(async () => {
      setAuthToken(TOKENS.A, 3600, "");
      expect(await requestBody()).toEqual({ owner: "A" });
      await waitForCacheEntries(1);
      setAuthToken(TOKENS.B, 3600, "");

      expect(await requestBody()).toEqual({ owner: "B" });
      await waitForCacheEntries(2);
    });
    expect(requests).toEqual([`Bearer ${TOKENS.A}`, `Bearer ${TOKENS.B}`]);
  });

  test("an in-flight A response keeps A's cache identity after the session changes", async () => {
    pendingResponse = deferred();
    requestStarted = deferred();
    await invocation(async () => {
      const response = requestBody();
      await requestStarted?.promise;
      invocation(() => login("B"));
      pendingResponse?.resolve();

      expect(await response).toEqual({ owner: "A" });
      await waitForCacheEntries(1);
      await invocation(async () => {
        expect(await requestBody()).toEqual({ owner: "B" });
        await waitForCacheEntries(2);
      });
    });

    await invocation(async () => {
      login("A");
      expect(await requestBody()).toEqual({ owner: "A" });
    });
    expect(requests).toEqual([`Bearer ${TOKENS.A}`, `Bearer ${TOKENS.B}`]);
  });

  test("a 401 retry preserves the pinned identity while the rotated session warms its own cache", async () => {
    const respond = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input, init);
      if (request.url === `${HOST}/oauth/token/`) {
        calls.push("refresh");
        expect(
          new URLSearchParams(await request.text()).get("refresh_token"),
        ).toBe("synthetic-refresh-A");
        return Response.json({
          access_token: TOKENS.B,
          refresh_token: "synthetic-refresh-B",
          expires_in: 3600,
          token_type: "bearer",
        });
      }
      const authorization = request.headers.get("Authorization");
      calls.push(authorization ?? "missing authorization");
      if (authorization === `Bearer ${TOKENS.A}`) {
        return Response.json({ detail: "Expired token" }, { status: 401 });
      }
      return respond(input, init);
    });

    await invocation(async () => {
      expect(await requestBody()).toEqual({ owner: "B" });
      await waitForCacheEntries(1);
    });
    await invocation(async () => {
      expect(await requestBody()).toEqual({ owner: "B" });
      await waitForCacheEntries(2);
    });
    await invocation(async () => {
      expect(await requestBody()).toEqual({ owner: "B" });
    });
    expect(calls).toEqual([
      `Bearer ${TOKENS.A}`,
      "refresh",
      `Bearer ${TOKENS.B}`,
      `Bearer ${TOKENS.B}`,
    ]);
  });

  test("a delayed mutation invalidates only the identity that sent it", async () => {
    await invocation(async () => {
      await requestBody();
      await waitForCacheEntries(1);
    });
    await invocation(async () => {
      login("B");
      await requestBody();
      await waitForCacheEntries(2);
    });

    const respond = globalThis.fetch;
    pendingResponse = deferred();
    requestStarted = deferred();
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== "PUT") {
        return respond(input, init);
      }
      requests.push(request.headers.get("Authorization"));
      requestStarted?.resolve();
      await pendingResponse?.promise;
      return new Response(null, { status: 204 });
    });

    await invocation(async () => {
      login("A");
      const mutation = getSdkConfig(HOST).fetch(
        `${HOST}/api/0/projects/synthetic-org/synthetic-project/`,
        { method: "PUT" },
      );
      await requestStarted?.promise;
      invocation(() => login("B"));
      pendingResponse?.resolve();
      expect((await mutation).status).toBe(204);
      await waitForCacheEntries(1);
    });
    await invocation(async () => {
      expect(await requestBody()).toEqual({ owner: "B" });
    });
    expect(requests).toEqual([
      `Bearer ${TOKENS.A}`,
      `Bearer ${TOKENS.B}`,
      `Bearer ${TOKENS.A}`,
    ]);
    await invocation(async () => {
      login("A");
      expect(await requestBody()).toEqual({ owner: "A" });
      await waitForCacheEntries(2);
    });
    expect(requests).toHaveLength(4);
  });
});
