import { beforeEach, describe, expect, test } from "vitest";
import { setAuthToken } from "../../src/lib/db/auth.js";
import { resetEnvTokenHostForTesting } from "../../src/lib/env-token-host.js";
import {
  buildOrgUrl,
  buildProjectUrl,
  getSentryBaseUrl,
  isSaaS,
} from "../../src/lib/sentry-web-urls.js";
import {
  mintSntrysToken,
  useEnvSandbox,
  useTestConfigDir,
} from "../helpers.js";

describe("web URLs for active credential hosts", () => {
  useTestConfigDir("web-urls-credential-");
  useEnvSandbox([
    "SENTRY_AUTH_TOKEN",
    "SENTRY_TOKEN",
    "SENTRY_FORCE_ENV_TOKEN",
    "SENTRY_HOST",
    "SENTRY_URL",
  ]);

  beforeEach(() => {
    resetEnvTokenHostForTesting();
  });

  test("uses a self-hosted token claim for web links and URL shape", () => {
    process.env.SENTRY_AUTH_TOKEN = mintSntrysToken({
      iat: 1,
      url: "https://sentry.example.com",
    });
    expect(getSentryBaseUrl()).toBe("https://sentry.example.com");
    expect(isSaaS()).toBe(false);
    expect(buildOrgUrl("acme")).toBe(
      "https://sentry.example.com/organizations/acme/",
    );
    expect(buildProjectUrl("acme", "site")).toBe(
      "https://sentry.example.com/settings/acme/projects/site/",
    );
  });

  test("stored OAuth host wins over an inactive environment token", () => {
    process.env.SENTRY_AUTH_TOKEN = mintSntrysToken({
      iat: 1,
      url: "https://inactive.example.com",
    });
    setAuthToken("stored-access", 3600, "stored-refresh", {
      host: "https://stored.example.com",
    });
    expect(getSentryBaseUrl()).toBe("https://stored.example.com");
  });

  test("explicit URLs still take priority for web links", () => {
    process.env.SENTRY_URL = "https://configured.example.com/sentry";
    process.env.SENTRY_AUTH_TOKEN = mintSntrysToken({
      iat: 1,
      url: "https://token.example.com",
    });
    expect(getSentryBaseUrl()).toBe("https://configured.example.com/sentry");
    expect(buildOrgUrl("acme")).toBe(
      "https://configured.example.com/sentry/organizations/acme/",
    );
  });
});
