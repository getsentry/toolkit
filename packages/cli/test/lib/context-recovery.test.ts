/** Context recovery through the real parser, resolver, and local HTTP API. */

import { execFileSync } from "node:child_process";
import { run } from "@stricli/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { app } from "../../src/app.js";
import { buildContext } from "../../src/context.js";
import { setAuthToken } from "../../src/lib/db/auth.js";
import {
  getDefaultOrganization,
  getDefaultProject,
  setDefaultOrganization,
} from "../../src/lib/db/defaults.js";
import { ContextError, EXIT } from "../../src/lib/errors.js";
import { guideOrgProjectFailure } from "../../src/lib/resolve-target.js";
import { resetCacheState } from "../../src/lib/response-cache.js";
import { resetAuthenticatedFetch } from "../../src/lib/sentry-client.js";
import issuesFixture from "../fixtures/issues.json";
import organizationsFixture from "../fixtures/organizations.json";
import projectsFixture from "../fixtures/projects.json";
import {
  mockFetch,
  resetHostScopingState,
  useEnvSandbox,
  useTestConfigDir,
} from "../helpers.js";
import { createMockServer, type MockServer } from "../mocks/server.js";

const TOKEN = "context-recovery-test-token";
const QUERY = `is:unresolved message:"can't read 'name'"`;
const USAGE = "sentry issue list <org>/<project>";
const getConfigDir = useTestConfigDir("context-recovery-", {
  isolateProjectRoot: true,
});
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_URL",
  "SENTRY_HOST",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
  "SENTRY_NO_CACHE",
  "SENTRY_OUTPUT_FORMAT",
]);

let server: MockServer;
let originalFetch: typeof globalThis.fetch;
let organizations: typeof organizationsFixture;
let projectsByOrg: Map<string, typeof projectsFixture>;
let failedOrgs: Set<string>;
let paginatedOrgs: Set<string>;
let requests: URL[];

beforeAll(async () => {
  server = createMockServer(
    [
      {
        method: "GET",
        path: "/api/0/organizations/",
        response: () => ({ body: organizations }),
      },
      {
        method: "GET",
        path: "/api/0/organizations/:orgSlug/projects/",
        response: (
          _request: Request,
          { orgSlug }: Record<string, string>,
          serverUrl: string,
        ) => {
          if (failedOrgs.has(orgSlug)) {
            return { status: 403, body: { detail: "Not permitted" } };
          }
          return {
            body: projectsByOrg.get(orgSlug) ?? [],
            headers: paginatedOrgs.has(orgSlug)
              ? {
                  Link: `<${serverUrl}/api/0/organizations/${orgSlug}/projects/>; rel="next"; results="true"; cursor="next-page"`,
                }
              : undefined,
          };
        },
      },
      {
        method: "GET",
        path: "/api/0/projects/:orgSlug/:projectSlug/",
        response: (
          _request: Request,
          { orgSlug, projectSlug }: Record<string, string>,
        ) => ({
          body: projectsByOrg
            .get(orgSlug)
            ?.find((project) => project.slug === projectSlug),
        }),
      },
      {
        method: "GET",
        path: "/api/0/organizations/:orgSlug/issues/",
        response: issuesFixture.slice(0, 1),
      },
    ],
    { validTokens: [TOKEN] },
  );
  await server.start();
});

afterAll(() => server.stop());

beforeEach(async () => {
  await resetHostScopingState();
  resetAuthenticatedFetch();
  resetCacheState();
  originalFetch = globalThis.fetch;
  organizations = organizationsFixture;
  // Both orgs deliberately expose the same project slugs. Recovery must
  // provide qualified targets rather than another ambiguous project lookup.
  projectsByOrg = new Map(
    organizations.map((org) => [org.slug, projectsFixture]),
  );
  failedOrgs = new Set();
  paginatedOrgs = new Set();
  requests = [];
  process.env.SENTRY_URL = server.url;
  process.env.SENTRY_NO_CACHE = "1";
  setAuthToken(TOKEN, undefined, undefined, { host: server.url });

  const realFetch = (globalThis as { __originalFetch?: typeof fetch })
    .__originalFetch;
  if (!realFetch) {
    throw new Error("Test preload did not preserve the real fetch");
  }
  globalThis.fetch = mockFetch((input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    // Explicitly refuse any request outside this test server, including
    // redirects or unexpected SaaS discovery during target resolution.
    if (url.origin !== server.url) {
      throw new Error(`Unexpected external request: ${url.origin}`);
    }
    requests.push(url);
    return realFetch(request);
  });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetAuthenticatedFetch();
  resetCacheState();
  await resetHostScopingState();
});

async function failure(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected missing-context failure");
}

async function runCommand(args: string[]) {
  const output = { stdout: "", stderr: "" };
  const process_ = {
    env: process.env,
    cwd: () => getConfigDir(),
    stdin: process.stdin,
    exitCode: undefined as number | undefined,
    stdout: {
      write: (chunk: string) => {
        output.stdout += chunk;
        return true;
      },
    },
    stderr: {
      write: (chunk: string) => {
        output.stderr += chunk;
        return true;
      },
    },
  };
  await run(app, args, buildContext(process_ as unknown as NodeJS.Process));
  return { ...output, exitCode: process_.exitCode };
}

function recoveryCommands(error: Error): string[] {
  return error.message.match(/sentry issue list (?!<)[^\n]+/g) ?? [];
}

function guide() {
  return guideOrgProjectFailure({
    cwd: getConfigDir(),
    interactive: false,
    usageHint: USAGE,
    formatRecoveryCommand: (target) => `sentry issue list ${target}`,
  });
}

describe.skipIf(process.platform === "win32")(
  "issue list context recovery",
  () => {
    test.each([
      {
        period: "24h",
        expectedTime: { statsPeriod: "24h" },
      },
      {
        period: "2026-10-15T00:00:00Z..2026-10-16T00:00:00Z",
        expectedTime: {
          start: "2026-10-15T00:00:00.000Z",
          end: "2026-10-16T00:00:00.000Z",
        },
      },
      {
        period: ">=2026-10-15T00:00:00Z",
        expectedTime: { start: "2026-10-15T00:00:00.000Z" },
      },
    ])(
      "retries the original query and output options with $period",
      async ({ period, expectedTime }) => {
        const first = await runCommand([
          "issue",
          "list",
          "--query",
          QUERY,
          "--period",
          period,
          "--limit",
          "7",
          "--sort",
          "freq",
          "--json",
          "--fields",
          "id,title",
        ]);
        expect(first.exitCode).toBe(EXIT.CONTEXT_MISSING);
        expect(first.stdout).toBe("");
        const commands = recoveryCommands(new Error(first.stderr));
        expect(commands.length).toBeGreaterThan(1);
        expect(
          commands.some((command) => command.includes("test-org/test-project")),
        ).toBe(true);
        expect(
          commands.some((command) =>
            command.includes("test-org-2/test-project"),
          ),
        ).toBe(true);
        expect(
          requests.filter((url) => url.pathname.endsWith("/issues/")),
        ).toHaveLength(0);

        // Let a real POSIX shell parse the exact suggested command. The local
        // sentry function only prints argv, so this cannot run the user's CLI.
        const args = execFileSync(
          "sh",
          ["-c", `sentry() { printf '%s\\0' "$@"; }; ${commands[0]}`],
          { encoding: "utf8" },
        )
          .split("\0")
          .slice(0, -1);
        expect(args).toContain("--json");
        expect(args[args.indexOf("--fields") + 1]).toBe("id,title");
        const retry = await runCommand(args);
        expect(retry.exitCode).toBe(0);
        expect(JSON.parse(retry.stdout)).toEqual({
          data: [{ id: issuesFixture[0].id, title: issuesFixture[0].title }],
          hasMore: false,
          hasPrev: false,
        });
        const issueRequests = requests.filter((url) =>
          url.pathname.endsWith("/issues/"),
        );
        expect(issueRequests).toHaveLength(1);
        const request = issueRequests[0];
        expect(request.pathname).toBe("/api/0/organizations/test-org/issues/");
        expect(request.searchParams.get("project")).toBe(projectsFixture[0].id);
        expect(request.searchParams.get("query")).toBe(QUERY);
        expect(request.searchParams.get("limit")).toBe("7");
        expect(request.searchParams.get("sort")).toBe("freq");
        for (const [key, value] of Object.entries(expectedTime)) {
          expect(request.searchParams.get(key)).toBe(value);
        }
        expect(request.searchParams.has("statsPeriod")).toBe(period === "24h");
        expect(getDefaultOrganization()).toBeNull();
        expect(getDefaultProject()).toBeNull();
      },
    );
  },
);

describe("bounded target guidance", () => {
  test.each(["environment", "default"] as const)(
    "keeps candidates within the %s organization without changing defaults",
    async (source) => {
      if (source === "environment") {
        process.env.SENTRY_ORG = "test-org-2";
      } else {
        setDefaultOrganization("test-org-2");
      }

      const error = await failure(guide());
      expect(error).toBeInstanceOf(ContextError);
      const commands = recoveryCommands(error);
      expect(commands).toHaveLength(2);
      expect(commands.every((command) => command.includes("test-org-2/"))).toBe(
        true,
      );
      const lookups = requests.filter((url) =>
        url.pathname.endsWith("/projects/"),
      );
      expect(lookups.map((url) => url.pathname)).toEqual([
        "/api/0/organizations/test-org-2/projects/",
      ]);
      expect(getDefaultOrganization()).toBe(
        source === "default" ? "test-org-2" : null,
      );
      expect(getDefaultProject()).toBeNull();
    },
  );

  test("bounds discovery and still suggests accessible projects when one org fails", async () => {
    organizations = Array.from({ length: 4 }, (_, index) => ({
      ...organizationsFixture[0],
      id: String(100_010 + index),
      slug: `candidate-org-${index}`,
    }));
    projectsByOrg = new Map(
      organizations.map((org) => [
        org.slug,
        Array.from({ length: 5 }, (_, index) => ({
          ...projectsFixture[0],
          id: String(300_010 + index),
          slug: `candidate-project-${index}`,
        })),
      ]),
    );
    failedOrgs.add("candidate-org-0");
    paginatedOrgs.add("candidate-org-1");

    const error = await failure(guide());
    expect(error).toBeInstanceOf(ContextError);
    expect(error.message).toContain("Showing 3 of 4 organizations.");
    expect(error.message).toContain(
      "More projects are available in 'candidate-org-1'.",
    );
    expect(error.message).toContain(
      "Could not list projects in 'candidate-org-0'.",
    );
    expect(error.message).toContain("sentry project list 'candidate-org-0/'");
    const commands = recoveryCommands(error);
    expect(commands).toHaveLength(6);
    expect(
      commands.every((command) => !command.includes("candidate-org-0/")),
    ).toBe(true);
    expect(
      commands.every((command) => !command.includes("candidate-org-3/")),
    ).toBe(true);
    const lookups = requests.filter((url) =>
      url.pathname.endsWith("/projects/"),
    );
    expect(lookups).toHaveLength(3);
    expect(lookups.every((url) => !url.searchParams.has("cursor"))).toBe(true);
    expect(
      lookups.every((url) => url.searchParams.get("per_page") === "3"),
    ).toBe(true);
    expect(getDefaultOrganization()).toBeNull();
    expect(getDefaultProject()).toBeNull();
  });

  test("keeps discovery actionable when no accessible projects are returned", async () => {
    projectsByOrg = new Map();

    const error = await failure(guide());
    expect(error).toBeInstanceOf(ContextError);
    expect(recoveryCommands(error)).toEqual([]);
    expect(error.message).toContain("sentry project list 'test-org/'");
    expect(getDefaultOrganization()).toBeNull();
    expect(getDefaultProject()).toBeNull();
  });
});
