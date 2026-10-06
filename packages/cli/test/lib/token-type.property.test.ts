/**
 * Property-Based Tests for Sentry Token Classification
 *
 * Uses fast-check to verify classifySentryToken's prefix matching is
 * correct across arbitrary suffixes and prefix variations.
 */

import { assert as fcAssert, property, string } from "fast-check";
import { describe, expect, test } from "vitest";
import { classifySentryToken } from "../../src/lib/token-type.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

describe("classifySentryToken", () => {
  describe("org-auth-token", () => {
    test("any string starting with sntrys_ classifies as org-auth-token", () => {
      fcAssert(
        property(string(), (suffix) => {
          expect(classifySentryToken(`sntrys_${suffix}`)).toBe(
            "org-auth-token"
          );
        }),
        { numRuns: DEFAULT_NUM_RUNS }
      );
    });

    test("bare sntrys_ prefix classifies as org-auth-token", () => {
      expect(classifySentryToken("sntrys_")).toBe("org-auth-token");
    });
  });

  describe("user-auth-token", () => {
    test("any string starting with sntryu_ classifies as user-auth-token", () => {
      fcAssert(
        property(string(), (suffix) => {
          expect(classifySentryToken(`sntryu_${suffix}`)).toBe(
            "user-auth-token"
          );
        }),
        { numRuns: DEFAULT_NUM_RUNS }
      );
    });

    test("bare sntryu_ prefix classifies as user-auth-token", () => {
      expect(classifySentryToken("sntryu_")).toBe("user-auth-token");
    });
  });

  describe("oauth-or-legacy", () => {
    test("strings without the sntry prefix classify as oauth-or-legacy", () => {
      // Reject anything that could happen to start with sntrys_ or sntryu_.
      // "sntry" alone is fine — the underscore + discriminator is what matters.
      fcAssert(
        property(string(), (value) => {
          if (value.startsWith("sntrys_") || value.startsWith("sntryu_")) {
            return;
          }
          expect(classifySentryToken(value)).toBe("oauth-or-legacy");
        }),
        { numRuns: DEFAULT_NUM_RUNS }
      );
    });

    test("empty string classifies as oauth-or-legacy", () => {
      expect(classifySentryToken("")).toBe("oauth-or-legacy");
    });

    test("typical OAuth access token shape classifies as oauth-or-legacy", () => {
      // OAuth access tokens are long hex / base64-ish strings without
      // the sntrys_/sntryu_ prefix.
      expect(
        classifySentryToken(
          "17faa5dfa5e64d5a9b3e8bf7c4d5e6f7a8b9c0d1e2f3a4b567ee"
        )
      ).toBe("oauth-or-legacy");
    });
  });

  describe("case sensitivity", () => {
    test("uppercase SNTRYS_ is not matched (prefix is literal lowercase)", () => {
      // Sentry server emits only lowercase prefixes. An uppercase variant
      // would indicate either user error or a non-Sentry token, and must
      // not be treated as an org token (which triggers whoami short-circuit).
      expect(classifySentryToken("SNTRYS_abc")).toBe("oauth-or-legacy");
      expect(classifySentryToken("SNTRYU_abc")).toBe("oauth-or-legacy");
      expect(classifySentryToken("Sntrys_abc")).toBe("oauth-or-legacy");
    });
  });

  describe("boundary cases", () => {
    test("prefix without trailing underscore does not match", () => {
      // `sntrys` and `sntryu` without `_` are not valid Sentry token prefixes.
      expect(classifySentryToken("sntrys")).toBe("oauth-or-legacy");
      expect(classifySentryToken("sntryu")).toBe("oauth-or-legacy");
      expect(classifySentryToken("sntrysabc")).toBe("oauth-or-legacy");
      expect(classifySentryToken("sntryuabc")).toBe("oauth-or-legacy");
    });

    test("prefix appearing mid-string does not match", () => {
      expect(classifySentryToken("xsntrys_abc")).toBe("oauth-or-legacy");
      expect(classifySentryToken("abc_sntryu_def")).toBe("oauth-or-legacy");
    });
  });
});
