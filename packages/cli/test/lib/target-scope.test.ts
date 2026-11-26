/**
 * The issue check of a target-scoped SDK invocation (`limitToTarget`).
 */

import { describe, expect, test } from "vitest";
import {
  SCOPE_ORG_ENV_VAR,
  SCOPE_PROJECT_ENV_VAR,
  withEnv,
} from "../../src/lib/env.js";
import { ResolutionError } from "../../src/lib/errors.js";
import { assertIssueInScope } from "../../src/lib/target-scope.js";

const WEB_ISSUE = { id: "100", project: { id: "1", slug: "web" } };

function check(
  env: Record<string, string>,
  org: string,
  issue: Parameters<typeof assertIssueInScope>[1],
): void {
  withEnv(env, () => assertIssueInScope(org, issue));
}

describe("assertIssueInScope", () => {
  const webScope = {
    [SCOPE_ORG_ENV_VAR]: "acme",
    [SCOPE_PROJECT_ENV_VAR]: "web",
  };

  test("takes any issue without a scope", () => {
    expect(() => check({}, "other", WEB_ISSUE)).not.toThrow();
  });

  test("takes an issue of the scope's project", () => {
    expect(() => check(webScope, "acme", WEB_ISSUE)).not.toThrow();
  });

  test.each([
    [
      "another project",
      "acme",
      { ...WEB_ISSUE, project: { id: "2", slug: "api" } },
    ],
    ["another organization", "other", WEB_ISSUE],
    ["an unknown project", "acme", { id: "100" }],
  ])("refuses an issue of %s", (_case, org, issue) => {
    expect(() => check(webScope, org, issue)).toThrow(ResolutionError);
  });

  test("takes any project of an organization scope", () => {
    expect(() =>
      check({ [SCOPE_ORG_ENV_VAR]: "acme" }, "acme", { id: "100" }),
    ).not.toThrow();
  });
});
