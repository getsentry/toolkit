/**
 * Tests for alias generation utilities
 *
 * Note: Core invariants (uniqueness, prefix correctness, case handling) are tested
 * via property-based tests in alias.property.test.ts. These tests focus on
 * specific expected outputs and integration scenarios.
 */

import { describe, expect, test } from "vitest";
import {
  buildOrgAwareAliases,
  findCommonWordPrefix,
  findShortestUniquePrefixes,
} from "../../src/lib/alias.js";

describe("alias generation integration", () => {
  test("generates short aliases for spotlight projects", () => {
    const projectSlugs = [
      "spotlight-electron",
      "spotlight-website",
      "spotlight",
    ];

    // Strip common prefix
    const commonPrefix = findCommonWordPrefix(projectSlugs);
    expect(commonPrefix).toBe("spotlight-");

    // Create remainders
    const slugToRemainder = new Map<string, string>();
    for (const slug of projectSlugs) {
      const remainder = slug.slice(commonPrefix.length);
      slugToRemainder.set(slug, remainder || slug);
    }

    expect(slugToRemainder.get("spotlight-electron")).toBe("electron");
    expect(slugToRemainder.get("spotlight-website")).toBe("website");
    expect(slugToRemainder.get("spotlight")).toBe("spotlight"); // No prefix to strip

    // Find unique prefixes for remainders
    const remainders = [...slugToRemainder.values()];
    const prefixes = findShortestUniquePrefixes(remainders);

    expect(prefixes.get("electron")).toBe("e");
    expect(prefixes.get("website")).toBe("w");
    expect(prefixes.get("spotlight")).toBe("s");
  });

  test("generates aliases without stripping for unrelated projects", () => {
    const projectSlugs = ["frontend", "backend", "worker"];

    const commonPrefix = findCommonWordPrefix(projectSlugs);
    expect(commonPrefix).toBe("");

    const prefixes = findShortestUniquePrefixes(projectSlugs);
    expect(prefixes.get("frontend")).toBe("f");
    expect(prefixes.get("backend")).toBe("b");
    expect(prefixes.get("worker")).toBe("w");
  });
});

describe("buildOrgAwareAliases specific outputs", () => {
  // These tests verify specific expected alias outputs for documentation
  // and to catch any changes to the alias generation algorithm.

  test("single org multiple projects - expected aliases", () => {
    const result = buildOrgAwareAliases([
      { org: "acme", project: "frontend" },
      { org: "acme", project: "backend" },
    ]);
    expect(result.aliasMap.get("acme/frontend")).toBe("f");
    expect(result.aliasMap.get("acme/backend")).toBe("b");
  });

  test("collision with distinct org names - expected format", () => {
    const result = buildOrgAwareAliases([
      { org: "acme-corp", project: "api" },
      { org: "bigco", project: "api" },
    ]);

    // Org prefixes should be unique: "a" vs "b"
    expect(result.aliasMap.get("acme-corp/api")).toBe("a/a");
    expect(result.aliasMap.get("bigco/api")).toBe("b/a");
  });

  test("preserves common word prefix stripping for unique projects", () => {
    const result = buildOrgAwareAliases([
      { org: "acme", project: "spotlight-electron" },
      { org: "acme", project: "spotlight-website" },
    ]);
    // Common prefix "spotlight-" is stripped internally, resulting in short aliases
    expect(result.aliasMap.get("acme/spotlight-electron")).toBe("e");
    expect(result.aliasMap.get("acme/spotlight-website")).toBe("w");
  });

  test("collision with similar org names uses longer prefixes", () => {
    const result = buildOrgAwareAliases([
      { org: "organization1", project: "app" },
      { org: "organization2", project: "app" },
    ]);

    const alias1 = result.aliasMap.get("organization1/app");
    const alias2 = result.aliasMap.get("organization2/app");

    // Both orgs start with "organization", so prefixes need to be longer
    expect(alias1).not.toBe(alias2);
    // Should include enough of the org to be unique
    expect(alias1).toMatch(/\/a$/); // ends with project prefix
    expect(alias2).toMatch(/\/a$/);
  });

  test("multiple collisions across same orgs - all unique", () => {
    const result = buildOrgAwareAliases([
      { org: "org1", project: "api" },
      { org: "org2", project: "api" },
      { org: "org1", project: "web" },
      { org: "org2", project: "web" },
    ]);

    // All four should have org-prefixed aliases with slash
    expect(result.aliasMap.get("org1/api")).toContain("/");
    expect(result.aliasMap.get("org2/api")).toContain("/");
    expect(result.aliasMap.get("org1/web")).toContain("/");
    expect(result.aliasMap.get("org2/web")).toContain("/");

    // All should be unique
    const aliases = [...result.aliasMap.values()];
    const uniqueAliases = new Set(aliases);
    expect(uniqueAliases.size).toBe(aliases.length);
  });

  test("collision with same-letter project slugs uses unique project prefixes", () => {
    // Both "api" and "app" start with "a" - need unique project prefixes
    const result = buildOrgAwareAliases([
      { org: "org1", project: "api" },
      { org: "org2", project: "api" },
      { org: "org1", project: "app" },
      { org: "org2", project: "app" },
    ]);

    // All four should be unique
    const aliases = [...result.aliasMap.values()];
    const uniqueAliases = new Set(aliases);
    expect(uniqueAliases.size).toBe(4);

    // api and app should have different project prefixes (not both "a")
    const org1Api = result.aliasMap.get("org1/api");
    const org1App = result.aliasMap.get("org1/app");
    expect(org1Api).not.toBe(org1App);

    // Project prefixes should distinguish api vs app
    // e.g., "o1/api" vs "o1/app"
    expect(org1Api).toMatch(/^o.*\/api$/);
    expect(org1App).toMatch(/^o.*\/app$/);
  });

  test("handles slug that is prefix of another slug", () => {
    const result = buildOrgAwareAliases([
      { org: "acme", project: "cli" },
      { org: "acme", project: "cli-website" },
    ]);
    // "cli" is a prefix of "cli-website", so cli-website uses "website" as remainder
    expect(result.aliasMap.get("acme/cli")).toBe("c");
    expect(result.aliasMap.get("acme/cli-website")).toBe("w");
  });

  test("handles nested prefix relationships", () => {
    const result = buildOrgAwareAliases([
      { org: "acme", project: "api" },
      { org: "acme", project: "api-server" },
      { org: "acme", project: "api-server-v2" },
    ]);
    // api → api, api-server → server, api-server-v2 → v2
    expect(result.aliasMap.get("acme/api")).toBe("a");
    expect(result.aliasMap.get("acme/api-server")).toBe("s");
    expect(result.aliasMap.get("acme/api-server-v2")).toBe("v");
  });

  test("no alias ends with dash or underscore", () => {
    const result = buildOrgAwareAliases([
      { org: "acme", project: "cli" },
      { org: "acme", project: "cli-website" },
      { org: "acme", project: "cli-app" },
    ]);
    for (const alias of result.aliasMap.values()) {
      expect(alias.endsWith("-")).toBe(false);
      expect(alias.endsWith("_")).toBe(false);
    }
  });

  test("avoids collision when prefix-stripped remainder matches another slug", () => {
    // Edge case: "cli-website" would become "website" after stripping "cli-",
    // but "website" is already a project slug - must avoid duplicate aliases
    const result = buildOrgAwareAliases([
      { org: "acme", project: "cli" },
      { org: "acme", project: "cli-website" },
      { org: "acme", project: "website" },
    ]);

    // All aliases must be unique
    const aliases = [...result.aliasMap.values()];
    const uniqueAliases = new Set(aliases);
    expect(uniqueAliases.size).toBe(aliases.length);

    // No alias should end with dash
    for (const alias of aliases) {
      expect(alias.endsWith("-")).toBe(false);
    }
  });
});
