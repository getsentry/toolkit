import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveIssue } from "../../../src/commands/issue/utils.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setDefaultOrganization } from "../../../src/lib/db/defaults.js";
import { setProjectAliases } from "../../../src/lib/db/project-aliases.js";
import { setCachedProject } from "../../../src/lib/db/project-cache.js";
import { setOrgRegion, setOrgRegions } from "../../../src/lib/db/regions.js";
import { ApiError, ResolutionError } from "../../../src/lib/errors.js";
import issueFixture from "../../fixtures/issue.json";
import organizationFixture from "../../fixtures/organization.json";
import { mockFetch, useEnvSandbox, useTestConfigDir } from "../../helpers.js";

const SHORT_ID = "CUSTOM-5BS";
const REGION_URL = "https://de.sentry.io";

function organization(slug: string, id: string) {
  return {
    ...organizationFixture,
    slug,
    id,
    links: { regionUrl: REGION_URL },
  };
}

const cachedOrg = organization("cached-org", "1");
const targetOrg = organization("target-org", "2");
const secondOrg = organization("second-org", "3");

const getConfigDir = useTestConfigDir("test-short-id-resolution-", {
  isolateProjectRoot: true,
});
useEnvSandbox(["SENTRY_ORG", "SENTRY_PROJECT", "SENTRY_DSN"]);

let originalFetch: typeof fetch;
let listedOrgs: ReturnType<typeof organization>[];
let listingStatus: number;
let requests: URL[];
let issues: Map<string, typeof issueFixture>;

function addIssue(org: string, shortId = SHORT_ID): void {
  issues.set(`${org}/${shortId}`, {
    ...issueFixture,
    shortId,
    // Sentry's short-ID prefix need not equal the current project slug.
    project: { ...issueFixture.project, slug: "renamed-project" },
  });
}

function resolve(issueArg = SHORT_ID) {
  return resolveIssue({ issueArg, cwd: getConfigDir(), command: "view" });
}

function listingRequests() {
  return requests.filter((url) => url.pathname === "/api/0/organizations/");
}

function shortIdRequests() {
  return requests.filter((url) => url.pathname.includes("/shortids/"));
}

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  requests = [];
  listedOrgs = [cachedOrg];
  listingStatus = 200;
  issues = new Map();
  await setAuthToken("test-token");
  setOrgRegions([
    {
      slug: cachedOrg.slug,
      regionUrl: REGION_URL,
      orgId: cachedOrg.id,
      orgName: cachedOrg.name,
    },
  ]);
  // Routing information alone does not make these orgs listing candidates.
  setOrgRegion(targetOrg.slug, REGION_URL);
  setOrgRegion(secondOrg.slug, REGION_URL);

  globalThis.fetch = mockFetch(async (input, init) => {
    const url = new URL(new Request(input, init).url);
    requests.push(url);
    if (url.pathname === "/api/0/organizations/") {
      return Response.json(
        listingStatus === 200 ? listedOrgs : { detail: "Forbidden" },
        { status: listingStatus },
      );
    }
    for (const [key, issue] of issues) {
      const [org, shortId] = key.split("/");
      if (url.pathname === `/api/0/organizations/${org}/shortids/${shortId}/`) {
        return Response.json({ group: issue });
      }
    }
    return Response.json({ detail: "Not found" }, { status: 404 });
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("short IDs with configured organization context", () => {
  test("uses a default org missing from the cached and API organization lists", async () => {
    setDefaultOrganization(targetOrg.slug);
    addIssue(targetOrg.slug);

    const result = await resolve();

    expect(result.org).toBe(targetOrg.slug);
    expect(result.issue.shortId).toBe(SHORT_ID);
    expect(listingRequests()).toHaveLength(0);
    expect(shortIdRequests().map((url) => url.href)).toEqual([
      expect.stringContaining(`${REGION_URL}/api/0/organizations/target-org/`),
    ]);
  });

  test.each([
    { envOrg: secondOrg.slug, expectedOrg: secondOrg.slug },
    { envOrg: undefined, expectedOrg: targetOrg.slug },
  ])(
    "honors env and .sentryclirc precedence: $expectedOrg",
    async ({ envOrg, expectedOrg }) => {
      setDefaultOrganization(cachedOrg.slug);
      writeFileSync(
        join(getConfigDir(), ".sentryclirc"),
        `[defaults]\norg = ${targetOrg.slug}\n`,
      );
      if (envOrg) {
        process.env.SENTRY_ORG = envOrg;
      }
      for (const org of [cachedOrg, targetOrg, secondOrg]) {
        addIssue(org.slug);
      }

      expect((await resolve()).org).toBe(expectedOrg);
      expect(listingRequests()).toHaveLength(0);
      expect(shortIdRequests()).toHaveLength(1);
    },
  );

  test("does not fall through to another org when the configured org returns 404", async () => {
    setDefaultOrganization(targetOrg.slug);
    addIssue(cachedOrg.slug);

    await expect(resolve()).rejects.toMatchObject({ status: 404 });

    expect(listingRequests()).toHaveLength(0);
    expect(shortIdRequests().map((url) => url.pathname)).toEqual([
      `/api/0/organizations/target-org/shortids/${SHORT_ID}/`,
    ]);
  });

  test("preserves an alias's org even when a different default is configured", async () => {
    setDefaultOrganization(targetOrg.slug);
    setProjectAliases(
      { f: { orgSlug: cachedOrg.slug, projectSlug: "frontend" } },
      "",
    );
    addIssue(cachedOrg.slug, "FRONTEND-5BS");

    expect((await resolve("f-5BS")).org).toBe(cachedOrg.slug);
    expect(listingRequests()).toHaveLength(0);
  });
});

describe("short IDs missing from cached organizations", () => {
  test("refreshes once and resolves a new EU org even when the project slug differs from the prefix", async () => {
    listedOrgs = [cachedOrg, targetOrg];
    addIssue(targetOrg.slug);

    const result = await resolve();

    expect(result.org).toBe(targetOrg.slug);
    expect(result.issue.project?.slug).toBe("renamed-project");
    expect(listingRequests()).toHaveLength(1);
    expect(shortIdRequests().map((url) => url.pathname)).toEqual([
      `/api/0/organizations/cached-org/shortids/${SHORT_ID}/`,
      `/api/0/organizations/target-org/shortids/${SHORT_ID}/`,
    ]);
    expect(shortIdRequests().every((url) => url.origin === REGION_URL)).toBe(
      true,
    );
  });

  test.each([
    { label: "unchanged", inventory: [cachedOrg] },
    { label: "new organization", inventory: [cachedOrg, targetOrg] },
  ])(
    "keeps a still-missing lookup bounded after refresh: $label",
    async ({ inventory }) => {
      listedOrgs = inventory;

      await expect(resolve()).rejects.toBeInstanceOf(ResolutionError);

      expect(listingRequests()).toHaveLength(1);
      expect(shortIdRequests()).toHaveLength(inventory.length);
      expect(new Set(shortIdRequests().map((url) => url.pathname)).size).toBe(
        inventory.length,
      );
    },
  );

  test("reports ambiguity when the refresh discovers two matching orgs", async () => {
    listedOrgs = [cachedOrg, targetOrg, secondOrg];
    addIssue(targetOrg.slug);
    addIssue(secondOrg.slug);

    await expect(resolve()).rejects.toThrow("is ambiguous");

    expect(listingRequests()).toHaveLength(1);
    expect(shortIdRequests()).toHaveLength(3);
  });

  test("propagates refresh failures instead of reporting an absent issue", async () => {
    listingStatus = 403;

    const error = await resolve().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403 });
    expect(listingRequests()).toHaveLength(1);
  });

  test("does not scope the search to a DSN for a different project", async () => {
    writeFileSync(
      join(getConfigDir(), ".env"),
      "SENTRY_DSN=https://abc@o123.ingest.de.sentry.io/456",
    );
    setCachedProject("123", "456", {
      orgSlug: cachedOrg.slug,
      orgName: cachedOrg.name,
      projectSlug: "unrelated-project",
      projectName: "Unrelated Project",
      projectId: "456",
    });
    listedOrgs = [cachedOrg, targetOrg];
    addIssue(targetOrg.slug);

    expect((await resolve()).org).toBe(targetOrg.slug);
    expect(listingRequests()).toHaveLength(1);
  });
});
