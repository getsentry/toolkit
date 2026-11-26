/**
 * `createSentrySDK({ org, project })` limits commands to that project by
 * default; `limitToTarget: false` makes `org` and `project` only defaults.
 * The checks themselves are covered in `target-scope.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import createSentrySDK from "../../src/index.js";
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
    if (path === "/api/0/organizations/acme/issues/200/") {
      return Response.json(API_ISSUE);
    }
    return Response.json({ detail: "Not found" }, { status: 404 });
  });
}

function viewIssue(options: { limitToTarget?: boolean }): Promise<unknown> {
  const sdk = createSentrySDK({
    token: `sntryu_${"a".repeat(64)}`,
    org: "acme",
    project: "web",
    ...options,
  });
  return sdk.run("issue", "view", "200") as Promise<unknown>;
}

describe("createSentrySDK({ org, project })", () => {
  useTestConfigDir("sdk-limit-to-target-");
  let originalFetch: typeof fetch;

  beforeEach(() => {
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
});
