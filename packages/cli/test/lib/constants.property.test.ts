/**
 * Property-based tests for normalizeUrl.
 *
 * Core invariant: the return value of normalizeUrl is always either
 * undefined (empty input) or a string starting with http:// or https://.
 * This prevents the "Invalid URL" TypeError when constructing API requests.
 */

import {
  array,
  constantFrom,
  assert as fcAssert,
  oneof,
  property,
  string,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { normalizeUrl } from "../../src/lib/constants.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

/**
 * Arbitrary for realistic hostname-like strings without protocol.
 * Labels are 2+ alphanumeric chars (no leading/trailing dashes), separated by dots.
 */
const hostnameArb = array(
  array(constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")), {
    minLength: 2,
    maxLength: 12,
  }).map((chars) => chars.join("")),
  { minLength: 2, maxLength: 4 }
).map((labels) => labels.join("."));

/** Arbitrary for strings that already have a protocol */
const withProtocolArb = oneof(
  hostnameArb.map((h) => `https://${h}`),
  hostnameArb.map((h) => `http://${h}`)
);

/** Arbitrary for any input (bare hostname, with protocol, empty, whitespace) */
const anyInputArb = oneof(
  hostnameArb,
  withProtocolArb,
  constantFrom("", " ", "  \t\n"),
  string({ minLength: 0, maxLength: 5 })
);

describe("property: normalizeUrl", () => {
  test("result always has protocol or is undefined", () => {
    fcAssert(
      property(anyInputArb, (input) => {
        const result = normalizeUrl(input);
        if (result === undefined) {
          return;
        }
        expect(
          result.startsWith("https://") || result.startsWith("http://")
        ).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("bare hostnames get https:// prepended", () => {
    fcAssert(
      property(hostnameArb, (hostname) => {
        const result = normalizeUrl(hostname);
        expect(result).toBe(`https://${hostname}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("URLs with protocol are returned unchanged", () => {
    fcAssert(
      property(withProtocolArb, (url) => {
        const result = normalizeUrl(url);
        expect(result).toBe(url);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("idempotent: normalizeUrl(normalizeUrl(x)) === normalizeUrl(x)", () => {
    fcAssert(
      property(anyInputArb, (input) => {
        const once = normalizeUrl(input);
        const twice = normalizeUrl(once);
        expect(twice).toBe(once);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("result always starts with https:// for bare hostnames", () => {
    fcAssert(
      property(hostnameArb, (hostname) => {
        const result = normalizeUrl(hostname);
        expect(result).toBeDefined();
        // normalizeUrl guarantees a protocol prefix — downstream URL
        // construction (`${baseUrl}/api/0/...`) produces a valid URL
        // when baseUrl has a protocol. We don't validate the hostname
        // itself (e.g., numeric TLDs like `aa.52` are unlikely but
        // harmless — the HTTP request will simply fail with a DNS error).
        expect(result).toStartWith("https://");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
