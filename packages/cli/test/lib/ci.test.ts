/** Tests for the shared CI environment detector. */

import { describe, expect, test } from "vitest";
import { getCiCheckout, isCi } from "../../src/lib/ci.js";

describe("isCi", () => {
  test("true when a CI variable is set", () => {
    expect(isCi({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(isCi({ TF_BUILD: "True" })).toBe(true);
    expect(isCi({ CI: "1" })).toBe(true);
  });

  test("false with no CI variables (and ignores opt-out values)", () => {
    expect(isCi({})).toBe(false);
    expect(isCi({ CI: "" })).toBe(false);
    expect(isCi({ CI: "false" })).toBe(false);
    expect(isCi({ CI: "0" })).toBe(false);
  });

  test("detects provider markers even when the generic marker is disabled", () => {
    expect(isCi({ CI: "false", GITHUB_ACTIONS: "true" })).toBe(true);
  });
});

describe("getCiCheckout", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  test("reads GitHub Actions", () => {
    expect(
      getCiCheckout({ GITHUB_REPOSITORY: "getsentry/cli", GITHUB_SHA: sha }),
    ).toEqual({
      repository: "getsentry/cli",
      commit: sha,
      source: "GITHUB_REPOSITORY/GITHUB_SHA",
    });
  });

  test("joins Vercel's owner and slug in production builds", () => {
    const vercel = {
      VERCEL_GIT_REPO_OWNER: "acme",
      VERCEL_GIT_REPO_SLUG: "web",
      VERCEL_GIT_COMMIT_SHA: sha,
    };
    expect(
      getCiCheckout({ ...vercel, VERCEL_TARGET_ENV: "production" }),
    ).toMatchObject({ repository: "acme/web", commit: sha });
    // Preview builds are skipped, matching @sentry/bundler-plugins.
    expect(
      getCiCheckout({ ...vercel, VERCEL_TARGET_ENV: "preview" }),
    ).toBeUndefined();
  });

  test("keeps GitLab subgroups", () => {
    expect(
      getCiCheckout({
        CI_PROJECT_PATH: "acme/web/storefront",
        CI_COMMIT_SHA: sha,
      }),
    ).toMatchObject({ repository: "acme/web/storefront" });
  });

  test("parses repository URLs", () => {
    expect(
      getCiCheckout({
        NETLIFY: "true",
        REPOSITORY_URL: "https://github.com/acme/site",
        COMMIT_REF: sha,
      }),
    ).toMatchObject({ repository: "acme/site" });
    expect(
      getCiCheckout({
        BUILDKITE_REPO: "git@github.com:acme/api.git",
        BUILDKITE_COMMIT: sha,
      }),
    ).toMatchObject({ repository: "acme/api" });
  });

  test("ignores Netlify variables outside Netlify", () => {
    expect(
      getCiCheckout({
        REPOSITORY_URL: "https://github.com/acme/site",
        COMMIT_REF: sha,
      }),
    ).toBeUndefined();
  });

  test("skips values that are not a commit SHA", () => {
    expect(
      getCiCheckout({ GITHUB_REPOSITORY: "acme/web", GITHUB_SHA: "HEAD" }),
    ).toBeUndefined();
    expect(
      getCiCheckout({ CI_PROJECT_PATH: "acme/web", CI_COMMIT_SHA: "" }),
    ).toBeUndefined();
  });

  test("undefined without CI variables", () => {
    expect(getCiCheckout({})).toBeUndefined();
  });
});
