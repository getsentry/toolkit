/**
 * Unit tests for `sntrys_` org-auth-token claim parsing.
 *
 * Mirrors the server's token format from
 * `getsentry/sentry/src/sentry/utils/security/orgauthtoken_token.py`:
 *
 *   sntrys_<base64(JSON{iat, url, region_url, org})>_<random-secret>
 *
 * The middle chunk is plaintext base64 (NOT base64url), and the trailing
 * chunk is opaque entropy. The CLI's parser must match the server's
 * `parse_token` semantics (strict prefix, exactly 2 underscores, valid
 * base64 → valid UTF-8 → valid JSON object → truthy `iat`).
 */

import { describe, expect, test } from "vitest";
import { parseSntrysClaim } from "../../src/lib/token-claims.js";
import { mintSntrysToken } from "../helpers.js";

describe("parseSntrysClaim", () => {
  test("extracts url + region_url from a well-formed token", () => {
    const token = mintSntrysToken({
      iat: 1_700_000_000,
      url: "https://sentry.acme.com",
      region_url: "https://us.sentry.acme.com",
      org: "acme",
    });
    expect(parseSntrysClaim(token)).toEqual({
      url: "https://sentry.acme.com",
      regionUrl: "https://us.sentry.acme.com",
      org: "acme",
    });
  });

  test("returns just url when region_url is absent", () => {
    const token = mintSntrysToken({
      iat: 1_700_000_000,
      url: "https://sentry.acme.com",
      org: "acme",
    });
    expect(parseSntrysClaim(token)).toEqual({
      url: "https://sentry.acme.com",
      regionUrl: undefined,
      org: "acme",
    });
  });

  test("returns undefined for non-sntrys_ tokens", () => {
    expect(parseSntrysClaim("sntryu_abcdef0123456789")).toBeUndefined();
    expect(parseSntrysClaim("sntrya_abcdef0123456789")).toBeUndefined();
    expect(parseSntrysClaim("sntryi_abcdef0123456789")).toBeUndefined();
    // OAuth-style opaque token
    expect(parseSntrysClaim("abc123def456")).toBeUndefined();
  });

  test("returns undefined for undefined/empty input", () => {
    expect(parseSntrysClaim(undefined)).toBeUndefined();
    expect(parseSntrysClaim("")).toBeUndefined();
  });

  test("returns undefined for tokens with wrong underscore count", () => {
    // 1 underscore (just the prefix)
    expect(parseSntrysClaim("sntrys_aGVsbG8=")).toBeUndefined();
    // 3 underscores
    expect(parseSntrysClaim("sntrys_test_token_extra")).toBeUndefined();
    // 0 underscores after prefix strip — caught by prefix check
    expect(parseSntrysClaim("sntrysno-underscore")).toBeUndefined();
  });

  test("returns undefined when payload chunk is not valid base64", () => {
    // `not_valid_base64` contains underscore which would actually break
    // the underscore count, so this is the format the test preload uses:
    expect(
      parseSntrysClaim("sntrys_test-token-for-unit-tests_000000")
    ).toBeUndefined();
    // Pure invalid base64 character set in middle (with right underscore count)
    expect(parseSntrysClaim("sntrys_!!!notbase64!!!_secret")).toBeUndefined();
  });

  test("returns undefined when payload is valid base64 but not JSON", () => {
    // base64 of "hello world" — valid base64 + valid UTF-8 but not JSON
    const b64 = Buffer.from("hello world", "utf8").toString("base64");
    expect(parseSntrysClaim(`sntrys_${b64}_secret`)).toBeUndefined();
  });

  test("returns undefined when JSON is valid but not an object", () => {
    const arr = Buffer.from("[1,2,3]", "utf8").toString("base64");
    const num = Buffer.from("42", "utf8").toString("base64");
    const str = Buffer.from('"hello"', "utf8").toString("base64");
    const nul = Buffer.from("null", "utf8").toString("base64");
    expect(parseSntrysClaim(`sntrys_${arr}_secret`)).toBeUndefined();
    expect(parseSntrysClaim(`sntrys_${num}_secret`)).toBeUndefined();
    expect(parseSntrysClaim(`sntrys_${str}_secret`)).toBeUndefined();
    expect(parseSntrysClaim(`sntrys_${nul}_secret`)).toBeUndefined();
  });

  test("returns undefined when payload has no iat field (matches server semantics)", () => {
    const token = mintSntrysToken({
      url: "https://sentry.acme.com",
      org: "acme",
      // no iat
    });
    expect(parseSntrysClaim(token)).toBeUndefined();
  });

  test("returns undefined when payload has falsy iat", () => {
    const token = mintSntrysToken({
      iat: 0,
      url: "https://sentry.acme.com",
      org: "acme",
    });
    expect(parseSntrysClaim(token)).toBeUndefined();
  });

  test("returns undefined when payload has no url field", () => {
    const token = mintSntrysToken({
      iat: 1_700_000_000,
      org: "acme",
      // no url
    });
    expect(parseSntrysClaim(token)).toBeUndefined();
  });

  test("returns undefined when url is not a string", () => {
    const token = mintSntrysToken({
      iat: 1_700_000_000,
      url: 12_345,
      org: "acme",
    });
    expect(parseSntrysClaim(token)).toBeUndefined();
  });

  test("returns undefined when url is empty string", () => {
    const token = mintSntrysToken({
      iat: 1_700_000_000,
      url: "",
      org: "acme",
    });
    expect(parseSntrysClaim(token)).toBeUndefined();
  });

  test("rejects oversized tokens without parsing (DoS protection)", () => {
    // 4 KB token — well over the 2 KB cap. Should not even attempt
    // base64/JSON parsing.
    const big = "a".repeat(4096);
    expect(parseSntrysClaim(`sntrys_${big}_x`)).toBeUndefined();
  });

  test("ignores non-string region_url (treats as absent)", () => {
    const token = mintSntrysToken({
      iat: 1_700_000_000,
      url: "https://sentry.io",
      region_url: 42,
      org: "x",
    });
    expect(parseSntrysClaim(token)?.regionUrl).toBeUndefined();
  });

  test("returns org as undefined when org field is missing from payload", () => {
    const token = mintSntrysToken({
      iat: 1_700_000_000,
      url: "https://sentry.io",
    });
    expect(parseSntrysClaim(token)?.org).toBeUndefined();
  });

  test("ignores non-string org (treats as absent)", () => {
    const token = mintSntrysToken({
      iat: 1_700_000_000,
      url: "https://sentry.io",
      org: 42,
    });
    expect(parseSntrysClaim(token)?.org).toBeUndefined();
  });

  test("ignores empty-string org (treats as absent)", () => {
    const token = mintSntrysToken({
      iat: 1_700_000_000,
      url: "https://sentry.io",
      org: "",
    });
    expect(parseSntrysClaim(token)?.org).toBeUndefined();
  });

  test("does NOT throw on adversarial inputs", () => {
    // Catch-all: any input must either return undefined or a valid
    // claim object — never throw.
    const adversarial = [
      "sntrys___",
      "sntrys__",
      "sntrys_💥_secret",
      "sntrys_\u0000_secret",
      "sntrys_/=+_secret",
      // Base64 of `{`  — incomplete JSON
      `sntrys_${Buffer.from("{", "utf8").toString("base64")}_secret`,
    ];
    for (const input of adversarial) {
      expect(() => parseSntrysClaim(input)).not.toThrow();
    }
  });

  test("treats forged claim same as legitimate (we don't verify signatures)", () => {
    // CRITICAL: this test documents that parseSntrysClaim does NOT
    // validate the claim's authenticity. An attacker can mint a token
    // with any url they want and parseSntrysClaim returns it. Callers
    // must NEVER use the claim as a primary security signal — see
    // `src/lib/token-claims.ts` JSDoc.
    const forged = mintSntrysToken({
      iat: 1_700_000_000,
      url: "https://evil.com",
      org: "victim",
    });
    expect(parseSntrysClaim(forged)).toEqual({
      url: "https://evil.com",
      regionUrl: undefined,
      org: "victim",
    });
  });
});
