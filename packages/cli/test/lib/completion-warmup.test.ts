/**
 * Tests for the attribute-key warm-up that `auth login` and `cli setup` run
 * (src/lib/completion-warmup.ts), against a real SQLite database and a
 * mocked fetch.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as apiClient from "../../src/lib/api-client.js";
import { getCompletions } from "../../src/lib/complete.js";
import {
  MAX_RECENT_ORGS,
  pickWarmupOrgs,
  RECENT_ORG_WINDOW_MS,
  WARMUP_TIMEOUT_MS,
  warmAttributeCompletions,
  warmCachesAfterLogin,
} from "../../src/lib/completion-warmup.js";
import { setAuthToken } from "../../src/lib/db/auth.js";
import {
  cacheCompletionEntities,
  getCachedCompletionEntities,
  MAX_ENTITIES_PER_ORG,
} from "../../src/lib/db/completion-cache.js";
import { setDefaultOrganization } from "../../src/lib/db/defaults.js";
import { setCachedProject } from "../../src/lib/db/project-cache.js";
import { setOrgRegions } from "../../src/lib/db/regions.js";
import { resetAuthenticatedFetch } from "../../src/lib/sentry-client.js";
import { mockFetch, useTestConfigDir } from "../helpers.js";

useTestConfigDir("test-completion-warmup-");

const REGION = "https://us.sentry.io";

/** Orgs the active account can reach, with their region cached. */
function seedOrgs(...slugs: string[]): void {
  setOrgRegions(
    slugs.map((slug) => ({
      slug,
      regionUrl: REGION,
      orgId: slug,
      orgName: slug,
    })),
  );
}

/** Record that a command resolved a project of `org` at `when`. */
function useOrg(org: string, when: number): void {
  vi.useFakeTimers({ toFake: ["Date"], now: when });
  try {
    setCachedProject(org, "1", {
      orgSlug: org,
      orgName: org,
      projectSlug: "app",
      projectName: "App",
    });
  } finally {
    vi.useRealTimers();
  }
}

type Captured = { org: string; dataset: string | null; params: string[] };

let originalFetch: typeof globalThis.fetch;
let requests: Captured[];

/** Answer every attributes request with `respond`, recording each one. */
function mockAttributes(
  respond: (request: Captured, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = mockFetch(async (input, init) => {
    const request = new Request(input!, init);
    const url = new URL(request.url);
    const captured = {
      org: url.pathname.split("/")[4] ?? "",
      dataset: url.searchParams.get("dataset"),
      params: [...url.searchParams.keys()],
    };
    requests.push(captured);
    return await respond(captured, { signal: request.signal });
  });
}

const attribute = (key: string, source: "sentry" | "user") => ({
  key,
  name: key,
  attributeType: "string",
  attributeSource: { source_type: source },
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  requests = [];
  resetAuthenticatedFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAuthenticatedFetch();
});

describe("pickWarmupOrgs", () => {
  beforeEach(() => {
    setAuthToken("test-token");
  });

  test("the default org, then the most recently used orgs, up to the limit", () => {
    const now = Date.now();
    seedOrgs("default", "a", "b", "c", "d");
    setDefaultOrganization("default");
    useOrg("d", now - 4000);
    useOrg("c", now - 3000);
    useOrg("b", now - 2000);
    useOrg("a", now - 1000);
    useOrg("default", now);

    const picked = pickWarmupOrgs(now);
    expect(picked).toEqual(["default", "a", "b", "c"]);
    expect(picked).toHaveLength(1 + MAX_RECENT_ORGS);
  });

  test("skips orgs the account has no cached region for, and orgs not used lately", () => {
    const now = Date.now();
    seedOrgs("mine", "old", "other");
    setDefaultOrganization("elsewhere");
    useOrg("stranger", now);
    useOrg("old", now - RECENT_ORG_WINDOW_MS - 1000);
    useOrg("mine", now - 1000);

    expect(pickWarmupOrgs(now)).toEqual(["mine"]);
  });

  test("counts entities a command listed as use, but not warmed attribute keys", () => {
    seedOrgs("listed", "warmed", "third");
    cacheCompletionEntities("span-attribute", "warmed", [{ value: "span.op" }]);
    cacheCompletionEntities("issue", "listed", [{ value: "CLI-1" }]);

    expect(pickWarmupOrgs()).toEqual(["listed"]);
  });

  test("without a default or history, only the sole org of an account", () => {
    seedOrgs("only");
    expect(pickWarmupOrgs()).toEqual(["only"]);

    seedOrgs("only", "second");
    expect(pickWarmupOrgs()).toEqual([]);
  });
});

describe("warmAttributeCompletions", () => {
  test("does nothing without a stored login", async () => {
    mockAttributes(async () => Response.json([]));
    await warmAttributeCompletions();
    expect(requests).toEqual([]);
  });

  describe("with a stored login", () => {
    beforeEach(() => {
      setAuthToken("test-token");
      seedOrgs("acme");
    });

    test("requests every dataset once, with all attribute types, and seeds completion", async () => {
      // A large org: user keys sorted by name fill a page before Sentry's
      // aliases, which the endpoint appends after them.
      const userKeys = Array.from(
        { length: MAX_ENTITIES_PER_ORG + 100 },
        (_, i) => attribute(`app.${String(i).padStart(4, "0")}`, "user"),
      );
      mockAttributes(async ({ dataset }) =>
        Response.json(
          dataset === "spans"
            ? [...userKeys, attribute("span.duration", "sentry")]
            : [],
        ),
      );

      await warmAttributeCompletions();

      expect(
        requests
          .map((r) => String(r.dataset))
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual(["logs", "spans", "tracemetrics"]);
      expect(new Set(requests.map((r) => r.org))).toEqual(new Set(["acme"]));
      expect(requests.every((r) => r.params.join() === "dataset")).toBe(true);

      const cached = getCachedCompletionEntities("span-attribute", ["acme"]);
      expect(cached).toHaveLength(MAX_ENTITIES_PER_ORG);
      expect(cached[0]?.value).toBe("span.duration");
      expect(
        (await getCompletions(["explore", "-d", "spans", "-F"], "span.d")).map(
          (c) => c.value,
        ),
      ).toContain("span.duration");
    });

    test("skips datasets fetched within refreshAfterMs", async () => {
      cacheCompletionEntities("span-attribute", "acme", [{ value: "span.op" }]);
      mockAttributes(async () => Response.json([]));

      await warmAttributeCompletions({ refreshAfterMs: 60_000 });

      expect(
        requests
          .map((r) => String(r.dataset))
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual(["logs", "tracemetrics"]);
    });

    test.each([
      ["a 404 (no trace-items feature)", 404],
      ["a 403", 403],
      ["a 500", 500],
    ])("resolves quietly on %s", async (_, status) => {
      mockAttributes(async () => Response.json({ detail: "nope" }, { status }));

      await expect(warmAttributeCompletions()).resolves.toBeUndefined();
      expect(getCachedCompletionEntities("span-attribute", ["acme"])).toEqual(
        [],
      );
    });

    test("resolves quietly on a network error", async () => {
      mockAttributes(async () => {
        throw new TypeError("fetch failed");
      });

      await expect(warmAttributeCompletions()).resolves.toBeUndefined();
    });

    test("aborts requests that outlast the timeout", async () => {
      const aborted: boolean[] = [];
      mockAttributes(
        (_, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted.push(true);
              reject(init.signal?.reason);
            });
          }),
      );

      const started = Date.now();
      await expect(warmAttributeCompletions()).resolves.toBeUndefined();
      const elapsed = Date.now() - started;

      expect(elapsed).toBeGreaterThanOrEqual(WARMUP_TIMEOUT_MS - 50);
      expect(elapsed).toBeLessThan(WARMUP_TIMEOUT_MS + 1000);
      expect(aborted).toHaveLength(3);
    });
  });
});

describe("warmCachesAfterLogin", () => {
  beforeEach(() => {
    setAuthToken("test-token");
    mockAttributes(async () => Response.json([]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("lists orgs, then warms the orgs that list cached", async () => {
    vi.spyOn(apiClient, "listOrganizationsUncached").mockImplementation(
      async () => {
        seedOrgs("acme");
        return [];
      },
    );

    await warmCachesAfterLogin();

    expect(new Set(requests.map((r) => r.org))).toEqual(new Set(["acme"]));
    expect(requests).toHaveLength(3);
  });

  test("skips the attribute warm-up when the org list fails", async () => {
    vi.spyOn(apiClient, "listOrganizationsUncached").mockRejectedValue(
      new Error("offline"),
    );
    seedOrgs("acme");

    await expect(warmCachesAfterLogin()).resolves.toBeUndefined();
    expect(requests).toEqual([]);
  });

  test("skips the attribute warm-up when the org list stalls", async () => {
    vi.spyOn(apiClient, "listOrganizationsUncached").mockReturnValue(
      new Promise(() => {
        // never settles
      }),
    );
    seedOrgs("acme");

    const started = Date.now();
    await expect(warmCachesAfterLogin()).resolves.toBeUndefined();

    expect(Date.now() - started).toBeLessThan(WARMUP_TIMEOUT_MS + 1000);
    expect(requests).toEqual([]);
  });
});
