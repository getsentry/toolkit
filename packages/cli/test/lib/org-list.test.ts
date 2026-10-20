/**
 * Tests for the shared org-scoped list infrastructure.
 *
 * Covers: fetchOrgSafe, fetchAllOrgs, handleOrgAll, handleAutoDetect,
 * handleExplicitOrg, handleExplicitProject, handleProjectSearch,
 * dispatchOrgScopedList (with and without overrides, metadata-only config).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as apiClient from "../../src/lib/api-client.js";

vi.mock("../../src/lib/db/defaults.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/db/defaults.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as defaults from "../../src/lib/db/defaults.js";

vi.mock("../../src/lib/db/pagination.js");

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for vi.mocked access
import * as paginationDb from "../../src/lib/db/pagination.js";

vi.mock("../../src/lib/db/regions.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/db/regions.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

import {
  AuthError,
  ResolutionError,
  ValidationError,
} from "../../src/lib/errors.js";
import {
  dispatchOrgScopedList,
  fetchAllOrgs,
  fetchOrgSafe,
  handleExplicitOrg,
  handleExplicitProject,
  handleOrgAll,
  handleProjectSearch,
  isOrgListConfig,
  type ListCommandMeta,
  type ListResult,
  type OrgListConfig,
} from "../../src/lib/org-list.js";

vi.mock("../../src/lib/polling.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/polling.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as polling from "../../src/lib/polling.js";

vi.mock("../../src/lib/region.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/region.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as region from "../../src/lib/region.js";

vi.mock("../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as resolveTarget from "../../src/lib/resolve-target.js";

/**
 * Bypass the withProgress spinner in all tests — prevents real stderr
 * timers from piling up during full-suite runs and causing 5s timeouts.
 */
let withProgressSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  withProgressSpy = vi
    .spyOn(polling, "withProgress")
    .mockImplementation((_opts, fn) =>
      fn(() => {
        /* no-op setMessage */
      }),
    );
});
afterEach(() => {
  withProgressSpy.mockRestore();
});

type FakeEntity = { id: string; name: string };
type FakeWithOrg = FakeEntity & { orgSlug: string };

function makeConfig(
  overrides?: Partial<OrgListConfig<FakeEntity, FakeWithOrg>>,
): OrgListConfig<FakeEntity, FakeWithOrg> {
  return {
    paginationKey: "test-list",
    entityPlural: "widgets",
    commandPrefix: "sentry widget list",
    listForOrg: vi.fn(() => Promise.resolve([])),
    listPaginated: vi.fn(() =>
      Promise.resolve({ data: [] as FakeEntity[], nextCursor: undefined }),
    ),
    withOrg: (entity, orgSlug) => ({ ...entity, orgSlug }),
    displayTable: vi.fn(() => ""),
    ...overrides,
  };
}

const META_ONLY: ListCommandMeta = {
  paginationKey: "meta-list",
  entityPlural: "things",
  commandPrefix: "sentry thing list",
};

function createStdout() {
  const write = vi.fn((_chunk: string) => true);
  return { writer: { write }, write };
}

// ---------------------------------------------------------------------------
// isOrgListConfig
// ---------------------------------------------------------------------------

describe("isOrgListConfig", () => {
  test("returns true for full OrgListConfig", () => {
    expect(isOrgListConfig(makeConfig())).toBe(true);
  });

  test("returns false for ListCommandMeta only", () => {
    expect(isOrgListConfig(META_ONLY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchOrgSafe
// ---------------------------------------------------------------------------

describe("fetchOrgSafe", () => {
  test("returns entities with org context on success", async () => {
    const items: FakeEntity[] = [
      { id: "1", name: "A" },
      { id: "2", name: "B" },
    ];
    const config = makeConfig({
      listForOrg: vi.fn(() => Promise.resolve(items)),
    });
    const result = await fetchOrgSafe(config, "my-org");

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: "1", name: "A", orgSlug: "my-org" });
    expect(result[1]).toEqual({ id: "2", name: "B", orgSlug: "my-org" });
  });

  test("returns empty array on non-auth error", async () => {
    const config = makeConfig({
      listForOrg: vi.fn(() => Promise.reject(new Error("network"))),
    });
    const result = await fetchOrgSafe(config, "my-org");
    expect(result).toEqual([]);
  });

  test("rethrows AuthError", async () => {
    const config = makeConfig({
      listForOrg: vi.fn(() =>
        Promise.reject(new AuthError("not_authenticated")),
      ),
    });
    await expect(fetchOrgSafe(config, "my-org")).rejects.toThrow(AuthError);
  });
});

// ---------------------------------------------------------------------------
// fetchAllOrgs
// ---------------------------------------------------------------------------

describe("fetchAllOrgs", () => {
  let listOrganizationsSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    listOrganizationsSpy = vi.spyOn(apiClient, "listOrganizations");
  });

  afterEach(() => {
    listOrganizationsSpy.mockRestore();
  });

  test("fetches entities from all accessible orgs", async () => {
    listOrganizationsSpy.mockResolvedValue([
      { id: "1", slug: "org-a", name: "Org A" },
      { id: "2", slug: "org-b", name: "Org B" },
    ]);

    const items: FakeEntity[] = [{ id: "1", name: "Widget" }];
    const config = makeConfig({
      listForOrg: vi.fn(() => Promise.resolve(items)),
    });

    const result = await fetchAllOrgs(config);
    expect(result).toHaveLength(2);
    expect(result[0]!.orgSlug).toBe("org-a");
    expect(result[1]!.orgSlug).toBe("org-b");
  });

  test("skips orgs with non-auth errors", async () => {
    listOrganizationsSpy.mockResolvedValue([
      { id: "1", slug: "org-a", name: "Org A" },
      { id: "2", slug: "org-b", name: "Org B" },
    ]);

    let callCount = 0;
    const config = makeConfig({
      listForOrg: vi.fn(() => {
        callCount += 1;
        if (callCount === 1) return Promise.reject(new Error("forbidden"));
        return Promise.resolve([{ id: "1", name: "Widget" }]);
      }),
    });

    const result = await fetchAllOrgs(config);
    expect(result).toHaveLength(1);
    expect(result[0]!.orgSlug).toBe("org-b");
  });

  test("rethrows AuthError from any org", async () => {
    listOrganizationsSpy.mockResolvedValue([
      { id: "1", slug: "org-a", name: "Org A" },
    ]);

    const config = makeConfig({
      listForOrg: vi.fn(() =>
        Promise.reject(new AuthError("not_authenticated")),
      ),
    });

    await expect(fetchAllOrgs(config)).rejects.toThrow(AuthError);
  });
});

// ---------------------------------------------------------------------------
// handleOrgAll
// ---------------------------------------------------------------------------

describe("handleOrgAll", () => {
  const advancePaginationStateSpy = vi.mocked(
    paginationDb.advancePaginationState,
  );
  const hasPreviousPageSpy = vi.mocked(paginationDb.hasPreviousPage);

  beforeEach(() => {
    advancePaginationStateSpy.mockReturnValue(undefined);
    hasPreviousPageSpy.mockReturnValue(false);
  });

  afterEach(() => {
    advancePaginationStateSpy.mockReset();
    hasPreviousPageSpy.mockReset();
  });

  test("returns ListResult with hasMore=true and nextCursor", async () => {
    const items: FakeEntity[] = [{ id: "1", name: "A" }];
    const config = makeConfig({
      listPaginated: vi.fn(() =>
        Promise.resolve({ data: items, nextCursor: "next:123" }),
      ),
    });

    const result = await handleOrgAll({
      config,
      org: "my-org",
      flags: { limit: 10, json: true },
      contextKey: "key",
      cursor: undefined,
      direction: "next",
    });

    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("next:123");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.orgSlug).toBe("my-org");
  });

  test("caps perPage at API_MAX_PER_PAGE when limit exceeds it", async () => {
    const listPaginated = vi.fn(() =>
      Promise.resolve({ data: [] as FakeEntity[], nextCursor: undefined }),
    );
    const config = makeConfig({ listPaginated });

    await handleOrgAll({
      config,
      org: "my-org",
      flags: { limit: 200, json: true },
      contextKey: "key",
      cursor: undefined,
      direction: "next",
    });

    expect(listPaginated).toHaveBeenCalledWith(
      "my-org",
      expect.objectContaining({ perPage: 100 }),
    );
  });

  test("passes limit through as perPage when below API_MAX_PER_PAGE", async () => {
    const listPaginated = vi.fn(() =>
      Promise.resolve({ data: [] as FakeEntity[], nextCursor: undefined }),
    );
    const config = makeConfig({ listPaginated });

    await handleOrgAll({
      config,
      org: "my-org",
      flags: { limit: 25, json: true },
      contextKey: "key",
      cursor: undefined,
      direction: "next",
    });

    expect(listPaginated).toHaveBeenCalledWith(
      "my-org",
      expect.objectContaining({ perPage: 25 }),
    );
  });

  test("returns ListResult with hasMore=false when no nextCursor", async () => {
    const config = makeConfig({
      listPaginated: vi.fn(() =>
        Promise.resolve({
          data: [{ id: "1", name: "A" }],
          nextCursor: undefined,
        }),
      ),
    });

    const result = await handleOrgAll({
      config,
      org: "my-org",
      flags: { limit: 10, json: true },
      contextKey: "key",
      cursor: undefined,
      direction: "next",
    });

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.items).toHaveLength(1);
  });

  test("returns hint with 'no entities found' when empty", async () => {
    const config = makeConfig({
      listPaginated: vi.fn(() =>
        Promise.resolve({ data: [] as FakeEntity[], nextCursor: undefined }),
      ),
    });

    const result = await handleOrgAll({
      config,
      org: "my-org",
      flags: { limit: 10, json: false },
      contextKey: "key",
      cursor: undefined,
      direction: "next",
    });

    expect(result.items).toHaveLength(0);
    expect(result.hint).toContain("No widgets found in organization 'my-org'.");
  });

  test("returns hint with next page info when more available", async () => {
    const config = makeConfig({
      listPaginated: vi.fn(() =>
        Promise.resolve({ data: [{ id: "1", name: "A" }], nextCursor: "x" }),
      ),
    });

    const result = await handleOrgAll({
      config,
      org: "my-org",
      flags: { limit: 10, json: false },
      contextKey: "key",
      cursor: undefined,
      direction: "next",
    });

    expect(result.header).toContain("more available");
    expect(result.header).toContain("sentry widget list my-org/ -c next");
  });

  test("calls advancePaginationState when nextCursor present", async () => {
    const config = makeConfig({
      listPaginated: vi.fn(() =>
        Promise.resolve({
          data: [{ id: "1", name: "A" }],
          nextCursor: "cursor:abc",
        }),
      ),
    });

    await handleOrgAll({
      config,
      org: "my-org",
      flags: { limit: 10, json: false },
      contextKey: "ctx",
      cursor: undefined,
      direction: "next",
    });

    expect(advancePaginationStateSpy).toHaveBeenCalledWith(
      "test-list",
      "ctx",
      "next",
      "cursor:abc",
    );
  });

  test("calls advancePaginationState with undefined when no nextCursor", async () => {
    const config = makeConfig({
      listPaginated: vi.fn(() =>
        Promise.resolve({
          data: [{ id: "1", name: "A" }],
          nextCursor: undefined,
        }),
      ),
    });

    await handleOrgAll({
      config,
      org: "my-org",
      flags: { limit: 10, json: false },
      contextKey: "ctx",
      cursor: undefined,
      direction: "next",
    });

    expect(advancePaginationStateSpy).toHaveBeenCalledWith(
      "test-list",
      "ctx",
      "next",
      undefined,
    );
  });

  test("auto-paginates when limit exceeds API_MAX_PER_PAGE and never requests a larger page", async () => {
    const listPaginated = vi.fn(
      (_org: string, opts: { cursor?: string; perPage: number }) => {
        expect(opts.perPage).toBeLessThanOrEqual(100);
        const offset = opts.cursor ? Number(opts.cursor) : 0;
        const data = Array.from({ length: opts.perPage }, (_, i) => ({
          id: String(offset + i),
          name: `W${offset + i}`,
        }));
        return Promise.resolve({
          data,
          nextCursor: String(offset + opts.perPage),
        });
      },
    );
    const config = makeConfig({ listPaginated });

    const result = await handleOrgAll({
      config,
      org: "my-org",
      flags: { limit: 250, json: true },
      contextKey: "key",
      cursor: undefined,
      direction: "next",
    });

    expect(result.items).toHaveLength(250);
    expect(listPaginated).toHaveBeenCalledTimes(3);
    // Each request uses only the remaining item budget, capped at API_MAX_PER_PAGE,
    // so the final page requests only the remaining 50 items (250 - 100 - 100).
    expect(listPaginated.mock.calls.map((call) => call[1].perPage)).toEqual([
      100, 100, 50,
    ]);
    // The mock always returns a nextCursor, so hasMore is true and
    // the cursor points to the first item beyond the fetched 250.
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("250");
  });
});

// ---------------------------------------------------------------------------
// handleExplicitOrg
// ---------------------------------------------------------------------------

describe("handleExplicitOrg", () => {
  test("returns items with org context", async () => {
    const config = makeConfig({
      listForOrg: vi.fn(() => Promise.resolve([{ id: "1", name: "A" }])),
    });

    const result = await handleExplicitOrg({
      config,
      org: "my-org",
      flags: { limit: 10, json: true },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.orgSlug).toBe("my-org");
  });

  test("includes org-scoped note in header when noteOrgScoped=true", async () => {
    const config = makeConfig({
      listForOrg: vi.fn(() => Promise.resolve([{ id: "1", name: "A" }])),
    });

    const result = await handleExplicitOrg({
      config,
      org: "my-org",
      flags: { limit: 10, json: false },
      noteOrgScoped: true,
    });

    expect(result.header).toContain("widgets are org-scoped");
    expect(result.header).toContain("my-org");
  });

  test("does not include org-scoped note when noteOrgScoped=false (default)", async () => {
    const config = makeConfig({
      listForOrg: vi.fn(() => Promise.resolve([{ id: "1", name: "A" }])),
    });

    const result = await handleExplicitOrg({
      config,
      org: "my-org",
      flags: { limit: 10, json: false },
    });

    expect(result.header ?? "").not.toContain("org-scoped");
  });

  test("header includes org-scoped note even in JSON mode (rendering decision is caller's)", async () => {
    const config = makeConfig({
      listForOrg: vi.fn(() => Promise.resolve([{ id: "1", name: "A" }])),
    });

    const result = await handleExplicitOrg({
      config,
      org: "my-org",
      flags: { limit: 10, json: true },
      noteOrgScoped: true,
    });

    // Header is always populated; caller suppresses it in JSON mode
    expect(result.items).toHaveLength(1);
    expect(result.header).toContain("org-scoped");
  });
});

// ---------------------------------------------------------------------------
// handleExplicitProject
// ---------------------------------------------------------------------------

describe("handleExplicitProject", () => {
  test("fetches and returns project-scoped entities", async () => {
    const listForProject = vi.fn(() =>
      Promise.resolve([{ id: "1", name: "Team A" }]),
    );
    const config = makeConfig({ listForProject });

    const result = await handleExplicitProject({
      config,
      org: "my-org",
      project: "my-proj",
      flags: { limit: 10, json: true },
    });

    expect(listForProject).toHaveBeenCalledWith("my-org", "my-proj");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.orgSlug).toBe("my-org");
  });

  test("throws when listForProject is not defined on config", async () => {
    const config = makeConfig(); // no listForProject

    await expect(
      handleExplicitProject({
        config,
        org: "my-org",
        project: "my-proj",
        flags: { limit: 10, json: false },
      }),
    ).rejects.toThrow("listForProject is not defined");
  });

  test("returns hint with 'no entities found' when project has none", async () => {
    const config = makeConfig({
      listForProject: vi.fn(() => Promise.resolve([])),
    });

    const result = await handleExplicitProject({
      config,
      org: "my-org",
      project: "my-proj",
      flags: { limit: 10, json: false },
    });

    expect(result.items).toHaveLength(0);
    expect(result.hint).toContain("No widgets found");
    expect(result.hint).toContain("my-org/my-proj");
  });
});

// ---------------------------------------------------------------------------
// handleProjectSearch
// ---------------------------------------------------------------------------

describe("handleProjectSearch", () => {
  let findProjectsBySlugSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    findProjectsBySlugSpy = vi.spyOn(apiClient, "findProjectsBySlug");
  });

  afterEach(() => {
    findProjectsBySlugSpy.mockRestore();
  });

  test("throws ResolutionError when no project found", async () => {
    findProjectsBySlugSpy.mockResolvedValue({ projects: [], orgs: [] });
    const config = makeConfig();

    await expect(
      handleProjectSearch(config, "no-such-project", {
        flags: { limit: 10, json: false },
      }),
    ).rejects.toThrow(ResolutionError);
  });

  test("returns empty items when no project found with --json", async () => {
    findProjectsBySlugSpy.mockResolvedValue({ projects: [], orgs: [] });
    const config = makeConfig();

    const result = await handleProjectSearch(config, "no-such-project", {
      flags: { limit: 10, json: true },
    });

    expect(result.items).toEqual([]);
  });

  test("with listForProject: fetches project-scoped entities", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [
        { orgSlug: "org-a", slug: "my-proj", id: "1", name: "My Project" },
      ],
      orgs: [],
    });
    const listForProject = vi.fn(() =>
      Promise.resolve([{ id: "1", name: "Team A" }]),
    );
    const config = makeConfig({ listForProject });

    const result = await handleProjectSearch(config, "my-proj", {
      flags: { limit: 10, json: true },
    });

    expect(listForProject).toHaveBeenCalledWith("org-a", "my-proj");
    expect(result.items[0]!.orgSlug).toBe("org-a");
  });

  test("reuses fuzzy project data without a second slug search", async () => {
    const listForProject = vi.fn(() => Promise.resolve([]));
    const config = makeConfig({ listForProject });

    const result = await handleProjectSearch(config, "app-front", {
      flags: { limit: 10, json: false },
      projectSearchResolution: {
        kind: "fuzzy-project",
        org: "org-a",
        project: "app-frontend",
        projectData: {
          id: "1",
          slug: "app-frontend",
          name: "App Frontend",
          orgSlug: "org-a",
        },
        displaySlug: "app-front",
        scopedOrg: undefined,
      },
    });

    expect(findProjectsBySlugSpy).not.toHaveBeenCalled();
    expect(listForProject).toHaveBeenCalledWith("org-a", "app-frontend");
    expect(result.hint).toContain("app-frontend");
  });

  test("without listForProject: fetches from parent org (entity is org-scoped)", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [
        { orgSlug: "org-a", slug: "my-proj", id: "1", name: "My Project" },
      ],
      orgs: [],
    });
    const listForOrg = vi.fn(() =>
      Promise.resolve([{ id: "1", name: "Repo A" }]),
    );
    const config = makeConfig({ listForOrg });

    const result = await handleProjectSearch(config, "my-proj", {
      flags: { limit: 10, json: true },
    });

    expect(listForOrg).toHaveBeenCalledWith("org-a");
    expect(result.items[0]!.orgSlug).toBe("org-a");
  });

  test("deduplicates orgs when multiple projects share one org", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [
        { orgSlug: "org-a", slug: "proj-1", id: "1", name: "Proj 1" },
        { orgSlug: "org-a", slug: "proj-2", id: "2", name: "Proj 2" },
      ],
      orgs: [],
    });
    const listForOrg = vi.fn(() =>
      Promise.resolve([{ id: "1", name: "Repo A" }]),
    );
    const config = makeConfig({ listForOrg });

    await handleProjectSearch(config, "proj", {
      flags: { limit: 10, json: true },
    });

    // org-a should only be fetched once
    expect(listForOrg).toHaveBeenCalledTimes(1);
  });

  test("calls orgAllFallback when slug matches an org and fallback provided", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [],
      orgs: [{ slug: "acme-corp", name: "Acme Corp" }],
    });
    const config = makeConfig();
    const fallback = vi.fn(() =>
      Promise.resolve({ items: [] } as ListResult<FakeWithOrg>),
    );

    await handleProjectSearch(config, "acme-corp", {
      flags: { limit: 10, json: false },
      orgAllFallback: fallback,
    });

    expect(fallback).toHaveBeenCalledWith("acme-corp");
  });

  test("throws ResolutionError when slug matches an org but no fallback", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [],
      orgs: [{ slug: "acme-corp", name: "Acme Corp" }],
    });
    const config = makeConfig();

    await expect(
      handleProjectSearch(config, "acme-corp", {
        flags: { limit: 10, json: false },
      }),
    ).rejects.toThrow(ResolutionError);
  });

  test("includes multi-org note in hint when project found in multiple orgs", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [
        { orgSlug: "org-a", slug: "my-proj", id: "1", name: "My Project" },
        { orgSlug: "org-b", slug: "my-proj", id: "2", name: "My Project" },
      ],
      orgs: [],
    });
    const config = makeConfig({
      listForOrg: vi.fn(() => Promise.resolve([{ id: "1", name: "Widget" }])),
    });

    const result = await handleProjectSearch(config, "my-proj", {
      flags: { limit: 10, json: false },
    });

    expect(result.hint).toContain("2 organizations");
  });

  test("scopes matches to the explicit org, ignoring a same-slug project in another org", async () => {
    // findProjectsBySlug fans out across orgs and finds the slug in BOTH
    // org-a (the requested scope) and org-b. With an explicit org the result
    // must only fetch from org-a — never leak org-b.
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [
        { orgSlug: "org-b", slug: "my-proj", id: "2", name: "My Project" },
        { orgSlug: "org-a", slug: "my-proj", id: "1", name: "My Project" },
      ],
      orgs: [
        { slug: "org-a", name: "Org A" },
        { slug: "org-b", name: "Org B" },
      ],
    });
    const listForOrg = vi.fn(() =>
      Promise.resolve([{ id: "1", name: "Widget" }]),
    );
    const config = makeConfig({ listForOrg });

    const result = await handleProjectSearch(config, "my-proj", {
      flags: { limit: 10, json: false },
      org: "org-a",
    });

    expect(listForOrg).toHaveBeenCalledTimes(1);
    expect(listForOrg).toHaveBeenCalledWith("org-a");
    expect(result.items.every((i) => i.orgSlug === "org-a")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dispatchOrgScopedList — cursor validation and handler map pattern
// ---------------------------------------------------------------------------

describe("dispatchOrgScopedList", () => {
  let getDefaultOrganizationSpy: ReturnType<typeof spyOn>;
  let resolveAllTargetsSpy: ReturnType<typeof spyOn>;
  let advancePaginationStateSpy: ReturnType<typeof spyOn>;
  let hasPreviousPageSpy: ReturnType<typeof spyOn>;
  let resolveCursorSpy: ReturnType<typeof spyOn>;
  let resolveEffectiveOrgSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getDefaultOrganizationSpy = vi.spyOn(defaults, "getDefaultOrganization");
    resolveAllTargetsSpy = vi.spyOn(resolveTarget, "resolveAllTargets");
    advancePaginationStateSpy = vi
      .spyOn(paginationDb, "advancePaginationState")
      .mockReturnValue(undefined);
    hasPreviousPageSpy = vi
      .spyOn(paginationDb, "hasPreviousPage")
      .mockReturnValue(false);
    resolveCursorSpy = vi.spyOn(paginationDb, "resolveCursor").mockReturnValue({
      cursor: undefined,
      direction: "next" as const,
    });
    // Prevent resolveEffectiveOrg from making real HTTP calls during
    // full-suite runs where earlier tests may leave auth state behind.
    resolveEffectiveOrgSpy = vi
      .spyOn(region, "resolveEffectiveOrg")
      .mockImplementation((org: string) => Promise.resolve(org));

    getDefaultOrganizationSpy.mockReturnValue(null);
    resolveAllTargetsSpy.mockResolvedValue({ targets: [] });
  });

  afterEach(() => {
    getDefaultOrganizationSpy.mockRestore();
    resolveAllTargetsSpy.mockRestore();
    advancePaginationStateSpy.mockRestore();
    hasPreviousPageSpy.mockRestore();
    resolveCursorSpy.mockRestore();
    resolveEffectiveOrgSpy.mockRestore();
  });

  test("throws ValidationError when --cursor used outside org-all mode", async () => {
    const config = makeConfig();
    const { writer } = createStdout();

    await expect(
      dispatchOrgScopedList({
        config,
        stdout: writer,
        cwd: "/tmp",
        flags: { limit: 10, json: false, cursor: "some-cursor" },
        parsed: { type: "explicit", org: "my-org", project: "my-proj" },
      }),
    ).rejects.toThrow(ValidationError);
  });

  test("error message includes entity plural name", async () => {
    const config = makeConfig();
    const { writer } = createStdout();

    try {
      await dispatchOrgScopedList({
        config,
        stdout: writer,
        cwd: "/tmp",
        flags: { limit: 10, json: false, cursor: "x" },
        parsed: { type: "auto-detect" },
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).message).toContain("<org>/");
    }
  });

  test("delegates to handleOrgAll for org-all mode and returns ListResult", async () => {
    const items: FakeEntity[] = [{ id: "1", name: "A" }];
    const config = makeConfig({
      listPaginated: vi.fn(() =>
        Promise.resolve({ data: items, nextCursor: undefined }),
      ),
    });
    const { writer } = createStdout();

    const result = await dispatchOrgScopedList({
      config,
      stdout: writer,
      cwd: "/tmp",
      flags: { limit: 10, json: true },
      parsed: { type: "org-all", org: "my-org" },
    });

    expect(result.hasMore).toBe(false);
    expect(result.items).toHaveLength(1);
  });

  test("explicit mode uses listForProject when available", async () => {
    const listForProject = vi.fn(() =>
      Promise.resolve([{ id: "1", name: "T" }]),
    );
    const config = makeConfig({ listForProject });
    const { writer } = createStdout();

    const result = await dispatchOrgScopedList({
      config,
      stdout: writer,
      cwd: "/tmp",
      flags: { limit: 10, json: true },
      parsed: { type: "explicit", org: "my-org", project: "my-proj" },
    });

    expect(listForProject).toHaveBeenCalledWith("my-org", "my-proj");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].orgSlug).toBe("my-org");
  });

  test("explicit mode falls back to org-scoped with note when no listForProject", async () => {
    const listForOrg = vi.fn(() => Promise.resolve([{ id: "1", name: "R" }]));
    const config = makeConfig({ listForOrg }); // no listForProject
    const { writer } = createStdout();

    const result = await dispatchOrgScopedList({
      config,
      stdout: writer,
      cwd: "/tmp",
      flags: { limit: 10, json: false },
      parsed: { type: "explicit", org: "my-org", project: "my-proj" },
    });

    expect(listForOrg).toHaveBeenCalledWith("my-org");
    expect(result.header).toContain("org-scoped");
  });

  test("override replaces default handler for that mode", async () => {
    const config = makeConfig();
    const { writer } = createStdout();
    const overrideCalled = vi.fn(() =>
      Promise.resolve({ items: [] } as ListResult<FakeWithOrg>),
    );

    await dispatchOrgScopedList({
      config,
      stdout: writer,
      cwd: "/tmp",
      flags: { limit: 10, json: false },
      parsed: { type: "auto-detect" },
      overrides: {
        "auto-detect": overrideCalled,
      },
    });

    expect(overrideCalled).toHaveBeenCalledTimes(1);
  });

  test("override does not affect other modes", async () => {
    const items: FakeEntity[] = [{ id: "1", name: "A" }];
    const config = makeConfig({
      listPaginated: vi.fn(() =>
        Promise.resolve({ data: items, nextCursor: undefined }),
      ),
    });
    const { writer } = createStdout();
    const autoDetectOverride = vi.fn(() =>
      Promise.resolve({ items: [] } as ListResult<FakeWithOrg>),
    );

    const result = await dispatchOrgScopedList({
      config,
      stdout: writer,
      cwd: "/tmp",
      flags: { limit: 10, json: true },
      parsed: { type: "org-all", org: "my-org" },
      overrides: {
        "auto-detect": autoDetectOverride, // overrides auto-detect, not org-all
      },
    });

    // org-all default handler ran, not the auto-detect override
    expect(autoDetectOverride).not.toHaveBeenCalled();
    expect(result.hasMore).toBe(false);
  });

  test("metadata-only config with full overrides dispatches correctly", async () => {
    const { writer } = createStdout();
    const handler = vi.fn(() =>
      Promise.resolve({ items: [] } as ListResult<unknown>),
    );

    await dispatchOrgScopedList({
      config: META_ONLY,
      stdout: writer,
      cwd: "/tmp",
      flags: { limit: 10, json: false },
      parsed: { type: "explicit", org: "my-org", project: "my-proj" },
      overrides: {
        "auto-detect": handler,
        explicit: handler,
        "project-search": handler,
        "org-all": handler,
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("metadata-only config without override for invoked mode throws", async () => {
    const { writer } = createStdout();

    await expect(
      dispatchOrgScopedList({
        config: META_ONLY,
        stdout: writer,
        cwd: "/tmp",
        flags: { limit: 10, json: false },
        parsed: { type: "auto-detect" },
        overrides: {
          // missing auto-detect override — should throw
          explicit: vi.fn(() =>
            Promise.resolve({ items: [] } as ListResult<unknown>),
          ),
        },
      }),
    ).rejects.toThrow("No handler for 'auto-detect' mode");
  });

  // -------------------------------------------------------------------------
  // Project-search pre-check
  // -------------------------------------------------------------------------

  describe("project-search pre-check", () => {
    const findProjectsBySlugMock = vi.mocked(apiClient.findProjectsBySlug);

    beforeEach(() => {
      findProjectsBySlugMock.mockReset();
    });

    afterEach(() => {
      findProjectsBySlugMock.mockReset();
    });

    test("redirects to org-all when no project matches an organization slug", async () => {
      findProjectsBySlugMock.mockResolvedValue({
        projects: [],
        orgs: [{ slug: "acme-corp", id: "1", name: "Acme Corp" }],
      });

      const items: FakeEntity[] = [{ id: "1", name: "Widget A" }];
      const config = makeConfig({
        listPaginated: vi.fn(() =>
          Promise.resolve({ data: items, nextCursor: undefined }),
        ),
      });

      const result = await dispatchOrgScopedList({
        config,
        cwd: "/tmp",
        flags: { limit: 10, json: true },
        parsed: { type: "project-search", projectSlug: "acme-corp" },
      });

      expect(config.listPaginated).toHaveBeenCalled();
      expect(result.items).toHaveLength(1);
      expect(result.items[0].orgSlug).toBe("acme-corp");
      expect(findProjectsBySlugMock).toHaveBeenCalledTimes(1);
    });

    test("keeps the project when an organization has the same slug", async () => {
      findProjectsBySlugMock.mockResolvedValue({
        projects: [
          {
            id: "9",
            slug: "acme-corp",
            name: "Acme Project",
            orgSlug: "other-org",
          },
        ],
        orgs: [
          { slug: "acme-corp", id: "1", name: "Acme Corp" },
          { slug: "other-org", id: "2", name: "Other Org" },
        ],
      });

      const projectHandler = vi.fn(() =>
        Promise.resolve({ items: [] } as ListResult<FakeWithOrg>),
      );
      const orgHandler = vi.fn(() =>
        Promise.resolve({ items: [] } as ListResult<FakeWithOrg>),
      );

      await dispatchOrgScopedList({
        config: META_ONLY,
        cwd: "/tmp",
        flags: { limit: 10, json: false },
        parsed: { type: "project-search", projectSlug: "acme-corp" },
        overrides: {
          "auto-detect": projectHandler,
          explicit: projectHandler,
          "project-search": projectHandler,
          "org-all": orgHandler,
        },
      });

      expect(projectHandler).toHaveBeenCalledTimes(1);
      expect(orgHandler).not.toHaveBeenCalled();
      expect(findProjectsBySlugMock).toHaveBeenCalledTimes(1);
      expect(projectHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          projectSearchResolution: expect.objectContaining({
            kind: "projects",
            projects: [
              expect.objectContaining({
                slug: "acme-corp",
                orgSlug: "other-org",
              }),
            ],
          }),
        }),
      );
    });

    test("rejects an invalid cursor before fuzzy project fan-out", async () => {
      findProjectsBySlugMock.mockResolvedValue({
        projects: [],
        orgs: [{ slug: "acme", id: "1", name: "Acme" }],
      });
      const listProjectsMock = vi.mocked(apiClient.listProjects);
      listProjectsMock.mockClear();

      await expect(
        dispatchOrgScopedList({
          config: makeConfig(),
          cwd: "/tmp",
          flags: { limit: 10, json: false, cursor: "next" },
          parsed: { type: "project-search", projectSlug: "missing" },
        }),
      ).rejects.toThrow(ValidationError);

      expect(findProjectsBySlugMock).toHaveBeenCalledTimes(1);
      expect(listProjectsMock).not.toHaveBeenCalled();
    });

    test("falls through when the slug matches neither a project nor an organization", async () => {
      findProjectsBySlugMock.mockResolvedValue({
        projects: [],
        orgs: [{ slug: "other-org", id: "2", name: "Other Org" }],
      });

      const handler = vi.fn(() =>
        Promise.resolve({ items: [] } as ListResult<FakeWithOrg>),
      );

      await dispatchOrgScopedList({
        config: META_ONLY,
        cwd: "/tmp",
        flags: { limit: 10, json: false },
        parsed: { type: "project-search", projectSlug: "acme-corp" },
        overrides: {
          "auto-detect": handler,
          explicit: handler,
          "project-search": handler,
          "org-all": handler,
        },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]?.[0].parsed.type).toBe("project-search");
    });
  });
});
