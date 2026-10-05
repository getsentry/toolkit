/**
 * Tests for normalizeUrl and getConfiguredSentryUrl.
 *
 * The primary invariant — bare hostnames get `https://` prepended so that
 * downstream URL construction produces valid URLs — is tested via property-based
 * tests in constants.property.test.ts. These unit tests cover specific edge
 * cases and the env-var integration path.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getCliEnvironment,
  getConfiguredSentryUrl,
  normalizeUrl,
} from "../../src/lib/constants.js";

describe("normalizeUrl", () => {
  test("returns undefined for undefined", () => {
    expect(normalizeUrl(undefined)).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(normalizeUrl("")).toBeUndefined();
  });

  test("returns undefined for whitespace-only string", () => {
    expect(normalizeUrl("   ")).toBeUndefined();
  });

  test("prepends https:// to bare hostname", () => {
    expect(normalizeUrl("sentry.example.com")).toBe(
      "https://sentry.example.com"
    );
  });

  test("prepends https:// to bare sentry.io", () => {
    expect(normalizeUrl("sentry.io")).toBe("https://sentry.io");
  });

  test("prepends https:// to hostname with port", () => {
    expect(normalizeUrl("sentry.example.com:9000")).toBe(
      "https://sentry.example.com:9000"
    );
  });

  test("preserves https:// URLs", () => {
    expect(normalizeUrl("https://sentry.example.com")).toBe(
      "https://sentry.example.com"
    );
  });

  test("preserves http:// URLs", () => {
    expect(normalizeUrl("http://sentry.example.com")).toBe(
      "http://sentry.example.com"
    );
  });

  test("handles case-insensitive protocol", () => {
    expect(normalizeUrl("HTTPS://sentry.example.com")).toBe(
      "HTTPS://sentry.example.com"
    );
    expect(normalizeUrl("HTTP://sentry.example.com")).toBe(
      "HTTP://sentry.example.com"
    );
  });

  test("trims whitespace", () => {
    expect(normalizeUrl("  sentry.example.com  ")).toBe(
      "https://sentry.example.com"
    );
    expect(normalizeUrl("  https://sentry.example.com  ")).toBe(
      "https://sentry.example.com"
    );
  });

  test("preserves path and trailing slash", () => {
    expect(normalizeUrl("sentry.example.com/")).toBe(
      "https://sentry.example.com/"
    );
    expect(normalizeUrl("https://sentry.example.com/")).toBe(
      "https://sentry.example.com/"
    );
  });
});

describe("getCliEnvironment", () => {
  test("returns 'development' in dev mode (no build injection)", () => {
    // CLI_VERSION is "0.0.0-dev" when SENTRY_CLI_VERSION is not injected
    expect(getCliEnvironment()).toBe("development");
  });

  test("returns 'development' for '0.0.0-dev'", () => {
    expect(getCliEnvironment("0.0.0-dev")).toBe("development");
  });

  test("returns 'nightly' for nightly versions", () => {
    expect(getCliEnvironment("0.24.0-dev.1740000000")).toBe("nightly");
    expect(getCliEnvironment("1.0.0-dev.1700000000")).toBe("nightly");
  });

  test("returns 'production' for stable versions", () => {
    expect(getCliEnvironment("0.20.0")).toBe("production");
    expect(getCliEnvironment("1.0.0")).toBe("production");
    expect(getCliEnvironment("0.23.0")).toBe("production");
  });
});

describe("getConfiguredSentryUrl", () => {
  let originalHost: string | undefined;
  let originalUrl: string | undefined;

  beforeEach(() => {
    originalHost = process.env.SENTRY_HOST;
    originalUrl = process.env.SENTRY_URL;
  });

  afterEach(() => {
    // Restore original values (set or delete)
    if (originalHost !== undefined) {
      process.env.SENTRY_HOST = originalHost;
    } else {
      delete process.env.SENTRY_HOST;
    }
    if (originalUrl !== undefined) {
      process.env.SENTRY_URL = originalUrl;
    } else {
      delete process.env.SENTRY_URL;
    }
  });

  test("returns undefined when no env vars set", () => {
    delete process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;
    expect(getConfiguredSentryUrl()).toBeUndefined();
  });

  test("normalizes bare SENTRY_HOST", () => {
    process.env.SENTRY_HOST = "sentry.example.com";
    delete process.env.SENTRY_URL;
    expect(getConfiguredSentryUrl()).toBe("https://sentry.example.com");
  });

  test("normalizes bare SENTRY_URL", () => {
    delete process.env.SENTRY_HOST;
    process.env.SENTRY_URL = "sentry.example.com";
    expect(getConfiguredSentryUrl()).toBe("https://sentry.example.com");
  });

  test("SENTRY_HOST takes precedence over SENTRY_URL", () => {
    process.env.SENTRY_HOST = "host.example.com";
    process.env.SENTRY_URL = "url.example.com";
    expect(getConfiguredSentryUrl()).toBe("https://host.example.com");
  });

  test("preserves protocol when already present", () => {
    process.env.SENTRY_HOST = "https://sentry.example.com";
    expect(getConfiguredSentryUrl()).toBe("https://sentry.example.com");
  });

  test("preserves http:// for local development", () => {
    process.env.SENTRY_HOST = "http://localhost:8000";
    expect(getConfiguredSentryUrl()).toBe("http://localhost:8000");
  });
});
