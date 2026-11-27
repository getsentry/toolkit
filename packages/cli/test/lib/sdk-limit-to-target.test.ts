/**
 * `createSentrySDK({ org, project })` limits commands to that project by
 * default; `limitToTarget: false` makes `org` and `project` only defaults.
 * The checks themselves are covered in `target-scope.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import createSentrySDK from "../../src/index.js";
import { __resetScopeLookupsForTests } from "../../src/lib/target-scope.js";
import issueFixture from "../fixtures/issue.json";
import { mockFetch, useTestConfigDir } from "../helpers.js";

/** Issue 200 is in `api`, outside the SDK's `acme/web`. */
const API_ISSUE = {
  ...issueFixture,
  id: "200",
  shortId: "API-1",
  project: { id: "2", slug: "api", name: "API", platform: "python" },
};

function sentryApi(): typeof fetch {
  return mockFetch(async (input, init) => {
    const path = new URL(new Request(input, init).url).pathname;
    if (path === "/api/0/organizations/acme/") {
      return Response.json({ id: "9", slug: "acme", name: "Acme" });
    }
    if (path === "/api/0/projects/acme/web/") {
      return Response.json({ id: "1", slug: "web" });
    }
    if (path === "/api/0/organizations/acme/issues/200/") {
      return Response.json(API_ISSUE);
    }
    return Response.json({ detail: "Not found" }, { status: 404 });
  });
}

function sdkFor(options: { limitToTarget?: boolean }) {
  return createSentrySDK({
    token: `sntryu_${"a".repeat(64)}`,
    org: "acme",
    project: "web",
    ...options,
  });
}

function viewIssue(options: { limitToTarget?: boolean }): Promise<unknown> {
  return sdkFor(options).run("issue", "view", "200") as Promise<unknown>;
}

describe("createSentrySDK({ org, project })", () => {
  useTestConfigDir("sdk-limit-to-target-");
  let originalFetch: typeof fetch;

  beforeEach(() => {
    __resetScopeLookupsForTests();
    originalFetch = globalThis.fetch;
    globalThis.fetch = sentryApi();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("refuses another project's issue by default", async () => {
    await expect(viewIssue({})).rejects.toThrow(
      /Issue 200 is outside this session's scope \(acme\/web\)/,
    );
  });

  test("reads it with limitToTarget: false", async () => {
    expect(await viewIssue({ limitToTarget: false })).toMatchObject({
      shortId: "API-1",
    });
  });

  // `sentry api` sends a path the caller picks; the transport refuses it
  // like any other request.
  test.each([
    "organizations/other/issues/",
    "/api/0/organizations/other/issues/",
    "projects/acme/api/",
    "issues/200/",
  ])("refuses `sentry api %s`", async (path) => {
    await expect(sdkFor({}).run("api", path)).rejects.toThrow(
      /outside this session's scope \(acme\/web\)/,
    );
  });
});
