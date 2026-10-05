/**
 * Issue-Org Cache Tests
 *
 * Covers caching of numeric-issue-id → org-slug mappings used by
 * `resolveNumericIssue` to skip the legacy unscoped `/api/0/issues/{id}/`
 * endpoint on subsequent runs.
 */

import { describe, expect, test } from "vitest";
import {
  clearAllIssueOrgCache,
  clearCachedIssueOrg,
  getCachedIssueOrg,
  setCachedIssueOrg,
} from "../../../src/lib/db/issue-org-cache.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("test-issue-org-cache-");

describe("getCachedIssueOrg", () => {
  test("returns undefined when no entry exists", () => {
    expect(getCachedIssueOrg("123456789")).toBeUndefined();
  });

  test("returns the stored org slug", () => {
    setCachedIssueOrg("7413562541", "brandai");
    expect(getCachedIssueOrg("7413562541")).toBe("brandai");
  });

  test("distinguishes between different issue IDs", () => {
    setCachedIssueOrg("111", "org-a");
    setCachedIssueOrg("222", "org-b");

    expect(getCachedIssueOrg("111")).toBe("org-a");
    expect(getCachedIssueOrg("222")).toBe("org-b");
    expect(getCachedIssueOrg("333")).toBeUndefined();
  });
});

describe("setCachedIssueOrg", () => {
  test("overwrites the mapping for the same issue ID", () => {
    setCachedIssueOrg("42", "first-org");
    setCachedIssueOrg("42", "second-org");

    expect(getCachedIssueOrg("42")).toBe("second-org");
  });

  test("is a no-op when numericId is empty", () => {
    setCachedIssueOrg("", "org");
    // No assertion on internal state — it just must not throw or pollute
    // the cache. Use a sentinel read that would never match an empty key.
    expect(getCachedIssueOrg("")).toBeUndefined();
  });

  test("is a no-op when org is empty", () => {
    setCachedIssueOrg("99", "");
    expect(getCachedIssueOrg("99")).toBeUndefined();
  });
});

describe("clearCachedIssueOrg", () => {
  test("removes a single mapping", () => {
    setCachedIssueOrg("101", "org-x");
    setCachedIssueOrg("102", "org-y");

    clearCachedIssueOrg("101");

    expect(getCachedIssueOrg("101")).toBeUndefined();
    // Other mappings untouched
    expect(getCachedIssueOrg("102")).toBe("org-y");
  });

  test("is idempotent on missing IDs", () => {
    expect(() => clearCachedIssueOrg("nonexistent")).not.toThrow();
  });

  test("is a no-op when numericId is empty", () => {
    setCachedIssueOrg("50", "org");
    clearCachedIssueOrg("");
    // Empty key must not wipe unrelated entries.
    expect(getCachedIssueOrg("50")).toBe("org");
  });
});

describe("clearAllIssueOrgCache", () => {
  test("removes all cached mappings", () => {
    setCachedIssueOrg("1", "a");
    setCachedIssueOrg("2", "b");
    setCachedIssueOrg("3", "c");

    clearAllIssueOrgCache();

    expect(getCachedIssueOrg("1")).toBeUndefined();
    expect(getCachedIssueOrg("2")).toBeUndefined();
    expect(getCachedIssueOrg("3")).toBeUndefined();
  });

  test("does not touch unrelated tables (metadata, org_regions, etc.)", async () => {
    // Seed an unrelated metadata entry + an unrelated table row so we can
    // confirm clearAllIssueOrgCache only drops its own table.
    const { getDatabase } = await import("../../../src/lib/db/index.js");
    const { getMetadata, setMetadata } = await import(
      "../../../src/lib/db/utils.js"
    );
    setMetadata(getDatabase(), { "unrelated.key": "keep-me" });
    setCachedIssueOrg("1", "a");

    clearAllIssueOrgCache();

    expect(getCachedIssueOrg("1")).toBeUndefined();
    expect(
      getMetadata(getDatabase(), ["unrelated.key"]).get("unrelated.key")
    ).toBe("keep-me");
  });
});
