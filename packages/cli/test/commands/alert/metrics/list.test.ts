import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listCommand } from "../../../../src/commands/alert/metrics/list.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as browser from "../../../../src/lib/browser.js";
import { DEFAULT_SENTRY_URL } from "../../../../src/lib/constants.js";
import { setAuthToken } from "../../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../../src/lib/db/regions.js";
import type { ApiError } from "../../../../src/lib/errors.js";
import { logger } from "../../../../src/lib/logger.js";
import { mockFetch, useTestConfigDir } from "../../../helpers.js";

const getConfigDir = useTestConfigDir("test-alert-metrics-list-", {
  isolateProjectRoot: true,
});

/**
 * Fixed `dateCreated` for detector fixtures. Detectors always carry a creation
 * timestamp, so the builder stamps this deterministic value; the exact instant
 * is arbitrary and not asserted on — only its presence matters.
 */
const DETECTOR_DATE_CREATED = "2026-01-01T00:00:00Z";

/**
 * Build a metric-issue detector payload (the shape returned by the org-scoped
 * `/detectors/` endpoint) from the flat metric-alert fields the assertions use.
 * `status` 1 maps to a disabled detector (`enabled: false`); anything else is
 * enabled.
 */
function detector(fields: {
  id: string;
  name: string;
  status?: number;
  query?: string;
  aggregate?: string;
  dataset?: string;
  timeWindow?: number;
  environment?: string | null;
  projects?: string[];
  dateCreated?: string;
}) {
  // Detectors are project-scoped (`projectSlug`) and expose the window in
  // seconds, so mirror that here; the builder accepts minutes for readability.
  const [projectSlug] = fields.projects ?? [];
  return {
    id: fields.id,
    name: fields.name,
    type: "metric_issue",
    enabled: fields.status !== 1,
    projectSlug: projectSlug ?? null,
    owner: null,
    dateCreated: fields.dateCreated ?? DETECTOR_DATE_CREATED,
    dataSources: [
      {
        aggregate: fields.aggregate ?? "count()",
        dataset: fields.dataset ?? "errors",
        query: fields.query ?? "event.type:error",
        timeWindow: (fields.timeWindow ?? 5) * 60,
        environment: fields.environment ?? null,
      },
    ],
    conditionGroup: null,
    config: { detectionType: "static" },
  };
}

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

describe("alert metrics list pagination", () => {
  let func: ListFunc;
  let openInBrowserSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    func = (await listCommand.loader()) as unknown as ListFunc;
    await setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
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
      if (req.url.includes("/organizations/test-org/detectors/")) {
        return new Response(
          JSON.stringify([detector({ id: "1", name: "Metric Rule Alpha" })]),
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
    await func.call(
      context,
      {
        web: false,
        fresh: false,
        limit: 1,
        json: true,
      },
      "test-org/"
    );

    const parsed = JSON.parse(stdout.output);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.data).toHaveLength(1);
  });

  test("empty query page keeps hasMore when next cursor exists", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      if (req.url.includes("/organizations/test-org/detectors/")) {
        return new Response(
          JSON.stringify([detector({ id: "1", name: "Metric Rule Alpha" })]),
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
    await func.call(
      context,
      {
        web: false,
        fresh: false,
        limit: 1,
        json: true,
        query: "zzz",
      },
      "test-org/"
    );

    const parsed = JSON.parse(stdout.output);
    expect(parsed.data).toEqual([]);
    expect(parsed.hasMore).toBe(true);
  });

  test("--web with explicit org opens browser without fetching rules", async () => {
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
      "test-org/"
    );

    expect(openInBrowserSpy).toHaveBeenCalledWith(
      expect.stringContaining("test-org"),
      "metric alert rules"
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
      if (url.pathname.includes("/detectors/")) {
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
      "metric alert rules"
    );
  });

  test("--web with project search resolves org and skips rule fetch", async () => {
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
      if (url.pathname.includes("/detectors/")) {
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
      "metric alert rules"
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
      if (url.pathname.includes("/detectors/")) {
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

  test("does not intercept a project slug named metrics as an alert subcommand", async () => {
    setOrgRegion("org-one", DEFAULT_SENTRY_URL);

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/api/0/organizations/") {
        return Response.json([{ slug: "org-one", name: "Org One" }]);
      }
      if (url.pathname === "/api/0/projects/org-one/metrics/") {
        return Response.json({
          id: "202",
          slug: "metrics",
          name: "Metrics Project",
        });
      }
      if (url.pathname === "/api/0/organizations/org-one/detectors/") {
        return Response.json([
          detector({
            id: "metrics-rule",
            name: "Metrics Rule",
            projects: ["metrics"],
          }),
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
      "metrics"
    );

    expect(stdout.output).toContain("metrics-ru");
    expect(stdout.output).toContain("Rule");
    expect(stdout.output).toContain("org-one");
  });

  test("human output includes org column for multi-org project-search results", async () => {
    setOrgRegion("org-one", DEFAULT_SENTRY_URL);
    setOrgRegion("org-two", DEFAULT_SENTRY_URL);

    const rule = (org: string) =>
      detector({
        id: `${org}-1`,
        name: `${org} Metric Rule`,
        status: org === "org-one" ? 0 : 1,
        environment: "prod",
        projects: ["myproj"],
      });

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      const alertMatch = url.pathname.match(
        /\/api\/0\/organizations\/([^/]+)\/detectors\//
      );
      if (alertMatch) {
        return Response.json([rule(alertMatch[1] as string)]);
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

    expect(stdout.output).toContain("Metric alert rules from 2 organizations:");
    expect(stdout.output).toContain("ORG");
    expect(stdout.output).toContain("org-one");
    expect(stdout.output).toContain("org-two");
    expect(stdout.output).toContain("Metric Rule");
    expect(stdout.output).toContain("count");
    expect(stdout.output).toContain("errors");
    expect(stdout.output).toContain("active");
  });

  test("partial org failure warns and still returns successful metric rules", async () => {
    setOrgRegion("org-one", DEFAULT_SENTRY_URL);
    setOrgRegion("org-two", DEFAULT_SENTRY_URL);

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      const alertMatch = url.pathname.match(
        /\/api\/0\/organizations\/([^/]+)\/detectors\//
      );
      if (alertMatch) {
        const org = alertMatch[1] as string;
        if (org === "org-two") {
          return new Response(JSON.stringify({ detail: "boom" }), {
            status: 500,
          });
        }
        return Response.json([
          detector({
            id: "ok-1",
            name: "Surviving Metric Rule",
            projects: ["myproj"],
          }),
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
    expect(parsed.data[0].name).toBe("Surviving Metric Rule");
    expect(parsed.errors).toEqual([
      expect.objectContaining({
        org: "org-two",
        status: 500,
        message: expect.stringContaining("Failed to list metric alert rules"),
      }),
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to fetch metric alert rules from org-two")
    );
  });

  test("all org failures preserve ApiError status", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/api/0/organizations/test-org/detectors/") {
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
        "test-org/"
      )
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
    } satisfies Partial<ApiError>);
  });

  test("distributes multi-org budget exactly without over-fetching", async () => {
    setOrgRegion("org-one", DEFAULT_SENTRY_URL);
    setOrgRegion("org-two", DEFAULT_SENTRY_URL);
    setOrgRegion("org-three", DEFAULT_SENTRY_URL);
    const perPageByOrg = new Map<string, number>();

    const rule = (org: string, index: number) =>
      detector({ id: `${org}-${index}`, name: `${org} Metric Rule ${index}` });

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      const alertMatch = url.pathname.match(
        /\/api\/0\/organizations\/([^/]+)\/detectors\//
      );
      if (alertMatch) {
        const org = alertMatch[1] as string;
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
