/**
 * Multi-Region E2E Tests
 *
 * Tests for multi-region support in the CLI. Verifies that the CLI correctly
 * discovers regions, fetches data from multiple regions, and displays region
 * information when appropriate.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { createE2EContext, type E2EContext } from "../fixture.js";
import { cleanupTestDir, createTestConfigDir } from "../helpers.js";
import {
  createMultiRegionMockServer,
  EU_ORGS,
  EU_PROJECTS,
  type MultiRegionMockServer,
  TEST_TOKEN,
  US_ORGS,
  US_PROJECTS,
} from "../mocks/multiregion.js";

/** Test timeout for multi-region tests (3 servers = slower startup) */
const TEST_TIMEOUT = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// Multi-Region Tests (user has orgs in both US and EU)
// ─────────────────────────────────────────────────────────────────────────────

describe("multi-region", () => {
  let testConfigDir: string;
  let mockServer: MultiRegionMockServer;
  let ctx: E2EContext;

  beforeAll(async () => {
    mockServer = createMultiRegionMockServer();
    await mockServer.start();
  });

  afterAll(() => {
    mockServer.stop();
  });

  beforeEach(async () => {
    testConfigDir = await createTestConfigDir("e2e-multiregion-");
    ctx = createE2EContext(testConfigDir, mockServer.url);
  });

  afterEach(async () => {
    await cleanupTestDir(testConfigDir);
  });

  describe("sentry org list", () => {
    test(
      "shows REGION column when user has orgs in multiple regions",
      { timeout: TEST_TIMEOUT },
      async () => {
        await ctx.setAuthToken(TEST_TOKEN);

        const result = await ctx.run(["org", "list"]);

        expect(result.exitCode).toBe(0);
        // Should have REGION column in header
        expect(result.stdout).toContain("REGION");
        // In test environment, region URLs are localhost, so display shows LOCALHOST
        // The important thing is that REGION column appears when orgs span multiple regions
        // (In production, would show US/EU based on actual hostname like us.sentry.io)
      }
    );

    test(
      "lists organizations from all regions",
      { timeout: TEST_TIMEOUT },
      async () => {
        await ctx.setAuthToken(TEST_TOKEN);

        const result = await ctx.run(["org", "list"]);

        expect(result.exitCode).toBe(0);
        // Should contain US orgs
        for (const orgSlug of US_ORGS) {
          expect(result.stdout).toContain(orgSlug);
        }
        // Should contain EU orgs
        for (const orgSlug of EU_ORGS) {
          expect(result.stdout).toContain(orgSlug);
        }
      }
    );

    test(
      "--json returns orgs from all regions",
      { timeout: TEST_TIMEOUT },
      async () => {
        await ctx.setAuthToken(TEST_TOKEN);

        const result = await ctx.run(["org", "list", "--json"]);

        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);
        expect(Array.isArray(data)).toBe(true);

        const slugs = data.map((org: { slug: string }) => org.slug);
        // Should contain all orgs from both regions
        for (const orgSlug of [...US_ORGS, ...EU_ORGS]) {
          expect(slugs).toContain(orgSlug);
        }
      }
    );
  });

  describe("sentry org view", () => {
    test(
      "routes to correct region for US org",
      { timeout: TEST_TIMEOUT },
      async () => {
        await ctx.setAuthToken(TEST_TOKEN);

        // First list orgs to populate region cache
        await ctx.run(["org", "list"]);

        // Then view a US org
        const result = await ctx.run(["org", "view", "acme-corp"]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("acme-corp");
        expect(result.stdout).toContain("Acme Corporation");
      }
    );

    test(
      "routes to correct region for EU org",
      { timeout: TEST_TIMEOUT },
      async () => {
        await ctx.setAuthToken(TEST_TOKEN);

        // First list orgs to populate region cache
        await ctx.run(["org", "list"]);

        // Then view an EU org
        const result = await ctx.run(["org", "view", "euro-gmbh"]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("euro-gmbh");
        expect(result.stdout).toContain("Euro GmbH");
      }
    );
  });

  describe("sentry project list", () => {
    test(
      "lists projects from US region org",
      { timeout: TEST_TIMEOUT },
      async () => {
        await ctx.setAuthToken(TEST_TOKEN);

        // First list orgs to populate region cache
        await ctx.run(["org", "list"]);

        const result = await ctx.run(["project", "list", "acme-corp/"]);

        expect(result.exitCode).toBe(0);
        // Should contain US projects for acme-corp
        for (const projectSlug of US_PROJECTS["acme-corp"]) {
          expect(result.stdout).toContain(projectSlug);
        }
      }
    );

    test(
      "lists projects from EU region org",
      { timeout: TEST_TIMEOUT },
      async () => {
        await ctx.setAuthToken(TEST_TOKEN);

        // First list orgs to populate region cache
        await ctx.run(["org", "list"]);

        const result = await ctx.run(["project", "list", "euro-gmbh/"]);

        expect(result.exitCode).toBe(0);
        // Should contain EU projects for euro-gmbh
        for (const projectSlug of EU_PROJECTS["euro-gmbh"]) {
          expect(result.stdout).toContain(projectSlug);
        }
      }
    );

    test(
      "--json returns projects from specified region",
      { timeout: TEST_TIMEOUT },
      async () => {
        await ctx.setAuthToken(TEST_TOKEN);

        // First list orgs to populate region cache
        await ctx.run(["org", "list"]);

        const result = await ctx.run([
          "project",
          "list",
          "berlin-startup/",
          "--json",
        ]);

        expect(result.exitCode).toBe(0);
        // JSON output in paginated mode wraps data in { data, hasMore }
        const parsed = JSON.parse(result.stdout);
        const data = Array.isArray(parsed) ? parsed : parsed.data;
        expect(Array.isArray(data)).toBe(true);

        const slugs = data.map((p: { slug: string }) => p.slug);
        for (const projectSlug of EU_PROJECTS["berlin-startup"]) {
          expect(slugs).toContain(projectSlug);
        }
      }
    );
  });

  describe("sentry issue list", () => {
    test(
      "lists issues from US region project",
      { timeout: TEST_TIMEOUT },
      async () => {
        await ctx.setAuthToken(TEST_TOKEN);

        // First list orgs to populate region cache
        await ctx.run(["org", "list"]);

        const result = await ctx.run([
          "issue",
          "list",
          "acme-corp/acme-frontend",
        ]);

        expect(result.exitCode).toBe(0);
        // Should contain the US issue (strip markdown bold markers from short ID)
        expect(result.stdout.replace(/\*\*/g, "")).toContain(
          "ACME-FRONTEND-1A"
        );
      }
    );

    test(
      "lists issues from EU region project",
      { timeout: TEST_TIMEOUT },
      async () => {
        await ctx.setAuthToken(TEST_TOKEN);

        // First list orgs to populate region cache
        await ctx.run(["org", "list"]);

        const result = await ctx.run([
          "issue",
          "list",
          "euro-gmbh/euro-portal",
        ]);

        expect(result.exitCode).toBe(0);
        // Should contain the EU issue (strip markdown bold markers from short ID)
        expect(result.stdout.replace(/\*\*/g, "")).toContain("EURO-PORTAL-1A");
      }
    );

    test(
      "--json returns issues from correct region",
      { timeout: TEST_TIMEOUT },
      async () => {
        await ctx.setAuthToken(TEST_TOKEN);

        // First list orgs to populate region cache
        await ctx.run(["org", "list"]);

        const result = await ctx.run([
          "issue",
          "list",
          "berlin-startup/berlin-app",
          "--json",
        ]);

        expect(result.exitCode).toBe(0);
        // Multi-target mode wraps output in {data, hasMore} object
        const parsed = JSON.parse(result.stdout);
        expect(parsed).toHaveProperty("data");
        expect(Array.isArray(parsed.data)).toBe(true);

        // Should contain Berlin issue
        const shortIds = parsed.data.map((i: { shortId: string }) => i.shortId);
        expect(shortIds).toContain("BERLIN-APP-1A");
      }
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Single Region Tests (user only has orgs in US)
// ─────────────────────────────────────────────────────────────────────────────

describe("single-region", () => {
  let testConfigDir: string;
  let mockServer: MultiRegionMockServer;
  let ctx: E2EContext;

  beforeAll(async () => {
    mockServer = createMultiRegionMockServer({ singleRegionMode: true });
    await mockServer.start();
  });

  afterAll(() => {
    mockServer.stop();
  });

  beforeEach(async () => {
    testConfigDir = await createTestConfigDir("e2e-singleregion-");
    ctx = createE2EContext(testConfigDir, mockServer.url);
  });

  afterEach(async () => {
    await cleanupTestDir(testConfigDir);
  });

  describe("sentry org list", () => {
    test(
      "does NOT show REGION column when user has orgs in single region",
      { timeout: TEST_TIMEOUT },
      async () => {
        await ctx.setAuthToken(TEST_TOKEN);

        const result = await ctx.run(["org", "list"]);

        expect(result.exitCode).toBe(0);
        // Should NOT have REGION column (only one region)
        expect(result.stdout).not.toContain("REGION");
        // Should still contain US orgs
        expect(result.stdout).toContain("acme-corp");
        expect(result.stdout).toContain("widgets-inc");
      }
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Self-Hosted Fallback Tests (regions endpoint returns 404)
// ─────────────────────────────────────────────────────────────────────────────

describe("self-hosted fallback", () => {
  let testConfigDir: string;
  let mockServer: MultiRegionMockServer;
  let ctx: E2EContext;

  beforeAll(async () => {
    mockServer = createMultiRegionMockServer({ selfHostedMode: true });
    await mockServer.start();
  });

  afterAll(() => {
    mockServer.stop();
  });

  beforeEach(async () => {
    testConfigDir = await createTestConfigDir("e2e-selfhosted-");
    ctx = createE2EContext(testConfigDir, mockServer.url);
  });

  afterEach(async () => {
    await cleanupTestDir(testConfigDir);
  });

  describe("sentry org list", () => {
    test(
      "falls back to default API when regions endpoint returns 404",
      { timeout: TEST_TIMEOUT },
      async () => {
        await ctx.setAuthToken(TEST_TOKEN);

        const result = await ctx.run(["org", "list"]);

        expect(result.exitCode).toBe(0);
        // Should still list organizations (from default endpoint)
        expect(result.stdout).toContain("SLUG");
        // Should have orgs from the fallback (US fixtures served by control silo)
        expect(result.stdout).toContain("acme-corp");
      }
    );

    test(
      "--json works with self-hosted fallback",
      { timeout: TEST_TIMEOUT },
      async () => {
        await ctx.setAuthToken(TEST_TOKEN);

        const result = await ctx.run(["org", "list", "--json"]);

        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBeGreaterThan(0);
      }
    );
  });
});
