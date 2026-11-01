/**
 * Tests for the shell-completion entity cache.
 */

import { describe, expect, test } from "vitest";
import { seedCompletions } from "../../../src/lib/api/completion-seed.js";
import {
  cacheCompletionEntities,
  clearCompletionCache,
  getCachedCompletionEntities,
  MAX_ENTITIES_PER_ORG,
} from "../../../src/lib/db/completion-cache.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("test-completion-cache-");

describe("completion cache", () => {
  test("keeps list order as recency and refreshes labels", () => {
    cacheCompletionEntities("issue", "acme", [
      { value: "CLI-1", label: "First" },
      { value: "CLI-2", label: "Second" },
    ]);
    cacheCompletionEntities("issue", "acme", [
      { value: "CLI-2", label: "Second, renamed" },
    ]);

    expect(getCachedCompletionEntities("issue", ["acme"])).toEqual([
      { orgSlug: "acme", value: "CLI-2", label: "Second, renamed" },
      { orgSlug: "acme", value: "CLI-1", label: "First" },
    ]);
  });

  test("scopes reads by kind and org", () => {
    cacheCompletionEntities("issue", "acme", [{ value: "CLI-1" }]);
    cacheCompletionEntities("issue", "other", [{ value: "WEB-1" }]);
    cacheCompletionEntities("dashboard", "acme", [{ value: "42" }]);

    expect(
      getCachedCompletionEntities("issue", ["acme"]).map((e) => e.value),
    ).toEqual(["CLI-1"]);
    expect(getCachedCompletionEntities("issue", [])).toEqual([]);
  });

  test("keeps only the newest entries per kind and org", () => {
    const issues = Array.from({ length: MAX_ENTITIES_PER_ORG }, (_, i) => ({
      value: `OLD-${i}`,
    }));
    cacheCompletionEntities("issue", "acme", issues);
    cacheCompletionEntities("issue", "acme", [{ value: "NEW-1" }]);

    const cached = getCachedCompletionEntities("issue", ["acme"]);
    expect(cached).toHaveLength(MAX_ENTITIES_PER_ORG);
    expect(cached[0]?.value).toBe("NEW-1");
    // The last (oldest) entry of the first batch was evicted.
    expect(cached.map((e) => e.value)).not.toContain(
      `OLD-${MAX_ENTITIES_PER_ORG - 1}`,
    );
  });

  test("clearCompletionCache drops every entry", () => {
    cacheCompletionEntities("issue", "acme", [{ value: "CLI-1" }]);
    clearCompletionCache();
    expect(getCachedCompletionEntities("issue", ["acme"])).toEqual([]);
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
    await seedCompletions(
      `${API}/issues/?query=is%3Aunresolved`,
      json([
        { shortId: "CLI-1A", title: "TypeError: x is undefined" },
        { title: "No short ID" },
      ]),
    );
    await seedCompletions(
      `${API}/issues/123/`,
      json({ shortId: "CLI-2B", title: "Timeout" }),
    );
    await seedCompletions(
      `${API}/shortids/CLI-3C/`,
      json({ group: { shortId: "CLI-3C", title: "Crash" } }),
    );

    expect(
      getCachedCompletionEntities("issue", ["acme"]).map((e) => e.value),
    ).toEqual(["CLI-3C", "CLI-2B", "CLI-1A"]);
  });

  test("unscoped issue lookups take the org from the permalink", async () => {
    const issues = "https://sentry.io/api/0/issues";
    await seedCompletions(
      `${issues}/123/`,
      json({
        shortId: "CLI-1A",
        title: "Boom",
        permalink: "https://acme.sentry.io/issues/123/",
      }),
    );
    await seedCompletions(
      `${issues}/456/`,
      json({ shortId: "CLI-2B", title: "No permalink" }),
    );

    expect(getCachedCompletionEntities("issue", ["acme"])).toEqual([
      { orgSlug: "acme", value: "CLI-1A", label: "Boom" },
    ]);
  });

  test("issue details store their tag keys, scoped and unscoped", async () => {
    await seedCompletions(
      `${API}/issues/123/`,
      json({
        shortId: "CLI-1A",
        tags: [
          { key: "browser.name", name: "Browser.Name" },
          { name: "No key" },
        ],
      }),
    );
    await seedCompletions(
      "https://sentry.io/api/0/issues/456/",
      json({
        shortId: "CLI-2B",
        permalink: "https://acme.sentry.io/issues/456/",
        tags: [{ key: "release", name: "Release" }],
      }),
    );
    await seedCompletions(`${API}/issues/`, json([{ shortId: "CLI-3C" }]));

    expect(getCachedCompletionEntities("tag-key", ["acme"])).toEqual([
      { orgSlug: "acme", value: "release", label: "Release" },
      { orgSlug: "acme", value: "browser.name", label: "Browser.Name" },
    ]);
  });

  test("dashboards are stored by numeric ID only", async () => {
    await seedCompletions(
      `${API}/dashboards/`,
      json([
        { id: "12", title: "Errors" },
        { id: "default-overview", title: "Prebuilt" },
      ]),
    );

    expect(getCachedCompletionEntities("dashboard", ["acme"])).toEqual([
      { orgSlug: "acme", value: "12", label: "Errors" },
    ]);
  });

  test("team lists are stored as slugs and as team:<id> owners", async () => {
    await seedCompletions(
      `${API}/teams/`,
      json([{ id: "7", slug: "backend", name: "Backend" }]),
    );

    expect(getCachedCompletionEntities("team", ["acme"])).toEqual([
      { orgSlug: "acme", value: "backend", label: "Backend" },
    ]);
    expect(getCachedCompletionEntities("owner", ["acme"])).toEqual([
      { orgSlug: "acme", value: "team:7", label: "#backend" },
    ]);
  });

  test("environments, releases, monitors, and workflows keep the value their flags read", async () => {
    await seedCompletions(
      "https://us.sentry.io/api/0/projects/acme/cli/environments/",
      json([{ id: "1", name: "production" }]),
    );
    await seedCompletions(
      `${API}/releases/`,
      json([{ version: "cli@1.2.0+abc", shortVersion: "1.2.0" }]),
    );
    await seedCompletions(
      `${API}/monitors/nightly/`,
      json({ slug: "nightly", name: "Nightly job" }),
    );
    await seedCompletions(
      `${API}/workflows/`,
      json([{ id: "42", name: "Page on-call" }]),
    );

    expect(getCachedCompletionEntities("environment", ["acme"])).toEqual([
      { orgSlug: "acme", value: "production", label: undefined },
    ]);
    expect(getCachedCompletionEntities("release", ["acme"])).toEqual([
      { orgSlug: "acme", value: "cli@1.2.0+abc", label: "1.2.0" },
    ]);
    expect(getCachedCompletionEntities("monitor", ["acme"])).toEqual([
      { orgSlug: "acme", value: "nightly", label: "Nightly job" },
    ]);
    expect(getCachedCompletionEntities("workflow", ["acme"])).toEqual([
      { orgSlug: "acme", value: "42", label: "Page on-call" },
    ]);
  });

  test("integrations by ID and installed Sentry Apps by slug", async () => {
    await seedCompletions(
      `${API}/integrations/`,
      json([{ id: "99", name: "acme-jira", provider: { name: "Jira" } }]),
    );
    await seedCompletions(
      `${API}/sentry-app-installations/`,
      json([{ app: { slug: "linear", name: "Linear" } }]),
    );

    expect(getCachedCompletionEntities("integration", ["acme"])).toEqual([
      { orgSlug: "acme", value: "99", label: "Jira: acme-jira" },
    ]);
    expect(getCachedCompletionEntities("sentry-app", ["acme"])).toEqual([
      { orgSlug: "acme", value: "linear", label: "Linear" },
    ]);
  });

  test("Sentry App issue-link forms are stored as name= and their fixed choices", async () => {
    await seedCompletions(
      `${API}/sentry-app-components/?filter=issue-link`,
      json([
        {
          type: "issue-link",
          sentryApp: { slug: "tracker" },
          schema: {
            link: {
              uri: "/link",
              required_fields: [
                {
                  name: "priority",
                  type: "select",
                  choices: [
                    ["high", "High"],
                    [2, "Low"],
                  ],
                },
              ],
              optional_fields: [{ name: "note", type: "text" }],
            },
          },
        },
        { type: "alert-rule-action", schema: { link: {} } },
      ]),
    );

    expect(getCachedCompletionEntities("app-link-field", ["acme"])).toEqual([
      { orgSlug: "acme", value: "priority=", label: "tracker, required" },
      { orgSlug: "acme", value: "priority=high", label: "tracker, required" },
      { orgSlug: "acme", value: "priority=2", label: "tracker, required" },
      { orgSlug: "acme", value: "note=", label: "tracker" },
    ]);
  });

  test("client keys are stored by public DSN", async () => {
    await seedCompletions(
      "https://us.sentry.io/api/0/projects/acme/cli/keys/",
      json([
        { name: "Default", dsn: { public: "https://k@o1.ingest.sentry.io/1" } },
      ]),
    );

    expect(getCachedCompletionEntities("dsn", ["acme"])).toEqual([
      {
        orgSlug: "acme",
        value: "https://k@o1.ingest.sentry.io/1",
        label: "Default",
      },
    ]);
  });

  test("attribute keys are stored by the dataset the request names", async () => {
    const attributes = (dataset: string) =>
      `${API}/trace-items/attributes/?dataset=${dataset}&attributeType=number`;
    await seedCompletions(
      attributes("spans"),
      json([
        {
          key: "span.duration",
          name: "span.duration",
          attributeType: "number",
        },
        {
          key: "tags[cart.total,number]",
          name: "cart.total",
          attributeType: "number",
        },
      ]),
    );
    await seedCompletions(
      attributes("logs"),
      json([{ key: "severity", name: "severity", attributeType: "string" }]),
    );
    // Datasets nothing completes, and requests that name none, store nothing
    await seedCompletions(
      attributes("preprod"),
      json([{ key: "app.size", name: "app.size", attributeType: "number" }]),
    );
    await seedCompletions(
      `${API}/trace-items/attributes/`,
      json([{ key: "span.op", name: "span.op", attributeType: "string" }]),
    );

    expect(getCachedCompletionEntities("span-attribute", ["acme"])).toEqual([
      { orgSlug: "acme", value: "span.duration", label: "number" },
      {
        orgSlug: "acme",
        value: "tags[cart.total,number]",
        label: "cart.total (number)",
      },
    ]);
    expect(getCachedCompletionEntities("log-attribute", ["acme"])).toEqual([
      { orgSlug: "acme", value: "severity", label: "string" },
    ]);
    expect(getCachedCompletionEntities("metric-attribute", ["acme"])).toEqual(
      [],
    );
  });

  test("ignores other endpoints, failed responses, and bodies that are not JSON", async () => {
    const issue = { shortId: "CLI-1A", title: "Boom" };
    await seedCompletions(`${API}/issues/123/events/`, json([issue]));
    await seedCompletions(`${API}/issues/`, json([issue], { status: 500 }));
    await seedCompletions(
      `${API}/issues/`,
      new Response("not json", {
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(getCachedCompletionEntities("issue", ["acme"])).toEqual([]);
  });

  test("leaves the response body readable", async () => {
    const response = json([{ shortId: "CLI-1A" }]);
    await seedCompletions(`${API}/issues/`, response);

    expect(await response.json()).toEqual([{ shortId: "CLI-1A" }]);
  });
});
