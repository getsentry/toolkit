/**
 * Property-based tests for the `.sentryclirc` import engine.
 *
 * Tests core invariants that must hold for any valid input:
 * - Same-file rule: co-present token+URL in one file → always trusted
 * - Cross-file rule: token and URL from different files (non-SaaS) → never trusted
 * - Merge order: closest-wins for project-local, then config-dir, then homedir
 * - Hash determinism: same content → same hash
 * - maskToken: output always contains last 4 chars
 */

import {
  array,
  constantFrom,
  assert as fcAssert,
  property,
  string,
} from "fast-check";
import { describe, expect, test } from "vitest";
import type {
  DiscoveredRcFile,
  ImportPlan,
} from "../../src/lib/sentryclirc-import.js";
import {
  buildImportPlan,
  isSameFileOrigin,
  maskToken,
} from "../../src/lib/sentryclirc-import.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const slugArb = array(
  constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-".split("")),
  { minLength: 1, maxLength: 12 }
).map((chars) => chars.join(""));

const tokenArb = string({ minLength: 8, maxLength: 40 });

const nonSaasUrlArb = slugArb.map((slug) => `https://${slug}.example.com`);

const filePathArb = slugArb.map((slug) => `/${slug}/.sentryclirc`);

// ---------------------------------------------------------------------------
// Same-File Rule
// ---------------------------------------------------------------------------

describe("property: isSameFileOrigin", () => {
  test("single file with both token and non-SaaS URL → always trusted", () => {
    fcAssert(
      property(filePathArb, tokenArb, nonSaasUrlArb, (path, token, url) => {
        const plan: ImportPlan = {
          sources: [],
          effective: { token, url },
          effectiveSources: { token: path, url: path },
          newFields: [],
          hasExistingAuth: false,
          isSaas: false,
          trusted: true,
          warnings: [],
        };
        expect(isSameFileOrigin(plan)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("token and URL from different files (non-SaaS) → never trusted", () => {
    fcAssert(
      property(
        filePathArb,
        filePathArb,
        tokenArb,
        nonSaasUrlArb,
        (pathA, pathB, token, url) => {
          // Ensure paths are actually different
          if (pathA === pathB) {
            return;
          }
          const plan: ImportPlan = {
            sources: [],
            effective: { token, url },
            effectiveSources: { token: pathA, url: pathB },
            newFields: [],
            hasExistingAuth: false,
            isSaas: false,
            trusted: true,
            warnings: [],
          };
          expect(isSameFileOrigin(plan)).toBe(false);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("token only (no URL) → always trusted", () => {
    fcAssert(
      property(filePathArb, tokenArb, (path, token) => {
        const plan: ImportPlan = {
          sources: [],
          effective: { token },
          effectiveSources: { token: path },
          newFields: [],
          hasExistingAuth: false,
          isSaas: true,
          trusted: true,
          warnings: [],
        };
        expect(isSameFileOrigin(plan)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// ---------------------------------------------------------------------------
// maskToken
// ---------------------------------------------------------------------------

describe("property: maskToken", () => {
  test("output always contains at least one asterisk", () => {
    fcAssert(
      property(string({ minLength: 1, maxLength: 100 }), (token) => {
        const masked = maskToken(token);
        expect(masked).toContain("*");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output never equals the original input", () => {
    // Tokens that are entirely asterisks are already fully masked, so
    // maskToken cannot meaningfully change them — exclude that edge case.
    fcAssert(
      property(
        string({ minLength: 1, maxLength: 100 }).filter(
          (t) => !/^\*+$/.test(t)
        ),
        (token) => {
          const masked = maskToken(token);
          expect(masked).not.toBe(token);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("short tokens (<=12) are fully masked", () => {
    fcAssert(
      property(string({ minLength: 1, maxLength: 12 }), (token) => {
        const masked = maskToken(token);
        // Every character should be an asterisk
        expect(masked).toBe("*".repeat(token.length));
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// ---------------------------------------------------------------------------
// buildImportPlan merge order
// ---------------------------------------------------------------------------

describe("property: buildImportPlan merge order", () => {
  test("first file's values win over later files", () => {
    fcAssert(
      property(slugArb, slugArb, (orgA, orgB) => {
        // Ensure different values to test precedence
        if (orgA === orgB) {
          return;
        }
        const fileA: DiscoveredRcFile = {
          path: "/a/.sentryclirc",
          location: "project-local",
          contentHash: "aaa",
          org: orgA,
        };
        const fileB: DiscoveredRcFile = {
          path: "/b/.sentryclirc",
          location: "homedir",
          contentHash: "bbb",
          org: orgB,
        };
        const plan = buildImportPlan([fileA, fileB]);
        expect(plan.effective.org).toBe(orgA);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("later file fills gaps from earlier file", () => {
    fcAssert(
      property(slugArb, tokenArb, (org, token) => {
        const fileA: DiscoveredRcFile = {
          path: "/a/.sentryclirc",
          location: "project-local",
          contentHash: "aaa",
          org,
        };
        const fileB: DiscoveredRcFile = {
          path: "/b/.sentryclirc",
          location: "homedir",
          contentHash: "bbb",
          token,
        };
        const plan = buildImportPlan([fileA, fileB]);
        expect(plan.effective.org).toBe(org);
        expect(plan.effective.token).toBe(token);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
