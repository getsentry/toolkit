import { describe, expect, it } from "vitest";

import { getCIEnvVars } from "../../../../src/lib/wizard/sourcemaps/ci.js";

describe("getCIEnvVars", () => {
  it("lists only the auth token without an upload target", () => {
    expect(getCIEnvVars("tok", undefined)).toEqual(["SENTRY_AUTH_TOKEN=tok"]);
  });

  it("adds the org and project for sentry.io", () => {
    expect(
      getCIEnvVars("tok", { org: "my-org", project: "my-project" }),
    ).toEqual([
      "SENTRY_AUTH_TOKEN=tok",
      "SENTRY_ORG=my-org",
      "SENTRY_PROJECT=my-project",
    ]);
  });

  it("adds SENTRY_URL for self-hosted Sentry", () => {
    expect(
      getCIEnvVars("tok", {
        org: "my-org",
        project: "my-project",
        url: "https://sentry.example.com/",
      }),
    ).toEqual([
      "SENTRY_AUTH_TOKEN=tok",
      "SENTRY_ORG=my-org",
      "SENTRY_PROJECT=my-project",
      "SENTRY_URL=https://sentry.example.com/",
    ]);
  });
});
