/** Public SDK regressions for auth, cache, and host isolation between calls. */

import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
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

  async function countCacheEntries() {
    const entries = await readdir(join(getConfigDir(), "cache", "responses"));
    return entries.filter((entry) => entry.endsWith(".json")).length;
  }

  beforeEach(async () => {
    await resetHostScopingState();
    resetAuthenticatedFetch();
    resetCacheState();
    originalFetch = globalThis.fetch;
    requests = [];
    cacheControl = "no-store";
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const project =
        request.headers.get("Authorization") === `Bearer ${FIRST_TOKEN}`
          ? FIRST_PROJECT
          : SECOND_PROJECT;
      const url = new URL(request.url);
      let body: unknown;
      switch (url.pathname) {
        case `/api/0${ENDPOINT}`:
          body = [project];
          break;
        case "/api/0/organizations/synthetic-org/":
          body = {
            id: "1",
            slug: "synthetic-org",
            links: { regionUrl: url.origin },
          };
          break;
        case "/api/0/organizations/synthetic-org/teams/":
          body = [{ id: "1", slug: "synthetic-team", name: "Synthetic Team" }];
          break;
        default:
          throw new Error(`Unexpected request: ${request.url}`);
      }
      return Response.json(body, {
        headers: {
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

  test("each invocation captures its config directory before the caller restores the environment", async () => {
    const firstDir = getConfigDir();
    const secondDir = join(getConfigDir(), "second");
    await mkdir(secondDir);
    setAuthToken(FIRST_TOKEN, 3600, "synthetic-refresh-A");
    process.env.SENTRY_CONFIG_DIR = secondDir;
    setAuthToken(SECOND_TOKEN, 3600, "synthetic-refresh-B");
    const sdk = createSentrySDK({ cwd: getConfigDir() });

    process.env.SENTRY_CONFIG_DIR = firstDir;
    const pending = sdk.api({ endpoint: ENDPOINT });
    process.env.SENTRY_CONFIG_DIR = secondDir;

    await expect(pending).resolves.toMatchObject({ body: [FIRST_PROJECT] });
    expect(process.env.SENTRY_CONFIG_DIR).toBe(secondDir);
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
    const keysStarted = Promise.withResolvers<void>();
    const releaseKeys = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
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
      // project.view starts both requests; its 404 leaves /keys/ pending.
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
    cacheControl = "private, max-age=300";
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

  test("org-scoped commands resolve the same org independently across hosts and config directories", async () => {
    const firstDir = join(getConfigDir(), "first");
    const secondDir = join(getConfigDir(), "second");
    await mkdir(firstDir);
    await mkdir(secondDir);
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
});
