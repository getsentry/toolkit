import { afterEach, beforeEach, expect, test } from "vitest";
import { completeOrgSlugs } from "../../src/lib/complete.js";
import { getCredentialContext, setAuthToken } from "../../src/lib/db/auth.js";
import { clearOrgRegions, setOrgRegions } from "../../src/lib/db/regions.js";
import { useEnvSandbox, useTestConfigDir } from "../helpers.js";

useTestConfigDir("complete-context-focused-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
]);

beforeEach(() => {
  for (const key of [
    "SENTRY_AUTH_TOKEN",
    "SENTRY_TOKEN",
    "SENTRY_FORCE_ENV_TOKEN",
    "SENTRY_HOST",
    "SENTRY_URL",
  ]) {
    delete process.env[key];
  }
  clearOrgRegions();
});
afterEach(() => {
  clearOrgRegions();
});

test("suggests only organizations of the active credential on the lookup origin", () => {
  setAuthToken("completion-token-a", undefined, undefined, {
    host: "https://control.example.com",
  });
  const identityA = getCredentialContext()?.identity;
  setAuthToken("completion-token-b", undefined, undefined, {
    host: "https://control.example.com",
  });
  const identityB = getCredentialContext()?.identity;
  if (!(identityA && identityB)) {
    throw new Error("Test requires stored credentials");
  }
  setOrgRegions([
    {
      slug: "org-a",
      regionUrl: "https://region-a.example.com",
      sourceOrigin: "https://control.example.com",
      cacheOrigin: "https://control.example.com",
      identity: identityA,
      orgId: "1",
      orgName: "Organization A",
    },
    {
      slug: "org-b",
      regionUrl: "https://region-b.example.com",
      sourceOrigin: "https://control.example.com",
      cacheOrigin: "https://control.example.com",
      identity: identityB,
      orgId: "2",
      orgName: "Organization B",
    },
  ]);
  setAuthToken("completion-token-a", undefined, undefined, {
    host: "https://control.example.com",
  });
  expect(completeOrgSlugs("").map((completion) => completion.value)).toEqual([
    "org-a",
  ]);
});
