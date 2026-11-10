/**
 * `createSentrySDK()` clients that share one process keep their own
 * credentials, region, headers, results, and per-call state, both when their
 * calls overlap and when they run one after another (#1898, #1391).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import createSentrySDK from "../../src/index.js";
import {
  refreshToken,
  resetAuthRowCache,
  resetAuthTokenCache,
  setAuthToken,
} from "../../src/lib/db/auth.js";
import { closeDatabase } from "../../src/lib/db/index.js";
import { withEnv } from "../../src/lib/env.js";
import { isSentrySaasUrl } from "../../src/lib/sentry-urls.js";
import { mockFetch } from "../helpers.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

const TOKEN_A = "sntryu_isolation-identity-a";
const TOKEN_B = "sntryu_isolation-identity-b";
const PROJECT_PATH = "/api/0/projects/acme/frontend/";

type RecordedRequest = {
  host: string;
  path: string;
  authorization: string | null;
  proxyHeader: string | null;
};

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

/** The identity letter a request authenticated as, or undefined. */
function identityOf(authorization: string | null): "A" | "B" | undefined {
  if (authorization === `Bearer ${TOKEN_A}`) {
    return "A";
  }
  if (authorization === `Bearer ${TOKEN_B}`) {
    return "B";
  }
  return;
}

/**
 * A Sentry API where the same org slug lives in a different region for each
 * identity, and every body names the identity that asked for it. Responses
 * wait until `overlap` identities have sent a request, so the calls run
 * concurrently instead of one after another.
 */
function sentryApi(requests: RecordedRequest[], overlap = 1): typeof fetch {
  const seen = new Set<string>();
  const allInFlight = Promise.withResolvers<void>();
  return mockFetch(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const authorization = request.headers.get("Authorization");
    requests.push({
      host: url.host,
      path: url.pathname,
      authorization,
      proxyHeader: request.headers.get("X-Proxy-Identity"),
    });
    const identity = identityOf(authorization);
    if (!identity) {
      return new Response(JSON.stringify({ detail: "Invalid token" }), {
        status: 401,
        headers: JSON_HEADERS,
      });
    }
    seen.add(identity);
    if (seen.size >= overlap) {
      allInFlight.resolve();
    }
    await allInFlight.promise;

    if (url.pathname === "/api/0/organizations/acme/") {
      // SaaS splits regions per identity; a self-hosted host is its own region.
      const regionUrl = isSentrySaasUrl(url.href)
        ? `https://${identity === "A" ? "us" : "de"}.sentry.io`
        : url.origin;
      return json({
        id: "1",
        slug: "acme",
        name: "Acme",
        links: { regionUrl },
      });
    }
    if (url.pathname === PROJECT_PATH) {
      return json(
        { id: "2", slug: "frontend", name: `Frontend ${identity}` },
        { "Cache-Control": "private, max-age=300", Vary: "Authorization" },
      );
    }
    return new Response(JSON.stringify({ detail: "Not found" }), {
      status: 404,
      headers: JSON_HEADERS,
    });
  });
}

describe("createSentrySDK() clients in one process", () => {
  let root: string;
  let requests: RecordedRequest[];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sdk-concurrent-isolation-"));
    requests = [];
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    closeDatabase();
    resetAuthTokenCache();
    resetAuthRowCache();
    rmSync(root, { recursive: true, force: true });
  });

  function testEnv(configDir = join(root, "config")) {
    return { SENTRY_CONFIG_DIR: configDir, SENTRY_CLI_NO_TELEMETRY: "1" };
  }

  function sdk(options: Parameters<typeof createSentrySDK>[0] = {}) {
    return createSentrySDK({ cwd: root, env: testEnv(), ...options });
  }

  /**
   * Wait for the response cache to hold `count` entries for the project
   * endpoint (one per identity). Cache writes are fire-and-forget, so a call
   * can return before its entry lands. Writes go through a `.tmp` file that
   * is then renamed, so only finished `.json` entries count.
   */
  async function waitForProjectCacheEntries(count: number): Promise<void> {
    const dir = join(root, "config", "cache", "api-responses");
    await vi.waitFor(() => {
      const entries = existsSync(dir) ? readdirSync(dir) : [];
      const projectEntries = entries.filter(
        (entry) =>
          entry.endsWith(".json") &&
          readFileSync(join(dir, entry), "utf8").includes(PROJECT_PATH),
      );
      expect(projectEntries).toHaveLength(count);
    });
  }

  /** The identity letter behind each host, from what the mock saw. */
  function identitiesByHost(): Record<string, string[]> {
    const byHost: Record<string, Set<string>> = {};
    for (const request of requests) {
      const identity = identityOf(request.authorization) ?? "none";
      byHost[request.host] ??= new Set();
      byHost[request.host]?.add(identity);
    }
    return Object.fromEntries(
      Object.entries(byHost).map(([host, ids]) => [host, [...ids].sort()]),
    );
  }

  test("concurrent identities resolve the same org to their own region", async () => {
    globalThis.fetch = sentryApi(requests, 2);

    const [a, b] = await Promise.all([
      sdk({ token: TOKEN_A }).project.view({ orgProject: "acme/frontend" }),
      sdk({ token: TOKEN_B }).project.view({ orgProject: "acme/frontend" }),
    ]);

    expect(JSON.stringify(a)).toContain('"name":"Frontend A"');
    expect(JSON.stringify(b)).toContain('"name":"Frontend B"');
    expect(identitiesByHost()).toMatchObject({
      "us.sentry.io": ["A"],
      "de.sentry.io": ["B"],
    });
  });

  test("concurrent self-hosted identities send only their own headers", async () => {
    globalThis.fetch = sentryApi(requests, 2);

    const [a, b] = await Promise.all([
      sdk({
        token: TOKEN_A,
        url: "https://a.example.com",
        headers: { "X-Proxy-Identity": "A" },
      }).project.view({ orgProject: "acme/frontend" }),
      sdk({
        token: TOKEN_B,
        url: "https://b.example.com",
        headers: { "X-Proxy-Identity": "B" },
      }).project.view({ orgProject: "acme/frontend" }),
    ]);

    expect(JSON.stringify(a)).toContain('"name":"Frontend A"');
    expect(JSON.stringify(b)).toContain('"name":"Frontend B"');
    const seen = requests.map(({ host, authorization, proxyHeader }) => ({
      host,
      identity: identityOf(authorization),
      proxyHeader,
    }));
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      const expected = request.host === "a.example.com" ? "A" : "B";
      expect(request).toEqual({
        host: request.host,
        identity: expected,
        proxyHeader: expected,
      });
    }
  });

  // #1391: three clients share a config dir and the response cache.
  test("sequential clients with a shared cache get their own results", async () => {
    globalThis.fetch = sentryApi(requests);
    const persisted = { persist: true } as const;

    const first = await sdk({ ...persisted, token: TOKEN_A }).project.view({
      orgProject: "acme/frontend",
    });
    await waitForProjectCacheEntries(1);
    const second = await sdk({ ...persisted, token: TOKEN_B }).project.view({
      orgProject: "acme/frontend",
    });
    await waitForProjectCacheEntries(2);
    const malformed = sdk({
      ...persisted,
      token: "synthetic\nbad-token",
    }).project.view({ orgProject: "acme/frontend" });

    expect(JSON.stringify(first)).toContain('"name":"Frontend A"');
    expect(JSON.stringify(second)).toContain('"name":"Frontend B"');
    await expect(malformed).rejects.toThrow();
    expect(
      requests
        .filter((request) => request.path === PROJECT_PATH)
        .map((request) => identityOf(request.authorization)),
    ).toEqual(["A", "B"]);
  });

  // #1391: a cached request does not change which identity a later
  // uncached call uses, and the cached call still sees its own entry.
  test("cached and uncached calls keep their own identity", async () => {
    globalThis.fetch = sentryApi(requests);

    const cachedA = sdk({ persist: true, token: TOKEN_A });
    await cachedA.project.view({ orgProject: "acme/frontend" });
    await waitForProjectCacheEntries(1);
    const uncachedB = await sdk({ token: TOKEN_B }).project.view({
      orgProject: "acme/frontend",
    });
    const cachedAgain = await cachedA.project.view({
      orgProject: "acme/frontend",
    });

    expect(JSON.stringify(uncachedB)).toContain('"name":"Frontend B"');
    expect(JSON.stringify(cachedAgain)).toContain('"name":"Frontend A"');
    expect(
      requests
        .filter((request) => request.path === PROJECT_PATH)
        .map((request) => identityOf(request.authorization)),
    ).toEqual(["A", "B"]);
  });

  // #1391: per-client config dirs with their own stored login. Only a token
  // refresh reads the memoized login row, so this drives `refreshToken()`
  // under each call's env copy, the way an SDK call's auth path does.
  test("calls with different config dirs refresh from their own stored login", async () => {
    const envA = testEnv(join(root, "config-a"));
    const envB = testEnv(join(root, "config-b"));
    for (const [env, token] of [
      [envA, TOKEN_A],
      [envB, TOKEN_B],
    ] as const) {
      mkdirSync(env.SENTRY_CONFIG_DIR, { recursive: true });
      withEnv(env, () => setAuthToken(token));
      closeDatabase();
    }
    resetAuthTokenCache();
    resetAuthRowCache();

    const refreshedA = await withEnv({ ...envA }, () => refreshToken());
    closeDatabase();
    const refreshedB = await withEnv({ ...envB }, () => refreshToken());

    expect(refreshedA.token).toBe(TOKEN_A);
    expect(refreshedB.token).toBe(TOKEN_B);
  });

  test("--fresh in one call leaves the next call's cache reads on", async () => {
    globalThis.fetch = sentryApi(requests);
    const client = sdk({ persist: true, token: TOKEN_A });

    await client.run("project", "view", "acme/frontend", "--fresh");
    await waitForProjectCacheEntries(1);
    await client.run("project", "view", "acme/frontend");

    expect(
      requests.filter((request) => request.path === PROJECT_PATH),
    ).toHaveLength(1);
  });
});
