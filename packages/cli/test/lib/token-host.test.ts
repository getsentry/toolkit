/**
 * Unit tests for token-host: normalizeOrigin + isHostTrusted.
 *
 * Core invariants (SaaS equivalence, subdomain-attack resistance, port
 * sensitivity) are also covered by test/lib/token-host.property.test.ts.
 * This file focuses on the specific cases that property generators don't
 * cover well (exact edge strings, malformed inputs).
 */

import { describe, expect, test } from "vitest";
import { normalizeOrigin } from "../../src/lib/sentry-urls.js";
import { isHostTrusted } from "../../src/lib/token-host.js";

describe("normalizeOrigin", () => {
  test("returns origin for a valid https URL", () => {
    expect(normalizeOrigin("https://sentry.io/api/0/")).toBe(
      "https://sentry.io"
    );
  });

  test("lowercases the host", () => {
    expect(normalizeOrigin("https://SeNtRy.Io/path")).toBe("https://sentry.io");
  });

  test("preserves explicit non-default port", () => {
    expect(normalizeOrigin("https://sentry.acme.com:9000/api/")).toBe(
      "https://sentry.acme.com:9000"
    );
  });

  test("strips default port :443 for https", () => {
    expect(normalizeOrigin("https://sentry.io:443/api/")).toBe(
      "https://sentry.io"
    );
  });

  test("strips default port :80 for http", () => {
    expect(normalizeOrigin("http://sentry.io:80/api/")).toBe(
      "http://sentry.io"
    );
  });

  test("returns undefined for malformed input", () => {
    expect(normalizeOrigin("not a url")).toBeUndefined();
    expect(normalizeOrigin("")).toBeUndefined();
  });

  test("returns undefined for null and undefined", () => {
    expect(normalizeOrigin(null)).toBeUndefined();
    expect(normalizeOrigin(undefined)).toBeUndefined();
  });

  test("accepts URL instances", () => {
    expect(normalizeOrigin(new URL("https://sentry.io/path"))).toBe(
      "https://sentry.io"
    );
  });

  test("accepts Request instances", () => {
    expect(normalizeOrigin(new Request("https://sentry.io/path"))).toBe(
      "https://sentry.io"
    );
  });
});

describe("isHostTrusted", () => {
  test("exact origin match", () => {
    expect(
      isHostTrusted(
        "https://sentry.example.com/api/",
        "https://sentry.example.com"
      )
    ).toBe(true);
  });

  test("scheme mismatch fails", () => {
    expect(
      isHostTrusted("http://sentry.example.com/", "https://sentry.example.com")
    ).toBe(false);
  });

  test("port mismatch fails", () => {
    expect(
      isHostTrusted(
        "https://sentry.acme.com:9000/",
        "https://sentry.acme.com:9001"
      )
    ).toBe(false);
  });

  test("port-vs-default mismatch fails", () => {
    // :9000 explicit does not match default :443
    expect(
      isHostTrusted("https://sentry.acme.com:9000/", "https://sentry.acme.com")
    ).toBe(false);
  });

  test("SaaS equivalence: sentry.io matches us.sentry.io", () => {
    expect(
      isHostTrusted("https://us.sentry.io/api/0/", "https://sentry.io")
    ).toBe(true);
  });

  test("SaaS equivalence: sentry.io matches de.sentry.io", () => {
    expect(
      isHostTrusted("https://de.sentry.io/api/0/", "https://sentry.io")
    ).toBe(true);
  });

  test("SaaS equivalence: sentry.io matches org subdomain", () => {
    expect(
      isHostTrusted("https://my-org.sentry.io/issues/", "https://sentry.io")
    ).toBe(true);
  });

  test("SaaS equivalence: us.sentry.io token matches other SaaS subdomains", () => {
    // Tokens scoped to a regional silo are still part of the SaaS trust class.
    expect(isHostTrusted("https://de.sentry.io/", "https://us.sentry.io")).toBe(
      true
    );
  });

  test("non-SaaS: no subdomain suffix attack", () => {
    // sentry.acme.com token must NOT trust sentry.acme.evil.com
    expect(
      isHostTrusted("https://sentry.acme.evil.com/", "https://sentry.acme.com")
    ).toBe(false);
  });

  test("non-SaaS: no prefix-attack", () => {
    expect(
      isHostTrusted("https://evil-sentry.acme.com/", "https://sentry.acme.com")
    ).toBe(false);
  });

  test("non-SaaS token does not trust SaaS host", () => {
    expect(isHostTrusted("https://sentry.io/", "https://sentry.acme.com")).toBe(
      false
    );
  });

  test("SaaS token does not trust non-SaaS host", () => {
    expect(isHostTrusted("https://sentry.acme.com/", "https://sentry.io")).toBe(
      false
    );
  });

  test("look-alike: sentry.io.evil.com is NOT SaaS", () => {
    expect(
      isHostTrusted("https://sentry.io.evil.com/", "https://sentry.io")
    ).toBe(false);
  });

  test("undefined trusted host is not trusted", () => {
    expect(isHostTrusted("https://sentry.io", undefined)).toBe(false);
  });

  test("null trusted host is not trusted", () => {
    expect(isHostTrusted("https://sentry.io", null)).toBe(false);
  });

  test("unparseable candidate is not trusted", () => {
    expect(isHostTrusted("not a url", "https://sentry.io")).toBe(false);
  });

  test("SaaS equivalence refuses non-default port on sentry.io (hardened)", () => {
    // Trust-scoped SaaS requires scheme=https AND port=default. A URL with
    // a non-default port on `sentry.io` (e.g. sentry.io:8443) might look
    // SaaS-ish by hostname but is never legitimate production SaaS and
    // must not inherit SaaS trust — otherwise a crafted URL could bypass
    // the URL-arg guard by using a port-prefixed sentry.io hostname.
    expect(isHostTrusted("https://sentry.io:8443/", "https://sentry.io")).toBe(
      false
    );
  });

  test("SaaS equivalence refuses http:// scheme on sentry.io (hardened)", () => {
    // Plain HTTP is never legitimate production SaaS. A crafted URL
    // `http://sentry.io/...` must not inherit SaaS trust.
    expect(isHostTrusted("http://sentry.io/api/0/", "https://sentry.io")).toBe(
      false
    );
    expect(
      isHostTrusted("http://us.sentry.io/api/0/", "https://sentry.io")
    ).toBe(false);
  });
});
