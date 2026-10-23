/**
 * Tests for the shell-completion entity cache.
 */

import { describe, expect, test } from "vitest";
import {
  seedDashboardCompletions,
  seedIssueCompletions,
} from "../../../src/lib/api/completion-seed.js";
import {
  cacheCompletionEntities,
  clearCompletionCache,
  DASHBOARD_ENTITY,
  getCachedCompletionEntities,
  ISSUE_ENTITY,
  MAX_ENTITIES_PER_ORG,
} from "../../../src/lib/db/completion-cache.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("test-completion-cache-");

describe("completion cache", () => {
  test("keeps list order as recency and refreshes labels", () => {
    cacheCompletionEntities(ISSUE_ENTITY, "acme", [
      { value: "CLI-1", label: "First" },
      { value: "CLI-2", label: "Second" },
    ]);
    cacheCompletionEntities(ISSUE_ENTITY, "acme", [
      { value: "CLI-2", label: "Second, renamed" },
    ]);

    expect(getCachedCompletionEntities(ISSUE_ENTITY, ["acme"])).toEqual([
      { orgSlug: "acme", value: "CLI-2", label: "Second, renamed" },
      { orgSlug: "acme", value: "CLI-1", label: "First" },
    ]);
  });

  test("scopes reads by kind and org", () => {
    cacheCompletionEntities(ISSUE_ENTITY, "acme", [{ value: "CLI-1" }]);
    cacheCompletionEntities(ISSUE_ENTITY, "other", [{ value: "WEB-1" }]);
    cacheCompletionEntities(DASHBOARD_ENTITY, "acme", [{ value: "42" }]);

    expect(
      getCachedCompletionEntities(ISSUE_ENTITY, ["acme"]).map((e) => e.value),
    ).toEqual(["CLI-1"]);
    expect(getCachedCompletionEntities(ISSUE_ENTITY, [])).toEqual([]);
  });

  test("keeps only the newest entries per kind and org", () => {
    const issues = Array.from({ length: MAX_ENTITIES_PER_ORG }, (_, i) => ({
      value: `OLD-${i}`,
    }));
    cacheCompletionEntities(ISSUE_ENTITY, "acme", issues);
    cacheCompletionEntities(ISSUE_ENTITY, "acme", [{ value: "NEW-1" }]);

    const cached = getCachedCompletionEntities(ISSUE_ENTITY, ["acme"]);
    expect(cached).toHaveLength(MAX_ENTITIES_PER_ORG);
    expect(cached[0]?.value).toBe("NEW-1");
    // The last (oldest) entry of the first batch was evicted.
    expect(cached.map((e) => e.value)).not.toContain(
      `OLD-${MAX_ENTITIES_PER_ORG - 1}`,
    );
  });

  test("clearCompletionCache drops every entry", () => {
    cacheCompletionEntities(ISSUE_ENTITY, "acme", [{ value: "CLI-1" }]);
    clearCompletionCache();
    expect(getCachedCompletionEntities(ISSUE_ENTITY, ["acme"])).toEqual([]);
  });
});

describe("completion seeding from API data", () => {
  test("issues are stored by short ID with their title", () => {
    seedIssueCompletions("acme", [
      { shortId: "CLI-1A", title: "TypeError: x is undefined" },
      { shortId: undefined, title: "No short ID" },
    ]);

    expect(getCachedCompletionEntities(ISSUE_ENTITY, ["acme"])).toEqual([
      { orgSlug: "acme", value: "CLI-1A", label: "TypeError: x is undefined" },
    ]);
  });

  test("dashboards are stored by numeric ID only", () => {
    seedDashboardCompletions("acme", [
      { id: "12", title: "Errors" },
      { id: "default-overview", title: "Prebuilt" },
    ]);

    expect(getCachedCompletionEntities(DASHBOARD_ENTITY, ["acme"])).toEqual([
      { orgSlug: "acme", value: "12", label: "Errors" },
    ]);
  });
});
