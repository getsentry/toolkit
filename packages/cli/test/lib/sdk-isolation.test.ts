/** Public SDK regressions for auth, cache, and host isolation between calls. */

import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import createSentrySDK from "../../src/index.js";
import { getAuthConfig, setAuthToken } from "../../src/lib/db/auth.js";
import { setEnv } from "../../src/lib/env.js";
import { resetCacheState } from "../../src/lib/response-cache.js";
import { resetAuthenticatedFetch } from "../../src/lib/sentry-client.js";
import {
  mockFetch,
  resetHostScopingState,
  useEnvSandbox,
  useTestConfigDir,
} from "../helpers.js";

const ENDPOINT = "/organizations/synthetic-org/projects/";
const FIRST_TOKEN = "synthetic-token-A";
const SECOND_TOKEN = "synthetic-token-B";
const MALFORMED_TOKEN = "synthetic\nbad-token";
const FIRST_PROJECT = {
  id: "1",
  slug: "project-a",
  name: "Project A",
  platform: "javascript",
};
const SECOND_PROJECT = { ...FIRST_PROJECT, id: "2", slug: "project-b" };

function deferred() {
  let resolve = () => {
    // Replaced synchronously by the promise executor before this helper returns.
  };
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("SDK invocation isolation", () => {
  const getConfigDir = useTestConfigDir("sdk-isolation-", {
    isolateProjectRoot: true,
  });
  useEnvSandbox([
    "SENTRY_AUTH_TOKEN",
    "SENTRY_TOKEN",
    "SENTRY_FORCE_ENV_TOKEN",
    "SENTRY_HOST",
    "SENTRY_URL",
    "SENTRY_CUSTOM_HEADERS",
    "SENTRY_NO_CACHE",
  ]);

  let originalFetch: typeof globalThis.fetch;
  let requests: Request[];
  let cacheControl: string;
  let waitForFirstRequest: Promise<void> | undefined;

  async function countCacheEntries(configDir = getConfigDir()) {
    const entries = await readdir(join(configDir, "cache", "responses"));
    return entries.filter((entry) => entry.endsWith(".json")).length;
  }

  beforeEach(async () => {
    await resetHostScopingState();
    resetAuthenticatedFetch();
    resetCacheState();
    originalFetch = globalThis.fetch;
    requests = [];
    cacheControl = "no-store";
    waitForFirstRequest = undefined;
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (requests.length === 1) {
        await waitForFirstRequest;
      }
      const project =
        request.headers.get("Authorization") === `Bearer ${FIRST_TOKEN}`
          ? FIRST_PROJECT
          : SECOND_PROJECT;
      return new Response(JSON.stringify([project]), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": cacheControl,
          Vary: "Authorization",
        },
      });
    });
  });

  afterEach(async () => {
    setEnv(process.env);
    globalThis.fetch = originalFetch;
    resetAuthenticatedFetch();
    resetCacheState();
    await resetHostScopingState();
  });

  test.each(["typed", "run"] as const)(
    "%s calls preserve each client's warm cache and reject a malformed token",
    async (entryPoint) => {
      cacheControl = "private, max-age=300";
      const options = { cwd: getConfigDir() };
      const first = createSentrySDK({ ...options, token: FIRST_TOKEN });
      const second = createSentrySDK({ ...options, token: SECOND_TOKEN });
      const malformed = createSentrySDK({ ...options, token: MALFORMED_TOKEN });
      const envBefore = { ...process.env };
      const invoke = (sdk: ReturnType<typeof createSentrySDK>) =>
        entryPoint === "typed"
          ? sdk.api({ endpoint: ENDPOINT })
          : sdk.run("api", ENDPOINT);
      await expect(invoke(first)).resolves.toMatchObject({
        body: [FIRST_PROJECT],
      });
      await expect.poll(() => countCacheEntries()).toBe(1);
      await expect(invoke(second)).resolves.toMatchObject({
        body: [SECOND_PROJECT],
      });
      await expect.poll(() => countCacheEntries()).toBe(2);
      await expect(malformed.api({ endpoint: ENDPOINT })).rejects.toThrow(
        "Invalid authentication token",
      );
      await expect(invoke(first)).resolves.toMatchObject({
        body: [FIRST_PROJECT],
      });

      expect(
        requests.map((request) => request.headers.get("Authorization")),
      ).toEqual([`Bearer ${FIRST_TOKEN}`, `Bearer ${SECOND_TOKEN}`]);
      expect(process.env).toEqual(envBefore);
    },
  );

  test("uncached calls use the current token and reject malformed credentials", async () => {
    const options = { cwd: getConfigDir() };
    const first = createSentrySDK({ ...options, token: FIRST_TOKEN });
    const second = createSentrySDK({ ...options, token: SECOND_TOKEN });
    const malformed = createSentrySDK({ ...options, token: MALFORMED_TOKEN });

    await expect(first.api({ endpoint: ENDPOINT })).resolves.toMatchObject({
      body: [FIRST_PROJECT],
    });
    await expect(second.api({ endpoint: ENDPOINT })).resolves.toMatchObject({
      body: [SECOND_PROJECT],
    });
    await expect(malformed.api({ endpoint: ENDPOINT })).rejects.toThrow(
      "Invalid authentication token",
    );
    expect(
      requests.map((request) => request.headers.get("Authorization")),
    ).toEqual([`Bearer ${FIRST_TOKEN}`, `Bearer ${SECOND_TOKEN}`]);
  });

  test("stored credentials follow the current config directory", async () => {
    const firstDir = join(getConfigDir(), "first");
    const secondDir = join(getConfigDir(), "second");
    await mkdir(firstDir);
    await mkdir(secondDir);
    process.env.SENTRY_CONFIG_DIR = firstDir;
    setAuthToken(FIRST_TOKEN, 3600, "synthetic-refresh-A");
    process.env.SENTRY_CONFIG_DIR = secondDir;
    setAuthToken(SECOND_TOKEN, 3600, "synthetic-refresh-B");

    const sdk = createSentrySDK({ cwd: getConfigDir() });
    process.env.SENTRY_CONFIG_DIR = firstDir;
    await expect(sdk.api({ endpoint: ENDPOINT })).resolves.toMatchObject({
      body: [FIRST_PROJECT],
    });
    process.env.SENTRY_CONFIG_DIR = secondDir;
    await expect(sdk.api({ endpoint: ENDPOINT })).resolves.toMatchObject({
      body: [SECOND_PROJECT],
    });
    process.env.SENTRY_CONFIG_DIR = firstDir;
    await expect(sdk.api({ endpoint: ENDPOINT })).resolves.toMatchObject({
      body: [FIRST_PROJECT],
    });
    expect(
      requests.map((request) => request.headers.get("Authorization")),
    ).toEqual([
      `Bearer ${FIRST_TOKEN}`,
      `Bearer ${SECOND_TOKEN}`,
      `Bearer ${FIRST_TOKEN}`,
    ]);
  });

  test("captures the config directory before the caller restores its environment", async () => {
    const firstDir = join(getConfigDir(), "first");
    const secondDir = join(getConfigDir(), "second");
    await mkdir(firstDir);
    await mkdir(secondDir);
    process.env.SENTRY_CONFIG_DIR = firstDir;
    setAuthToken(FIRST_TOKEN, 3600, "synthetic-refresh-A");
    process.env.SENTRY_CONFIG_DIR = secondDir;
    setAuthToken(SECOND_TOKEN, 3600, "synthetic-refresh-B");
    const sdk = createSentrySDK({ cwd: getConfigDir() });

    process.env.SENTRY_CONFIG_DIR = firstDir;
    const pending = sdk.api({ endpoint: ENDPOINT });
    process.env.SENTRY_CONFIG_DIR = secondDir;

    await expect(pending).resolves.toMatchObject({ body: [FIRST_PROJECT] });
    expect(requests[0]?.headers.get("Authorization")).toBe(
      `Bearer ${FIRST_TOKEN}`,
    );
    expect(process.env.SENTRY_CONFIG_DIR).toBe(secondDir);
  });

  test.each(["shared", "separate"] as const)(
    "a response pending after a command error keeps its identity with %s config directories",
    async (directories) => {
      const firstDir = getConfigDir();
      const secondDir =
        directories === "shared" ? firstDir : join(firstDir, "second");
      if (directories === "separate") {
        await mkdir(secondDir);
      }
      const host = "https://synthetic.example.invalid";
      const projectEndpoint = "/projects/synthetic-org/synthetic-project/";
      const keysEndpoint = `${projectEndpoint}keys/`;
      const keysStarted = deferred();
      const releaseKeys = deferred();
      const secondStarted = deferred();
      const releaseSecond = deferred();
      const firstKeys = [
        {
          id: "1",
          isActive: true,
          dsn: { public: "https://public@ingest.example.invalid/1" },
        },
      ];
      const secondKeys = [
        {
          id: "2",
          isActive: true,
          dsn: { public: "https://public@ingest.example.invalid/2" },
        },
      ];
      globalThis.fetch = mockFetch(async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const pathname = new URL(request.url).pathname;
        if (pathname === "/api/0/organizations/synthetic-org/") {
          return Response.json(
            { id: "1", slug: "synthetic-org", links: { regionUrl: host } },
            { headers: { "Cache-Control": "no-store" } },
          );
        }
        if (pathname === `/api/0${projectEndpoint}`) {
          await keysStarted.promise;
          return Response.json(
            { detail: "Not found" },
            { status: 404, headers: { "Cache-Control": "no-store" } },
          );
        }
        if (pathname === `/api/0${keysEndpoint}`) {
          const isFirst =
            request.headers.get("Authorization") === `Bearer ${FIRST_TOKEN}`;
          if (isFirst) {
            keysStarted.resolve();
            await releaseKeys.promise;
          }
          return Response.json(isFirst ? firstKeys : secondKeys, {
            headers: {
              "Cache-Control": "private, max-age=300",
              Vary: "Authorization",
            },
          });
        }
        if (pathname === "/api/0/hold/") {
          secondStarted.resolve();
          await releaseSecond.promise;
          return Response.json(
            { ok: true },
            { headers: { "Cache-Control": "no-store" } },
          );
        }
        throw new Error(`Unexpected request: ${pathname}`);
      });
      const options = { cwd: getConfigDir(), url: host };
      const first = createSentrySDK({ ...options, token: FIRST_TOKEN });
      const second = createSentrySDK({ ...options, token: SECOND_TOKEN });
      let pendingSecond: Promise<unknown> | undefined;
      try {
        // project.view starts both requests; its 404 leaves /keys/ pending.
        await expect(
          first.project.view({ orgProject: "synthetic-org/synthetic-project" }),
        ).rejects.toThrow();
        process.env.SENTRY_CONFIG_DIR = secondDir;
        pendingSecond = second.api({ endpoint: "/hold/" });
        await secondStarted.promise;
        releaseKeys.resolve();
        await expect.poll(() => countCacheEntries(firstDir)).toBe(1);
      } finally {
        releaseKeys.resolve();
        releaseSecond.resolve();
        await pendingSecond;
      }

      // A fresh SDK instance must not read A's persisted response as B.
      const freshSecond = createSentrySDK({ ...options, token: SECOND_TOKEN });
      await expect(
        freshSecond.api({ endpoint: keysEndpoint }),
      ).resolves.toMatchObject({ body: secondKeys });
      await expect
        .poll(() => countCacheEntries(secondDir))
        .toBe(directories === "shared" ? 2 : 1);
      process.env.SENTRY_CONFIG_DIR = firstDir;
      await expect(
        first.api({ endpoint: keysEndpoint }),
      ).resolves.toMatchObject({
        body: firstKeys,
      });
      expect(
        requests
          .filter((request) => new URL(request.url).pathname.endsWith("/keys/"))
          .map((request) => request.headers.get("Authorization")),
      ).toEqual([`Bearer ${FIRST_TOKEN}`, `Bearer ${SECOND_TOKEN}`]);
    },
  );

  test("a late 401 refreshes the original client's credentials while another client runs", async () => {
    const firstDir = getConfigDir();
    const secondDir = join(firstDir, "second");
    const firstHost = "https://first.example.invalid";
    const secondHost = "https://second.example.invalid";
    const refreshedToken = "synthetic-refreshed-A";
    await mkdir(secondDir);
    setAuthToken(FIRST_TOKEN, 3600, "synthetic-refresh-A", { host: firstHost });
    process.env.SENTRY_CONFIG_DIR = secondDir;
    setAuthToken(SECOND_TOKEN, 3600, "synthetic-refresh-B", {
      host: secondHost,
    });
    const keysStarted = deferred();
    const releaseKeys = deferred();
    const secondStarted = deferred();
    const releaseSecond = deferred();
    const refreshRequests: { url: string; refreshToken: string | null }[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      const authorization = request.headers.get("Authorization");
      const headers = { "Cache-Control": "no-store" };
      if (url.pathname === "/api/0/organizations/synthetic-org/") {
        return Response.json(
          { id: "1", slug: "synthetic-org", links: { regionUrl: url.origin } },
          { headers },
        );
      }
      if (url.pathname === "/api/0/projects/synthetic-org/synthetic-project/") {
        await keysStarted.promise;
        return Response.json({ detail: "Not found" }, { status: 404, headers });
      }
      if (url.pathname.endsWith("/keys/")) {
        if (authorization === `Bearer ${FIRST_TOKEN}`) {
          keysStarted.resolve();
          await releaseKeys.promise;
          return Response.json({ detail: "Expired" }, { status: 401, headers });
        }
        return Response.json([], { headers });
      }
      if (url.pathname === "/oauth/token/") {
        refreshRequests.push({
          url: request.url,
          refreshToken: new URLSearchParams(await request.text()).get(
            "refresh_token",
          ),
        });
        return Response.json({
          access_token: refreshedToken,
          refresh_token: "synthetic-rotated-refresh-A",
          token_type: "bearer",
          expires_in: 3600,
        });
      }
      if (url.pathname === "/api/0/hold/") {
        secondStarted.resolve();
        await releaseSecond.promise;
      }
      return Response.json({ authorization }, { headers });
    });
    const first = createSentrySDK({ cwd: firstDir, url: firstHost });
    const second = createSentrySDK({ cwd: firstDir, url: secondHost });
    let pendingSecond: Promise<unknown> | undefined;
    try {
      process.env.SENTRY_CONFIG_DIR = firstDir;
      await expect(
        first.project.view({ orgProject: "synthetic-org/synthetic-project" }),
      ).rejects.toThrow();
      process.env.SENTRY_CONFIG_DIR = secondDir;
      pendingSecond = second.api({ endpoint: "/hold/" });
      await secondStarted.promise;
      releaseKeys.resolve();
      await vi.waitFor(
        () => {
          expect(
            requests.find(
              (request) =>
                request.url.endsWith("/keys/") &&
                request.headers.get("Authorization") ===
                  `Bearer ${refreshedToken}`,
            )?.url,
          ).toBe(
            `${firstHost}/api/0/projects/synthetic-org/synthetic-project/keys/`,
          );
        },
        { timeout: 3000 },
      );
    } finally {
      releaseKeys.resolve();
      releaseSecond.resolve();
      await pendingSecond;
    }

    expect(refreshRequests).toEqual([
      { url: `${firstHost}/oauth/token/`, refreshToken: "synthetic-refresh-A" },
    ]);
    expect(getAuthConfig()).toMatchObject({
      token: SECOND_TOKEN,
      refreshToken: "synthetic-refresh-B",
    });
    await expect(second.api({ endpoint: "/identity/" })).resolves.toMatchObject(
      {
        body: { authorization: `Bearer ${SECOND_TOKEN}` },
      },
    );
    process.env.SENTRY_CONFIG_DIR = firstDir;
    expect(getAuthConfig()).toMatchObject({
      token: refreshedToken,
      refreshToken: "synthetic-rotated-refresh-A",
    });
  });

  test("a fresh invocation leaves its cached responses usable by the next invocation", async () => {
    globalThis.fetch = mockFetch((input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      const body = url.pathname.endsWith("/teams/")
        ? [{ id: "1", slug: "synthetic-team", name: "Synthetic Team" }]
        : {
            id: "1",
            slug: "synthetic-org",
            links: { regionUrl: url.origin },
          };
      return Promise.resolve(
        Response.json(body, {
          headers: {
            "Cache-Control": "private, max-age=300",
            Vary: "Authorization",
          },
        }),
      );
    });
    const sdk = createSentrySDK({ cwd: getConfigDir(), token: FIRST_TOKEN });

    const result = await sdk.team.list({
      orgProject: "synthetic-org/",
      fresh: true,
    });
    await expect.poll(() => countCacheEntries()).toBe(2);
    await expect(
      sdk.team.list({ orgProject: "synthetic-org/" }),
    ).resolves.toEqual(result);
    expect(requests).toHaveLength(2);
  });

  test.each(["during", "after"] as const)(
    "shared credentials handle a second 401 %s an OAuth refresh",
    async (timing) => {
      const host = "https://synthetic.example.invalid";
      const refreshedToken = "synthetic-refreshed-A";
      setAuthToken(FIRST_TOKEN, 3600, "synthetic-refresh-A", { host });
      const keysStarted = deferred();
      const releaseKeys = deferred();
      const refreshStarted = deferred();
      const releaseRefresh = deferred();
      const releaseDuplicateRefresh = deferred();
      const secondStarted = deferred();
      const releaseSecond401 = deferred();
      const refreshTokens: (string | null)[] = [];
      globalThis.fetch = mockFetch(async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const pathname = new URL(request.url).pathname;
        const authorization = request.headers.get("Authorization");
        const headers = { "Cache-Control": "no-store" };
        if (pathname === "/api/0/organizations/synthetic-org/") {
          return Response.json(
            { id: "1", slug: "synthetic-org", links: { regionUrl: host } },
            { headers },
          );
        }
        if (pathname === "/api/0/projects/synthetic-org/synthetic-project/") {
          await keysStarted.promise;
          return Response.json(
            { detail: "Not found" },
            { status: 404, headers },
          );
        }
        if (pathname.endsWith("/keys/")) {
          if (authorization === `Bearer ${FIRST_TOKEN}`) {
            keysStarted.resolve();
            await releaseKeys.promise;
            return Response.json(
              { detail: "Expired" },
              { status: 401, headers },
            );
          }
          return Response.json([], { headers });
        }
        if (pathname === "/api/0/next/") {
          if (authorization === `Bearer ${FIRST_TOKEN}`) {
            secondStarted.resolve();
            await releaseSecond401.promise;
            return Response.json(
              { detail: "Expired" },
              { status: 401, headers },
            );
          }
          return Response.json(
            { authorization },
            {
              headers: {
                "Cache-Control": "private, max-age=300",
                Vary: "Authorization",
              },
            },
          );
        }
        if (pathname === "/oauth/token/") {
          const refreshToken = new URLSearchParams(await request.text()).get(
            "refresh_token",
          );
          refreshTokens.push(refreshToken);
          const isFirstRefresh = refreshTokens.length === 1;
          if (isFirstRefresh) {
            refreshStarted.resolve();
            await releaseRefresh.promise;
          }
          if (
            isFirstRefresh ||
            refreshToken === "synthetic-rotated-refresh-A"
          ) {
            return Response.json({
              access_token: refreshedToken,
              refresh_token: "synthetic-rotated-refresh-A",
              token_type: "bearer",
              expires_in: 3600,
            });
          }
          // Reusing a refresh token after rotation invalidates the second refresh.
          await releaseDuplicateRefresh.promise;
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        throw new Error(`Unexpected request: ${pathname}`);
      });
      const options = { cwd: getConfigDir(), url: host };
      const first = createSentrySDK(options);
      const second = createSentrySDK(options);
      let pendingSecond: Promise<unknown> | undefined;
      try {
        await expect(
          first.project.view({ orgProject: "synthetic-org/synthetic-project" }),
        ).rejects.toThrow();
        releaseKeys.resolve();
        await refreshStarted.promise;
        pendingSecond = second.api({ endpoint: "/next/" });
        await secondStarted.promise;
        if (timing === "during") {
          releaseSecond401.resolve();
          // Let B handle its 401 while A's refresh remains in flight.
          await setImmediate();
        }
        releaseRefresh.resolve();
        await expect.poll(() => getAuthConfig()?.token).toBe(refreshedToken);
        releaseSecond401.resolve();
        releaseDuplicateRefresh.resolve();
        await expect(pendingSecond).resolves.toMatchObject({
          body: { authorization: `Bearer ${refreshedToken}` },
        });
        await expect.poll(() => countCacheEntries()).toBe(1);
        await expect(
          createSentrySDK(options).api({ endpoint: "/next/" }),
        ).resolves.toMatchObject({
          body: { authorization: `Bearer ${refreshedToken}` },
        });
        // The in-flight request kept its original credential namespace. A new
        // invocation warms the rotated identity's namespace, then reuses it.
        await expect.poll(() => countCacheEntries()).toBe(2);
        await expect(
          createSentrySDK(options).api({ endpoint: "/next/" }),
        ).resolves.toMatchObject({
          body: { authorization: `Bearer ${refreshedToken}` },
        });
        if (timing === "during") {
          expect(refreshTokens).toEqual(["synthetic-refresh-A"]);
        } else {
          expect(refreshTokens).toEqual([
            "synthetic-refresh-A",
            "synthetic-rotated-refresh-A",
          ]);
        }
        expect(
          requests.filter((request) => request.url.endsWith("/next/")),
        ).toHaveLength(3);
        expect(getAuthConfig()).toMatchObject({
          token: refreshedToken,
          refreshToken: "synthetic-rotated-refresh-A",
        });
      } finally {
        releaseKeys.resolve();
        releaseRefresh.resolve();
        releaseDuplicateRefresh.resolve();
        releaseSecond401.resolve();
        if (pendingSecond) {
          await Promise.allSettled([pendingSecond]);
        }
        await vi.waitFor(
          () => {
            expect(
              requests.filter((request) => request.url.endsWith("/keys/")),
            ).toHaveLength(2);
          },
          { timeout: 3000 },
        );
      }
    },
  );

  test("each client scopes credentials and custom headers to its own host", async () => {
    const first = createSentrySDK({
      token: FIRST_TOKEN,
      url: "https://first.example.invalid",
      headers: { "X-Synthetic-Proxy": "first" },
      cwd: getConfigDir(),
    });
    const second = createSentrySDK({
      token: SECOND_TOKEN,
      url: "https://second.example.invalid",
      cwd: getConfigDir(),
    });

    await first.api({ endpoint: ENDPOINT });
    await second.api({ endpoint: ENDPOINT });
    await first.api({ endpoint: ENDPOINT });

    expect(
      requests.map((request) => ({
        origin: new URL(request.url).origin,
        authorization: request.headers.get("Authorization"),
        proxy: request.headers.get("X-Synthetic-Proxy"),
      })),
    ).toEqual([
      {
        origin: "https://first.example.invalid",
        authorization: `Bearer ${FIRST_TOKEN}`,
        proxy: "first",
      },
      {
        origin: "https://second.example.invalid",
        authorization: `Bearer ${SECOND_TOKEN}`,
        proxy: null,
      },
      {
        origin: "https://first.example.invalid",
        authorization: `Bearer ${FIRST_TOKEN}`,
        proxy: "first",
      },
    ]);
  });

  test("org-scoped commands resolve the same org independently across hosts and config directories", async () => {
    const firstDir = join(getConfigDir(), "first");
    const secondDir = join(getConfigDir(), "second");
    await mkdir(firstDir);
    await mkdir(secondDir);
    globalThis.fetch = mockFetch((input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      const body = url.pathname.endsWith("/teams/")
        ? [{ id: "1", slug: "synthetic-team", name: "Synthetic Team" }]
        : {
            id: "1",
            slug: "synthetic-org",
            name: "Synthetic Org",
            links: { regionUrl: url.origin },
          };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        }),
      );
    });
    const first = createSentrySDK({
      token: FIRST_TOKEN,
      url: "https://first.example.invalid",
      cwd: getConfigDir(),
    });
    const second = createSentrySDK({
      token: SECOND_TOKEN,
      url: "https://second.example.invalid",
      cwd: getConfigDir(),
    });

    process.env.SENTRY_CONFIG_DIR = firstDir;
    await first.team.list({ orgProject: "synthetic-org/" });
    process.env.SENTRY_CONFIG_DIR = secondDir;
    await second.team.list({ orgProject: "synthetic-org/" });

    expect(
      requests.map((request) => ({
        url: `${new URL(request.url).origin}${new URL(request.url).pathname}`,
        authorization: request.headers.get("Authorization"),
      })),
    ).toEqual([
      {
        url: "https://first.example.invalid/api/0/organizations/synthetic-org/",
        authorization: `Bearer ${FIRST_TOKEN}`,
      },
      {
        url: "https://first.example.invalid/api/0/organizations/synthetic-org/teams/",
        authorization: `Bearer ${FIRST_TOKEN}`,
      },
      {
        url: "https://second.example.invalid/api/0/organizations/synthetic-org/",
        authorization: `Bearer ${SECOND_TOKEN}`,
      },
      {
        url: "https://second.example.invalid/api/0/organizations/synthetic-org/teams/",
        authorization: `Bearer ${SECOND_TOKEN}`,
      },
    ]);
  });

  test.each(["setup", "command"] as const)(
    "a %s error leaves the next invocation usable",
    async (failure) => {
      const options = { cwd: getConfigDir(), token: FIRST_TOKEN };
      const failing = createSentrySDK({
        ...options,
        ...(failure === "setup"
          ? { headers: { Authorization: "invalid" } }
          : {}),
      });
      const envBefore = { ...process.env };

      await expect(
        failure === "setup"
          ? failing.api({ endpoint: ENDPOINT })
          : failing.api({ endpoint: "../invalid" }),
      ).rejects.toThrow();
      const second = createSentrySDK({
        cwd: getConfigDir(),
        token: SECOND_TOKEN,
      });
      await expect(second.api({ endpoint: ENDPOINT })).resolves.toMatchObject({
        body: [SECOND_PROJECT],
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.get("Authorization")).toBe(
        `Bearer ${SECOND_TOKEN}`,
      );
      expect(process.env).toEqual(envBefore);
    },
  );

  test("rejects an overlapping invocation without disturbing the active client", async () => {
    let releaseFirstRequest: (() => void) | undefined;
    waitForFirstRequest = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    const first = createSentrySDK({ token: FIRST_TOKEN, cwd: getConfigDir() });
    const second = createSentrySDK({
      token: SECOND_TOKEN,
      cwd: getConfigDir(),
    });
    const pendingFirst = first.api({ endpoint: ENDPOINT });
    try {
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      await expect(second.api({ endpoint: ENDPOINT })).rejects.toThrow(
        /concurrent|active|overlap/i,
      );
      expect(requests).toHaveLength(1);
    } finally {
      releaseFirstRequest?.();
      await pendingFirst;
    }
    await expect(second.api({ endpoint: ENDPOINT })).resolves.toMatchObject({
      body: [SECOND_PROJECT],
    });
    expect(
      requests.map((request) => request.headers.get("Authorization")),
    ).toEqual([`Bearer ${FIRST_TOKEN}`, `Bearer ${SECOND_TOKEN}`]);
  });
});
