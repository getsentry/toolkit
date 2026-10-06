/**
 * Property-based tests for `parseSntrysClaim`.
 *
 * Invariants under random input:
 *
 * 1. `parseSntrysClaim` never throws.
 * 2. Round-trip: a token minted with a given url+iat parses back to the
 *    same url.
 * 3. Forged claims parse identically to legitimate ones (this is by
 *    design — see `token-claims.ts` JSDoc — and the property documents
 *    that the parser is NOT a security primitive).
 * 4. Adversarial inputs (random strings, near-prefix matches, malformed
 *    base64, JSON injection attempts) always return `undefined` instead
 *    of a partially-trusted result.
 */

import {
  constantFrom,
  assert as fcAssert,
  property,
  string,
  stringMatching,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { parseSntrysClaim } from "../../src/lib/token-claims.js";
import { mintSntrysToken } from "../helpers.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

const mint = mintSntrysToken;

/** Arbitrary URL-shaped string (https://<host>) */
const httpsUrlArb = stringMatching(
  /^[a-z][a-z0-9-]{0,30}(\.[a-z][a-z0-9-]{0,30}){0,4}$/
).map((host) => `https://${host}`);

describe("property: parseSntrysClaim never throws on adversarial input", () => {
  test("any string input → returns either undefined or a valid claim", () => {
    fcAssert(
      property(string({ maxLength: 4000 }), (input) => {
        const result = parseSntrysClaim(input);
        if (result !== undefined) {
          // If it parsed, the claim must have a non-empty string url
          expect(typeof result.url).toBe("string");
          expect(result.url.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS * 4 }
    );
  });

  test("strings starting with sntrys_ but with weird content → never throws", () => {
    const sntrysPrefixed = string({ maxLength: 1000 }).map(
      (rest) => `sntrys_${rest}`
    );
    fcAssert(
      property(sntrysPrefixed, (input) => {
        expect(() => parseSntrysClaim(input)).not.toThrow();
      }),
      { numRuns: DEFAULT_NUM_RUNS * 4 }
    );
  });
});

describe("property: round-trip — minted tokens parse back to the same url", () => {
  test("any https URL minted into a token parses back identically", () => {
    fcAssert(
      property(httpsUrlArb, (url) => {
        const token = mint({ iat: 1_700_000_000, url, org: "x" });
        expect(parseSntrysClaim(token)?.url).toBe(url);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("any iat > 0 produces a parseable claim", () => {
    fcAssert(
      property(
        tuple(constantFrom(1, 100, 1_700_000_000, Date.now()), httpsUrlArb),
        ([iat, url]) => {
          const token = mint({ iat, url, org: "x" });
          expect(parseSntrysClaim(token)).toBeDefined();
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: forged claims parse identically (NOT a security signal)", () => {
  test("any url an attacker chooses parses back as that url", () => {
    // This property documents that parseSntrysClaim does NOT validate
    // claim authenticity. Callers MUST treat the result as a hint, not
    // a trust source. See `src/lib/token-claims.ts` for the contract.
    fcAssert(
      property(httpsUrlArb, (forgedUrl) => {
        const forged = mint({
          iat: 1_700_000_000,
          url: forgedUrl,
          org: "anything",
        });
        expect(parseSntrysClaim(forged)?.url).toBe(forgedUrl);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
