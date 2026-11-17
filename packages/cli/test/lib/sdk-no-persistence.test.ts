/**
 * `createSentrySDK()` persistence: by default commands read what the CLI
 * stored and `.sentryclirc` files, but write nothing to disk.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import createSentrySDK from "../../src/index.js";
import {
  resetAuthRowCache,
  resetAuthTokenCache,
  setAuthToken,
} from "../../src/lib/db/auth.js";
import { closeDatabase, getDbPath } from "../../src/lib/db/index.js";
import { withEnv } from "../../src/lib/env.js";
import { mockFetch } from "../helpers.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

const TEAMS_LINK =
  '<https://sentry.io/api/0/organizations/acme/teams/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ' +
  '<https://sentry.io/api/0/organizations/acme/teams/?cursor=0:1:0>; rel="next"; results="true"; cursor="0:1:0"';

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

type RecordedRequest = {
  method: string;
  url: URL;
  authorization: string | null;
};

/** Whether a request went to sentry.io (or one of its region hosts). */
function isSentryHost({ url }: RecordedRequest): boolean {
  return url.hostname === "sentry.io" || url.hostname.endsWith(".sentry.io");
}

/** Answers the endpoints the tests call; records every request. */
function sentryApi(requests: RecordedRequest[]): typeof fetch {
  return mockFetch(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({
      method: request.method,
      url,
      authorization: request.headers.get("Authorization"),
    });
    const path = url.pathname;
    if (path === "/api/0/organizations/acme/") {
      return json({ id: "1", slug: "acme", name: "Acme" });
    }
    if (path === "/api/0/projects/acme/frontend/") {
      return json({ id: "2", slug: "frontend", name: "Frontend" });
    }
    if (path === "/api/0/projects/acme/frontend/keys/") {
      return json([]);
    }
    if (path === "/api/0/organizations/acme/shortids/FRONTEND-1/") {
      return json({
        organizationSlug: "acme",
        projectSlug: "frontend",
        groupId: "100",
        group: {
          id: "100",
          shortId: "FRONTEND-1",
          title: "Error",
          status: "unresolved",
          project: { id: "2", slug: "frontend", name: "Frontend" },
        },
      });
    }
    if (path.endsWith("/issues/100/") && request.method === "PUT") {
      return json({ id: "100", shortId: "FRONTEND-1", status: "resolved" });
    }
    if (path === "/api/0/organizations/acme/teams/") {
      const cursor = url.searchParams.get("cursor");
      const team = cursor
        ? { id: "4", slug: "backend", name: "Backend" }
        : { id: "3", slug: "web", name: "Web" };
      return json(
        [{ ...team, memberCount: 1 }],
        cursor ? {} : { Link: TEAMS_LINK },
      );
    }
    return new Response(JSON.stringify({ detail: "Not found" }), {
      status: 404,
      headers: JSON_HEADERS,
    });
  });
}

describe("createSentrySDK() without persist", () => {
  let root: string;
  let configDir: string;
  let requests: RecordedRequest[];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sdk-no-persistence-"));
    configDir = join(root, "config");
    requests = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = sentryApi(requests);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    closeDatabase();
    rmSync(root, { recursive: true, force: true });
  });

  /** The base env for each call, as `test/preload.ts` sets for the rest. */
  function testEnv() {
    return { SENTRY_CONFIG_DIR: configDir, SENTRY_CLI_NO_TELEMETRY: "1" };
  }

  function sdk() {
    return createSentrySDK({
      token: "sntrys_no-persistence-test",
      cwd: root,
      env: testEnv(),
    });
  }

  /** Store a login in `cli.db` the way `sentry auth login` does. */
  function storeLogin(token: string): string {
    mkdirSync(configDir, { recursive: true });
    const dbPath = withEnv(testEnv(), () => {
      setAuthToken(token);
      return getDbPath();
    });
    closeDatabase();
    resetAuthTokenCache();
    resetAuthRowCache();
    return dbPath;
  }

  test("runs a read command", async () => {
    const project = await sdk().project.view({ orgProject: "acme/frontend" });

    expect(JSON.stringify(project)).toContain('"slug":"frontend"');
    expect(existsSync(configDir)).toBe(false);
  });

  test("runs a write command", async () => {
    await sdk().issue.resolve({ issue: "acme/FRONTEND-1" });

    expect(
      requests.some(
        (r) => r.method === "PUT" && r.url.pathname.includes("/100/"),
      ),
    ).toBe(true);
    expect(existsSync(configDir)).toBe(false);
  });

  test("pages a list with the returned cursor and rejects --cursor next", async () => {
    const client = sdk();
    const first = await client.team.list({ orgProject: "acme/", limit: 1 });
    expect(first.data.map((team) => team.slug)).toEqual(["web"]);
    expect(first.nextCursor).toBeTruthy();

    const second = await client.team.list({
      orgProject: "acme/",
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.data.map((team) => team.slug)).toEqual(["backend"]);

    await expect(
      client.team.list({ orgProject: "acme/", limit: 1, cursor: "next" }),
    ).rejects.toThrow(/persist: true/);
    expect(existsSync(configDir)).toBe(false);
  });

  test("env replaces process.env", async () => {
    const saved = process.env.SENTRY_HOST;
    process.env.SENTRY_HOST = "https://ignored.example.com";
    try {
      await sdk().project.view({ orgProject: "acme/frontend" });
    } finally {
      if (saved === undefined) {
        delete process.env.SENTRY_HOST;
      } else {
        process.env.SENTRY_HOST = saved;
      }
    }

    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(isSentryHost)).toBe(true);
  });

  test("reads .sentryclirc", async () => {
    writeFileSync(
      join(root, ".sentryclirc"),
      "[defaults]\norg = acme\nproject = frontend\n",
    );

    await sdk().project.view({});

    expect(
      requests.some((r) => r.url.pathname === "/api/0/projects/acme/frontend/"),
    ).toBe(true);
    expect(existsSync(configDir)).toBe(false);
  });

  test("reads a stored login and leaves cli.db unchanged", async () => {
    const dbPath = storeLogin("sntrys_stored-login");
    const before = readFileSync(dbPath);

    await createSentrySDK({
      cwd: root,
      env: testEnv(),
    }).project.view({ orgProject: "acme/frontend" });
    closeDatabase();

    expect(requests.at(-1)?.authorization).toBe("Bearer sntrys_stored-login");
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });

  test("writes local state with persist: true", async () => {
    await createSentrySDK({
      token: "sntrys_no-persistence-test",
      persist: true,
      cwd: root,
      env: testEnv(),
    }).project.view({ orgProject: "acme/frontend" });

    expect(existsSync(configDir)).toBe(true);
  });
});
