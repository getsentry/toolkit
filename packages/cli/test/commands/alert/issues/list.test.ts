import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listCommand } from "../../../../src/commands/alert/issues/list.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as browser from "../../../../src/lib/browser.js";
import { DEFAULT_SENTRY_URL } from "../../../../src/lib/constants.js";
import { setAuthToken } from "../../../../src/lib/db/auth.js";
import {
  setDefaultOrganization,
  setDefaultProject,
} from "../../../../src/lib/db/defaults.js";
import { setOrgRegion } from "../../../../src/lib/db/regions.js";
import type { ApiError } from "../../../../src/lib/errors.js";
import { logger } from "../../../../src/lib/logger.js";
import { mockFetch, useTestConfigDir } from "../../../helpers.js";

const getConfigDir = useTestConfigDir("test-alert-issues-list-", {
  isolateProjectRoot: true,
});

type ListFlags = {
  readonly web: boolean;
  readonly fresh: boolean;
  readonly limit: number;
  readonly cursor?: string;
  readonly json: boolean;
  readonly fields?: string[];
  readonly query?: string;
};

type ListFunc = (
  this: unknown,
  flags: ListFlags,
  target?: string
) => Promise<void>;

function createContext() {
  const stdout = {
    output: "",
    write(s: string) {
      stdout.output += s;
    },
  };
  const stderr = {
    output: "",
    write(s: string) {
      stderr.output += s;
    },
  };
  return {
    context: {
      process,
      stdout,
      stderr,
      cwd: getConfigDir(),
    },
    stdout,
  };
}

describe("alert issues list pagination", () => {
  let func: ListFunc;
  let openInBrowserSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    func = (await listCommand.loader()) as unknown as ListFunc;
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    setDefaultOrganization("test-org");
    setDefaultProject("test-project");
    openInBrowserSpy = vi.spyOn(browser, "openInBrowser");
    warnSpy = vi.spyOn(logger, "warn");
    openInBrowserSpy.mockResolvedValue(undefined);
    warnSpy.mockImplementation(() => {
      // Suppress expected partial-failure warnings in behavior tests.
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    openInBrowserSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test("hasMore is false when limit is reached without next cursor", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      if (req.url.includes("/organizations/test-org/workflows/")) {
        return new Response(
          JSON.stringify([
            {
              id: "1",
              name: "Rule Alpha",
              status: "active",
              actionMatch: "any",
              conditions: [],
              actions: [],
              frequency: 30,
              environment: null,
              owner: null,
              projects: ["test-project"],
              detectorIds: [1],
              dateCreated: "2026-01-01T00:00:00Z",
            },
          ]),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              Link: '<https://sentry.io/api/0/>; rel="next"; results="false"; cursor="0:0:0"',
            },
          }
        );
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    });

    const { context, stdout } = createContext();
    await func.call(context, {
      web: false,
      fresh: false,
      limit: 1,
      json: true,
    });

    const parsed = JSON.parse(stdout.output);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.data).toHaveLength(1);
  });

  test("empty query page keeps hasMore when next cursor exists", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      if (req.url.includes("/organizations/test-org/workflows/")) {
        return new Response(
          JSON.stringify([
            {
              id: "1",
              name: "Rule Alpha",
              status: "active",
              actionMatch: "any",
              conditions: [],
              actions: [],
              frequency: 30,
              environment: null,
              owner: null,
              projects: ["test-project"],
              detectorIds: [1],
              dateCreated: "2026-01-01T00:00:00Z",
            },
          ]),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              Link: '<https://sentry.io/api/0/>; rel="next"; results="true"; cursor="next:0:0"',
            },
          }
        );
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    });

    const { context, stdout } = createContext();
    await func.call(context, {
      web: false,
      fresh: false,
      limit: 1,
      json: true,
      query: "zzz",
    });

    const parsed = JSON.parse(stdout.output);
    expect(parsed.data).toEqual([]);
    expect(parsed.hasMore).toBe(true);
  });

  test("--web with explicit target opens browser without fetching rules", async () => {
    globalThis.fetch = mockFetch(async () => {
      throw new Error("fetch should not be called for explicit --web");
    });

    const { context } = createContext();
    await func.call(
      context,
      {
        web: true,
        fresh: false,
        limit: 30,
        json: false,
      },
      "test-org/test-project"
    );

    expect(openInBrowserSpy).toHaveBeenCalledWith(
      expect.stringContaining("test-org"),
      "issue alert rules"
    );
    expect(openInBrowserSpy).toHaveBeenCalledWith(
      expect.stringContaining("test-project"),
      "issue alert rules"
    );
  });

  test("--web falls back to an organization when no project matches the bare slug", async () => {
    setOrgRegion("acme-corp", DEFAULT_SENTRY_URL);

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/api/0/organizations/") {
        return Response.json([{ slug: "acme-corp", name: "Acme Corp" }]);
      }
      if (url.pathname === "/api/0/projects/acme-corp/acme-corp/") {
        return new Response(JSON.stringify({ detail: "Not found" }), {
          status: 404,
        });
      }
      if (url.pathname.includes("/workflows/")) {
        throw new Error("rule fetch should not be called for --web");
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    });

    const { context } = createContext();
    await func.call(
      context,
      {
        web: true,
        fresh: false,
        limit: 30,
        json: false,
      },
      "acme-corp"
    );

    expect(openInBrowserSpy).toHaveBeenCalledWith(
      expect.stringContaining("acme-corp"),
      "issue alert rules"
    );
    const openedUrl = String(openInBrowserSpy.mock.calls[0]?.[0]);
    expect(openedUrl).not.toContain("?project=");
  });

  test("--web with project search resolves target and skips rule fetch", async () => {
    setOrgRegion("org-one", DEFAULT_SENTRY_URL);

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/api/0/organizations/") {
        return Response.json([{ slug: "org-one", name: "Org One" }]);
      }
      if (url.pathname === "/api/0/projects/org-one/myproj/") {
        return Response.json({
          id: "101",
          slug: "myproj",
          name: "My Project",
        });
      }
      if (url.pathname.includes("/workflows/")) {
        throw new Error("rule fetch should not be called for --web");
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    });

    const { context } = createContext();
    await func.call(
      context,
      {
        web: true,
        fresh: false,
        limit: 30,
        json: false,
      },
      "myproj"
    );

    expect(openInBrowserSpy).toHaveBeenCalledWith(
      expect.stringContaining("org-one"),
      "issue alert rules"
    );
    expect(openInBrowserSpy).toHaveBeenCalledWith(
      expect.stringContaining("myproj"),
      "issue alert rules"
    );
  });

  test("--web with project search rejects multi-org targets before fetching rules", async () => {
    setOrgRegion("org-one", DEFAULT_SENTRY_URL);
    setOrgRegion("org-two", DEFAULT_SENTRY_URL);

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/api/0/organizations/") {
        return Response.json([
          { slug: "org-one", name: "Org One" },
          { slug: "org-two", name: "Org Two" },
        ]);
      }
      const projectMatch = url.pathname.match(
        /\/api\/0\/projects\/([^/]+)\/myproj\//
      );
      if (projectMatch) {
        const org = projectMatch[1] as string;
        return Response.json({
          id: `${org}-id`,
          slug: "myproj",
          name: "My Project",
        });
      }
      if (url.pathname.includes("/workflows/")) {
        throw new Error("rule fetch should not be called for --web");
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    });

    const { context } = createContext();
    await expect(
      func.call(
        context,
        {
          web: true,
          fresh: false,
          limit: 30,
          json: false,
        },
        "myproj"
      )
    ).rejects.toThrow("multiple organizations");

    expect(openInBrowserSpy).not.toHaveBeenCalled();
  });

  test("does not intercept a project slug named issues as an alert subcommand", async () => {
    setOrgRegion("org-one", DEFAULT_SENTRY_URL);

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/api/0/organizations/") {
        return Response.json([{ slug: "org-one", name: "Org One" }]);
      }
      if (url.pathname === "/api/0/projects/org-one/issues/") {
        return Response.json({
          id: "202",
          slug: "issues",
          name: "Issues Project",
        });
      }
      if (url.pathname === "/api/0/organizations/org-one/workflows/") {
        return Response.json([
          {
            id: "issues-rule",
            name: "Issues Rule",
            status: "active",
            actionMatch: "any",
            conditions: [],
            actions: [],
            frequency: 30,
            environment: null,
            owner: null,
            projects: ["issues"],
            detectorIds: [1],
            dateCreated: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    });

    const { context, stdout } = createContext();
    await func.call(
      context,
      {
        web: false,
        fresh: false,
        limit: 10,
        json: false,
      },
      "issues"
    );

    expect(stdout.output).toContain("issues-rule");
    expect(stdout.output).toContain("Issues Rule");
  });

  test("rejects issue alert list limits outside the shared range", async () => {
    const { context } = createContext();
    await expect(
      func.call(
        context,
        { web: false, fresh: false, limit: 0, json: true },
        "test-org/test-project"
      )
    ).rejects.toThrow("--limit must be at least 1");
    await expect(
      func.call(
        context,
        { web: false, fresh: false, limit: 1001, json: true },
        "test-org/test-project"
      )
    ).rejects.toThrow("--limit cannot exceed 1000");
  });

  test("human output includes project column for multi-project results", async () => {
    setOrgRegion("org-one", DEFAULT_SENTRY_URL);
    setOrgRegion("org-two", DEFAULT_SENTRY_URL);

    const rule = (org: string) => ({
      id: `${org}-1`,
      name: `${org} Rule`,
      status: org === "org-one" ? "active" : "disabled",
      actionMatch: "any",
      conditions: [{ id: "condition-a" }],
      actions: [{ id: "action-a" }],
      frequency: 30,
      environment: "prod",
      owner: null,
      projects: ["myproj"],
      detectorIds: [1],
      dateCreated: "2026-01-01T00:00:00Z",
    });

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      const ruleMatch = url.pathname.match(
        /\/api\/0\/organizations\/([^/]+)\/workflows\//
      );
      if (ruleMatch) {
        return Response.json([rule(ruleMatch[1] as string)]);
      }
      if (url.pathname === "/api/0/organizations/") {
        return Response.json([
          { slug: "org-one", name: "Org One" },
          { slug: "org-two", name: "Org Two" },
        ]);
      }
      const projectMatch = url.pathname.match(
        /\/api\/0\/projects\/([^/]+)\/myproj\//
      );
      if (projectMatch) {
        const org = projectMatch[1] as string;
        return Response.json({
          id: `${org}-id`,
          slug: "myproj",
          name: "My Project",
        });
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    });

    const { context, stdout } = createContext();
    await func.call(
      context,
      {
        web: false,
        fresh: false,
        limit: 10,
        json: false,
      },
      "myproj"
    );

    expect(stdout.output).toContain("Issue alert rules from 2 projects:");
    expect(stdout.output).toContain("PROJECT");
    expect(stdout.output).toContain("org-one");
    expect(stdout.output).toContain("org-two");
    expect(stdout.output).toContain("myproj");
    expect(stdout.output).toContain("Rule");
    expect(stdout.output).toContain("prod");
  });

  test("partial project failure warns and still returns successful issue rules", async () => {
    setOrgRegion("org-one", DEFAULT_SENTRY_URL);
    setOrgRegion("org-two", DEFAULT_SENTRY_URL);

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      const ruleMatch = url.pathname.match(
        /\/api\/0\/organizations\/([^/]+)\/workflows\//
      );
      if (ruleMatch) {
        const org = ruleMatch[1] as string;
        if (org === "org-two") {
          return new Response(JSON.stringify({ detail: "boom" }), {
            status: 500,
          });
        }
        return Response.json([
          {
            id: "ok-1",
            name: "Surviving Rule",
            status: "active",
            actionMatch: "any",
            conditions: [],
            actions: [],
            frequency: 30,
            environment: null,
            owner: null,
            projects: ["myproj"],
            detectorIds: [1],
            dateCreated: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (url.pathname === "/api/0/organizations/") {
        return Response.json([
          { slug: "org-one", name: "Org One" },
          { slug: "org-two", name: "Org Two" },
        ]);
      }
      const projectMatch = url.pathname.match(
        /\/api\/0\/projects\/([^/]+)\/myproj\//
      );
      if (projectMatch) {
        const org = projectMatch[1] as string;
        return Response.json({
          id: `${org}-id`,
          slug: "myproj",
          name: "My Project",
        });
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    });

    const { context, stdout } = createContext();
    await func.call(
      context,
      {
        web: false,
        fresh: false,
        limit: 10,
        json: true,
      },
      "myproj"
    );

    const parsed = JSON.parse(stdout.output);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].name).toBe("Surviving Rule");
    expect(parsed.errors).toEqual([
      expect.objectContaining({
        project: "org-two/myproj",
        status: 500,
        message: expect.stringContaining("API request failed"),
      }),
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to fetch alert rules from org-two/myproj")
    );
  });

  test("all project failures preserve ApiError status and endpoint", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/api/0/projects/test-org/test-project/") {
        return Response.json({
          id: "101",
          slug: "test-project",
          name: "Test Project",
        });
      }
      if (url.pathname === "/api/0/organizations/test-org/workflows/") {
        return new Response(JSON.stringify({ detail: "scope denied" }), {
          status: 403,
        });
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    });

    const { context } = createContext();
    await expect(
      func.call(
        context,
        {
          web: false,
          fresh: false,
          limit: 10,
          json: true,
        },
        "test-org/test-project"
      )
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
      endpoint: "/organizations/test-org/workflows/",
    } satisfies Partial<ApiError>);
  });

  test("distributes multi-project budget exactly without over-fetching", async () => {
    setOrgRegion("org-one", DEFAULT_SENTRY_URL);
    setOrgRegion("org-two", DEFAULT_SENTRY_URL);
    setOrgRegion("org-three", DEFAULT_SENTRY_URL);
    const perPageByOrg = new Map<string, number>();

    const rule = (org: string, index: number) => ({
      id: `${org}-${index}`,
      name: `${org} Rule ${index}`,
      status: "active",
      actionMatch: "any",
      conditions: [],
      actions: [],
      frequency: 30,
      environment: null,
      owner: null,
      projects: ["myproj"],
      detectorIds: [1],
      dateCreated: "2026-01-01T00:00:00Z",
    });

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      const ruleMatch = url.pathname.match(
        /\/api\/0\/organizations\/([^/]+)\/workflows\//
      );
      if (ruleMatch) {
        const org = ruleMatch[1] as string;
        const perPage = Number(url.searchParams.get("per_page"));
        perPageByOrg.set(org, perPage);
        return new Response(
          JSON.stringify(
            Array.from({ length: perPage }, (_, i) => rule(org, i + 1))
          ),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              Link: `<https://sentry.io/api/0/>; rel="next"; results="true"; cursor="${org}-next:0:0"`,
            },
          }
        );
      }

      if (url.pathname === "/api/0/organizations/") {
        return Response.json([
          { slug: "org-one", name: "Org One" },
          { slug: "org-two", name: "Org Two" },
          { slug: "org-three", name: "Org Three" },
        ]);
      }

      const projectMatch = url.pathname.match(
        /\/api\/0\/projects\/([^/]+)\/myproj\//
      );
      if (projectMatch) {
        const org = projectMatch[1] as string;
        return Response.json({
          id: `${org}-id`,
          slug: "myproj",
          name: "My Project",
        });
      }

      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    });

    const { context, stdout } = createContext();
    await func.call(
      context,
      {
        web: false,
        fresh: false,
        limit: 10,
        json: true,
      },
      "myproj"
    );

    const parsed = JSON.parse(stdout.output);
    expect(parsed.data).toHaveLength(10);
    expect(Object.fromEntries(perPageByOrg)).toEqual({
      "org-one": 4,
      "org-two": 3,
      "org-three": 3,
    });
  });
});
