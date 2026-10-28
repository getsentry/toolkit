/**
 * Tests for the shell-completion entity cache.
 */

import { describe, expect, test } from "vitest";
import { seedCompletionsFromResponse } from "../../../src/lib/api/completion-seed.js";
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

describe("completion seeding from API responses", () => {
  const API = "https://us.sentry.io/api/0/organizations/acme";

  function json(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  }

  test("issue lists and details are stored by short ID with their title", async () => {
    await seedCompletionsFromResponse(
      `${API}/issues/?query=is%3Aunresolved`,
      json([
        { shortId: "CLI-1A", title: "TypeError: x is undefined" },
        { title: "No short ID" },
      ]),
    );
    await seedCompletionsFromResponse(
      `${API}/issues/123/`,
      json({ shortId: "CLI-2B", title: "Timeout" }),
    );
    await seedCompletionsFromResponse(
      `${API}/shortids/CLI-3C/`,
      json({ group: { shortId: "CLI-3C", title: "Crash" } }),
    );

    expect(
      getCachedCompletionEntities(ISSUE_ENTITY, ["acme"]).map((e) => e.value),
    ).toEqual(["CLI-3C", "CLI-2B", "CLI-1A"]);
  });

  test("unscoped issue lookups take the org from the permalink", async () => {
    const issues = "https://sentry.io/api/0/issues";
    await seedCompletionsFromResponse(
      `${issues}/123/`,
      json({
        shortId: "CLI-1A",
        title: "Boom",
        permalink: "https://acme.sentry.io/issues/123/",
      }),
    );
    await seedCompletionsFromResponse(
      `${issues}/456/`,
      json({ shortId: "CLI-2B", title: "No permalink" }),
    );

    expect(getCachedCompletionEntities(ISSUE_ENTITY, ["acme"])).toEqual([
      { orgSlug: "acme", value: "CLI-1A", label: "Boom" },
    ]);
  });

  test("dashboards are stored by numeric ID only", async () => {
    await seedCompletionsFromResponse(
      `${API}/dashboards/`,
      json([
        { id: "12", title: "Errors" },
        { id: "default-overview", title: "Prebuilt" },
      ]),
    );

    expect(getCachedCompletionEntities(DASHBOARD_ENTITY, ["acme"])).toEqual([
      { orgSlug: "acme", value: "12", label: "Errors" },
    ]);
  });

  test("ignores other endpoints, failed responses, and bodies that are not JSON", async () => {
    const issue = { shortId: "CLI-1A", title: "Boom" };
    await seedCompletionsFromResponse(
      `${API}/issues/123/events/`,
      json([issue]),
    );
    await seedCompletionsFromResponse(
      `${API}/issues/`,
      json([issue], { status: 500 }),
    );
    await seedCompletionsFromResponse(
      `${API}/issues/`,
      new Response("not json", {
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(getCachedCompletionEntities(ISSUE_ENTITY, ["acme"])).toEqual([]);
  });

  test("leaves the response body readable", async () => {
    const response = json([{ shortId: "CLI-1A" }]);
    await seedCompletionsFromResponse(`${API}/issues/`, response);

    expect(await response.json()).toEqual([{ shortId: "CLI-1A" }]);
  });
});
