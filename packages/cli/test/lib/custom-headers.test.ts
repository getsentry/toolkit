/**
 * Unit Tests for Custom Headers
 *
 * Tests parseCustomHeaders() parsing, getCustomHeaders() env/DB integration,
 * and applyCustomHeaders() header injection.
 *
 * Note: Core round-trip and invariant properties are tested via property-based
 * tests in custom-headers.property.test.ts. These tests focus on edge cases,
 * error messages, and integration behavior not covered by property generators.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  _resetCustomHeadersCache,
  applyCustomHeaders,
  getCustomHeaders,
  parseCustomHeaders,
  setCustomHeadersOverride,
} from "../../src/lib/custom-headers.js";
import { setDefaultHeaders } from "../../src/lib/db/defaults.js";
import { useTestConfigDir } from "../helpers.js";

// ---------------------------------------------------------------------------
// parseCustomHeaders — parsing logic
// ---------------------------------------------------------------------------

describe("parseCustomHeaders", () => {
  test("parses single header", () => {
    const result = parseCustomHeaders("X-Custom: value");
    expect(result).toEqual([["X-Custom", "value"]]);
  });

  test("parses multiple headers separated by semicolon", () => {
    const result = parseCustomHeaders(
      "X-First: one; X-Second: two; X-Third: three"
    );
    expect(result).toEqual([
      ["X-First", "one"],
      ["X-Second", "two"],
      ["X-Third", "three"],
    ]);
  });

  test("parses multiple headers separated by newline", () => {
    const result = parseCustomHeaders("X-First: one\nX-Second: two");
    expect(result).toEqual([
      ["X-First", "one"],
      ["X-Second", "two"],
    ]);
  });

  test("parses mixed semicolon and newline separators", () => {
    const result = parseCustomHeaders(
      "X-First: one; X-Second: two\nX-Third: three"
    );
    expect(result).toEqual([
      ["X-First", "one"],
      ["X-Second", "two"],
      ["X-Third", "three"],
    ]);
  });

  test("handles value containing colons", () => {
    const result = parseCustomHeaders("X-Token: abc:def:ghi");
    expect(result).toEqual([["X-Token", "abc:def:ghi"]]);
  });

  test("trims whitespace from name and value", () => {
    const result = parseCustomHeaders("  X-Custom  :  some value  ");
    expect(result).toEqual([["X-Custom", "some value"]]);
  });

  test("skips empty segments", () => {
    const result = parseCustomHeaders("X-First: one;; ;X-Second: two");
    expect(result).toEqual([
      ["X-First", "one"],
      ["X-Second", "two"],
    ]);
  });

  test("handles Windows line endings (\\r\\n)", () => {
    const result = parseCustomHeaders("X-First: one\r\nX-Second: two");
    expect(result).toEqual([
      ["X-First", "one"],
      ["X-Second", "two"],
    ]);
  });

  test("returns empty array for empty string", () => {
    expect(parseCustomHeaders("")).toEqual([]);
  });

  test("returns empty array for whitespace-only string", () => {
    expect(parseCustomHeaders("   \n  ;  ")).toEqual([]);
  });

  test("allows header value to be empty", () => {
    const result = parseCustomHeaders("X-Empty:");
    expect(result).toEqual([["X-Empty", ""]]);
  });

  // Error cases

  test("throws ConfigError on segment without colon", () => {
    expect(() => parseCustomHeaders("bad-header-no-colon")).toThrow(
      /Expected 'Name: Value' format/
    );
  });

  test("throws ConfigError on empty header name", () => {
    expect(() => parseCustomHeaders(": value-only")).toThrow(
      /empty header name/
    );
  });

  test("throws ConfigError on header name with spaces", () => {
    expect(() => parseCustomHeaders("Bad Name: value")).toThrow(
      /Header names must contain only/
    );
  });

  // Forbidden headers
  const forbiddenHeaders = [
    "Authorization",
    "Host",
    "Content-Type",
    "Content-Length",
    "User-Agent",
    "sentry-trace",
    "baggage",
  ];

  for (const header of forbiddenHeaders) {
    test(`throws ConfigError for forbidden header: ${header}`, () => {
      expect(() => parseCustomHeaders(`${header}: some-value`)).toThrow(
        /Cannot override reserved header/
      );
    });
  }

  test("forbidden header check is case-insensitive", () => {
    expect(() => parseCustomHeaders("AUTHORIZATION: token")).toThrow(
      /Cannot override reserved header/
    );
    expect(() => parseCustomHeaders("content-type: json")).toThrow(
      /Cannot override reserved header/
    );
  });
});

// ---------------------------------------------------------------------------
// getCustomHeaders — env var and DB integration
// ---------------------------------------------------------------------------

describe("getCustomHeaders", () => {
  useTestConfigDir("custom-headers-test-", { isolateProjectRoot: true });

  let savedHeaders: string | undefined;
  let savedHost: string | undefined;
  let savedUrl: string | undefined;

  beforeEach(() => {
    savedHeaders = process.env.SENTRY_CUSTOM_HEADERS;
    savedHost = process.env.SENTRY_HOST;
    savedUrl = process.env.SENTRY_URL;
    delete process.env.SENTRY_CUSTOM_HEADERS;
    delete process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;
    _resetCustomHeadersCache();
  });

  afterEach(() => {
    if (savedHeaders !== undefined) {
      process.env.SENTRY_CUSTOM_HEADERS = savedHeaders;
    } else {
      delete process.env.SENTRY_CUSTOM_HEADERS;
    }
    if (savedHost !== undefined) {
      process.env.SENTRY_HOST = savedHost;
    } else {
      delete process.env.SENTRY_HOST;
    }
    if (savedUrl !== undefined) {
      process.env.SENTRY_URL = savedUrl;
    } else {
      delete process.env.SENTRY_URL;
    }
    _resetCustomHeadersCache();
  });

  test("returns empty array when no env var or defaults set", () => {
    expect(getCustomHeaders()).toEqual([]);
  });

  test("returns empty array when headers set but no SENTRY_HOST (SaaS mode)", () => {
    process.env.SENTRY_CUSTOM_HEADERS = "X-Test: value";
    expect(getCustomHeaders()).toEqual([]);
  });

  test("returns empty array when SENTRY_HOST is sentry.io", () => {
    process.env.SENTRY_CUSTOM_HEADERS = "X-Test: value";
    process.env.SENTRY_HOST = "sentry.io";
    expect(getCustomHeaders()).toEqual([]);
  });

  test("returns empty array when SENTRY_HOST is subdomain of sentry.io", () => {
    process.env.SENTRY_CUSTOM_HEADERS = "X-Test: value";
    process.env.SENTRY_HOST = "us.sentry.io";
    expect(getCustomHeaders()).toEqual([]);
  });

  test("returns parsed headers when SENTRY_HOST is self-hosted", () => {
    process.env.SENTRY_CUSTOM_HEADERS = "X-IAP-Token: abc123";
    process.env.SENTRY_HOST = "https://sentry.example.com";
    expect(getCustomHeaders()).toEqual([["X-IAP-Token", "abc123"]]);
  });

  test("returns parsed headers when SENTRY_URL is self-hosted", () => {
    process.env.SENTRY_CUSTOM_HEADERS = "X-IAP-Token: abc123";
    process.env.SENTRY_URL = "https://sentry.example.com";
    expect(getCustomHeaders()).toEqual([["X-IAP-Token", "abc123"]]);
  });

  test("env var takes priority over SQLite defaults", () => {
    process.env.SENTRY_HOST = "https://sentry.example.com";
    process.env.SENTRY_CUSTOM_HEADERS = "X-Env: from-env";
    setDefaultHeaders("X-Db: from-db");
    expect(getCustomHeaders()).toEqual([["X-Env", "from-env"]]);
  });

  test("falls back to SQLite defaults when env var not set", () => {
    process.env.SENTRY_HOST = "https://sentry.example.com";
    setDefaultHeaders("X-Db: from-db");
    expect(getCustomHeaders()).toEqual([["X-Db", "from-db"]]);
  });

  test("caches parsed result across calls", () => {
    process.env.SENTRY_CUSTOM_HEADERS = "X-Cache: test";
    process.env.SENTRY_HOST = "https://sentry.example.com";
    const first = getCustomHeaders();
    const second = getCustomHeaders();
    // Same reference (cached)
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// setCustomHeadersOverride — structured headers from SentryOptions.headers
// ---------------------------------------------------------------------------

describe("setCustomHeadersOverride", () => {
  useTestConfigDir("custom-headers-override-test-", {
    isolateProjectRoot: true,
  });

  let savedHeaders: string | undefined;
  let savedHost: string | undefined;

  beforeEach(() => {
    savedHeaders = process.env.SENTRY_CUSTOM_HEADERS;
    savedHost = process.env.SENTRY_HOST;
    delete process.env.SENTRY_CUSTOM_HEADERS;
    process.env.SENTRY_HOST = "https://sentry.example.com";
    _resetCustomHeadersCache();
  });

  afterEach(() => {
    if (savedHeaders !== undefined) {
      process.env.SENTRY_CUSTOM_HEADERS = savedHeaders;
    } else {
      delete process.env.SENTRY_CUSTOM_HEADERS;
    }
    if (savedHost !== undefined) {
      process.env.SENTRY_HOST = savedHost;
    } else {
      delete process.env.SENTRY_HOST;
    }
    _resetCustomHeadersCache();
  });

  test("returns the structured headers without a string round-trip", () => {
    setCustomHeadersOverride({
      "X-IAP-Token": "abc123",
      "X-Url": "https://example.com/a;b",
    });
    expect(getCustomHeaders()).toEqual([
      ["X-IAP-Token", "abc123"],
      ["X-Url", "https://example.com/a;b"],
    ]);
  });

  test("takes precedence over SENTRY_CUSTOM_HEADERS", () => {
    process.env.SENTRY_CUSTOM_HEADERS = "X-Env: from-env";
    setCustomHeadersOverride({ "X-Option": "from-option" });
    expect(getCustomHeaders()).toEqual([["X-Option", "from-option"]]);
  });

  test("an empty map disables inherited env headers", () => {
    process.env.SENTRY_CUSTOM_HEADERS = "X-Env: from-env";
    setCustomHeadersOverride({});
    expect(getCustomHeaders()).toEqual([]);
  });

  test("clearing falls back to SENTRY_CUSTOM_HEADERS", () => {
    process.env.SENTRY_CUSTOM_HEADERS = "X-Env: from-env";
    setCustomHeadersOverride({ "X-Option": "from-option" });
    setCustomHeadersOverride(undefined);
    expect(getCustomHeaders()).toEqual([["X-Env", "from-env"]]);
  });

  test("is ignored when targeting SaaS", () => {
    delete process.env.SENTRY_HOST;
    setCustomHeadersOverride({ "X-IAP-Token": "abc123" });
    expect(getCustomHeaders()).toEqual([]);
  });

  test("trims names and values", () => {
    setCustomHeadersOverride({ " X-Trim ": "  value  " });
    expect(getCustomHeaders()).toEqual([["X-Trim", "value"]]);
  });

  test("throws ConfigError on empty header name", () => {
    expect(() => setCustomHeadersOverride({ "  ": "value" })).toThrow(
      "empty header name"
    );
  });

  test("throws ConfigError on invalid header name", () => {
    expect(() => setCustomHeadersOverride({ "X Bad": "value" })).toThrow(
      "Invalid header name 'X Bad' in SentryOptions.headers"
    );
  });

  test("throws ConfigError on reserved header name", () => {
    expect(() => setCustomHeadersOverride({ Authorization: "x" })).toThrow(
      "Cannot override reserved header 'Authorization' in SentryOptions.headers"
    );
  });
});

// ---------------------------------------------------------------------------
// applyCustomHeaders — header injection
// ---------------------------------------------------------------------------

describe("applyCustomHeaders", () => {
  let savedHeaders: string | undefined;
  let savedHost: string | undefined;

  beforeEach(async () => {
    savedHeaders = process.env.SENTRY_CUSTOM_HEADERS;
    savedHost = process.env.SENTRY_HOST;
    _resetCustomHeadersCache();
    const { resetEnvTokenHostForTesting } = await import(
      "../../src/lib/env-token-host.js"
    );
    resetEnvTokenHostForTesting();
  });

  afterEach(async () => {
    if (savedHeaders !== undefined) {
      process.env.SENTRY_CUSTOM_HEADERS = savedHeaders;
    } else {
      delete process.env.SENTRY_CUSTOM_HEADERS;
    }
    if (savedHost !== undefined) {
      process.env.SENTRY_HOST = savedHost;
    } else {
      delete process.env.SENTRY_HOST;
    }
    _resetCustomHeadersCache();
    const { resetEnvTokenHostForTesting } = await import(
      "../../src/lib/env-token-host.js"
    );
    resetEnvTokenHostForTesting();
  });

  test("applies custom headers to Headers instance when request host matches", () => {
    process.env.SENTRY_CUSTOM_HEADERS = "X-Test: hello; X-Other: world";
    // Pin env-token scope to the self-hosted instance so headers apply.
    process.env.SENTRY_HOST = "https://sentry.example.com";

    const headers = new Headers({ Accept: "application/json" });
    applyCustomHeaders(
      headers,
      "https://sentry.example.com/api/0/organizations/"
    );

    expect(headers.get("X-Test")).toBe("hello");
    expect(headers.get("X-Other")).toBe("world");
  });

  test("does not clobber unrelated existing headers", () => {
    process.env.SENTRY_CUSTOM_HEADERS = "X-Test: hello";
    process.env.SENTRY_HOST = "https://sentry.example.com";

    const headers = new Headers({ Accept: "application/json" });
    applyCustomHeaders(
      headers,
      "https://sentry.example.com/api/0/organizations/"
    );

    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("X-Test")).toBe("hello");
  });

  test("no-op when no custom headers configured", () => {
    delete process.env.SENTRY_CUSTOM_HEADERS;
    delete process.env.SENTRY_HOST;

    const headers = new Headers({ Accept: "application/json" });
    applyCustomHeaders(headers, "https://sentry.io/api/0/");

    // Only the original header
    const keys = [...headers.keys()];
    expect(keys).toEqual(["accept"]);
  });

  test("skips custom headers when request URL host does not match trusted host (CVE defense)", () => {
    // Self-hosted user has IAP token configured for their proxy:
    process.env.SENTRY_CUSTOM_HEADERS = "X-IAP-Token: secret";
    process.env.SENTRY_HOST = "https://sentry.example.com";

    // A share URL from an attacker resolves to evil.example.com. Even though
    // applyCustomHeaders is on a non-SaaS codepath (isSelfHosted()==true for
    // this host-config), the request's destination is the untrusted URL, so
    // the IAP token must NOT attach.
    const headers = new Headers({ Accept: "application/json" });
    applyCustomHeaders(
      headers,
      "https://evil.example.com/api/0/shared/issues/deadbeef/"
    );

    expect(headers.get("X-IAP-Token")).toBeNull();
  });
});
