/**
 * Unit tests for env-token-host snapshot capture.
 *
 * Asserts:
 * - Snapshot reads env-only (not .sentryclirc-injected values later).
 * - Default is `DEFAULT_SENTRY_URL` when env is unset.
 * - `captureEnvTokenHost` is idempotent.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_SENTRY_URL } from "../../src/lib/constants.js";
import {
  captureEnvTokenHost,
  getEnvTokenHost,
  resetEnvTokenHostForTesting,
} from "../../src/lib/env-token-host.js";
import { mintSntrysToken, useEnvSandbox } from "../helpers.js";

const ENV_KEYS = [
  "SENTRY_HOST",
  "SENTRY_URL",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
] as const;

describe("env-token-host", () => {
  useEnvSandbox(ENV_KEYS);
  beforeEach(resetEnvTokenHostForTesting);
  afterEach(resetEnvTokenHostForTesting);

  test("keeps the claim's host authoritative for a token wrapped in controls", () => {
    const token = mintSntrysToken({
      iat: 1,
      url: "https://self-hosted.example.com",
      org: "synthetic-org",
    });
    process.env.SENTRY_AUTH_TOKEN = `\x01\u00a0${token}\x7f`;
    process.env.SENTRY_HOST = "https://different.example.com";
    captureEnvTokenHost();
    expect(getEnvTokenHost()).toBe("https://self-hosted.example.com");
  });

  test("defaults to SaaS when neither SENTRY_HOST nor SENTRY_URL is set", () => {
    captureEnvTokenHost();
    expect(getEnvTokenHost()).toBe(DEFAULT_SENTRY_URL);
  });

  test("captures SENTRY_HOST when set", () => {
    process.env.SENTRY_HOST = "https://sentry.acme.com";
    captureEnvTokenHost();
    expect(getEnvTokenHost()).toBe("https://sentry.acme.com");
  });

  test("captures SENTRY_URL when SENTRY_HOST is unset", () => {
    process.env.SENTRY_URL = "https://sentry.acme.com";
    captureEnvTokenHost();
    expect(getEnvTokenHost()).toBe("https://sentry.acme.com");
  });

  test("prefers SENTRY_HOST over SENTRY_URL when both are set", () => {
    process.env.SENTRY_HOST = "https://host.example.com";
    process.env.SENTRY_URL = "https://url.example.com";
    captureEnvTokenHost();
    expect(getEnvTokenHost()).toBe("https://host.example.com");
  });

  test("normalizes bare hostname to https://", () => {
    process.env.SENTRY_HOST = "sentry.acme.com";
    captureEnvTokenHost();
    expect(getEnvTokenHost()).toBe("https://sentry.acme.com");
  });

  test("is idempotent — second capture is a no-op", () => {
    process.env.SENTRY_HOST = "https://first.example.com";
    captureEnvTokenHost();
    expect(getEnvTokenHost()).toBe("https://first.example.com");

    // Change env AFTER initial capture — snapshot should NOT update
    process.env.SENTRY_HOST = "https://second.example.com";
    captureEnvTokenHost();
    expect(getEnvTokenHost()).toBe("https://first.example.com");
  });

  test("does NOT consult values added to env after capture (the .sentryclirc simulation)", () => {
    // Simulates: captureEnvTokenHost() at boot, then
    // applySentryCliRcEnvShim() writes SENTRY_URL. The env-token-host
    // snapshot must NOT reflect the shim write.
    captureEnvTokenHost();
    expect(getEnvTokenHost()).toBe(DEFAULT_SENTRY_URL);

    // Simulate shim write
    process.env.SENTRY_URL = "https://injected-by-sentryclirc.com";
    // Second call is a no-op (idempotent)
    captureEnvTokenHost();
    expect(getEnvTokenHost()).toBe(DEFAULT_SENTRY_URL);
  });

  test("auto-captures on first getEnvTokenHost() call without explicit capture", () => {
    process.env.SENTRY_HOST = "https://auto.example.com";
    // Never call captureEnvTokenHost explicitly
    expect(getEnvTokenHost()).toBe("https://auto.example.com");
  });
});
