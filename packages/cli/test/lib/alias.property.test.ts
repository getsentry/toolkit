/**
 * Property-Based Tests for Alias Generation
 *
 * Uses fast-check to verify properties that should always hold true
 * for the alias generation functions, regardless of input.
 */

import {
  array,
  constantFrom,
  assert as fcAssert,
  property,
  tuple,
  uniqueArray,
} from "fast-check";
import { describe, expect, test } from "vitest";
import {
  buildOrgAwareAliases,
  findCommonWordPrefix,
  findShortestUniquePrefixes,
  type OrgProjectPair,
} from "../../src/lib/alias.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// Arbitraries

/** Generate valid slug characters */
const slugChars = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Generate simple slugs (no hyphens) */
const simpleSlugArb = array(constantFrom(...slugChars.split("")), {
  minLength: 1,
  maxLength: 15,
}).map((chars) => chars.join(""));

/** Generate slugs that may contain hyphens */
const slugWithHyphensArb = array(constantFrom(...`${slugChars}-`.split("")), {
  minLength: 2,
  maxLength: 20,
})
  .map((chars) => chars.join(""))
  .filter((s) => !(s.startsWith("-") || s.endsWith("-") || s.includes("--")));

/** Generate org slugs */
const orgSlugArb = simpleSlugArb;

/** Generate project slugs (may have hyphens like "spotlight-electron") */
const projectSlugArb = slugWithHyphensArb;

/** Generate org/project pairs */
const orgProjectPairArb = tuple(orgSlugArb, projectSlugArb).map(
  ([org, project]): OrgProjectPair => ({ org, project })
);

/** Generate arrays of unique strings */
const uniqueStringsArb = uniqueArray(simpleSlugArb, {
  minLength: 1,
  maxLength: 10,
  comparator: (a, b) => a.toLowerCase() === b.toLowerCase(),
});

/** Generate strings with common word prefix (like spotlight-*) */
const commonPrefixStringsArb = tuple(
  simpleSlugArb,
  uniqueArray(simpleSlugArb, { minLength: 2, maxLength: 5 })
).map(([prefix, suffixes]) => suffixes.map((s) => `${prefix}-${s}`));

// Properties for findShortestUniquePrefixes

describe("property: findShortestUniquePrefixes", () => {
  test("every input string gets a prefix", () => {
    fcAssert(
      property(uniqueStringsArb, (strings) => {
        const prefixes = findShortestUniquePrefixes(strings);
        expect(prefixes.size).toBe(strings.length);

        for (const str of strings) {
          expect(prefixes.has(str)).toBe(true);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("prefixes are unique within the set", () => {
    fcAssert(
      property(uniqueStringsArb, (strings) => {
        const prefixes = findShortestUniquePrefixes(strings);
        const prefixValues = [...prefixes.values()];
        const uniquePrefixValues = new Set(prefixValues);

        // All prefixes should be unique
        expect(uniquePrefixValues.size).toBe(prefixValues.length);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("prefix is always a prefix of the original string", () => {
    fcAssert(
      property(uniqueStringsArb, (strings) => {
        const prefixes = findShortestUniquePrefixes(strings);

        for (const [str, prefix] of prefixes) {
          expect(str.toLowerCase().startsWith(prefix)).toBe(true);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("prefix is lowercase", () => {
    fcAssert(
      property(uniqueStringsArb, (strings) => {
        const prefixes = findShortestUniquePrefixes(strings);

        for (const prefix of prefixes.values()) {
          expect(prefix).toBe(prefix.toLowerCase());
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("prefix is minimal (can't be shorter and still unique)", () => {
    fcAssert(
      property(uniqueStringsArb, (strings) => {
        if (strings.length < 2) return;

        const prefixes = findShortestUniquePrefixes(strings);

        for (const [str, prefix] of prefixes) {
          if (prefix.length <= 1) continue;

          // Check that a shorter prefix would NOT be unique
          const shorterPrefix = prefix.slice(0, -1);
          const wouldCollide = strings.some(
            (other) =>
              other !== str && other.toLowerCase().startsWith(shorterPrefix)
          );

          expect(wouldCollide).toBe(true);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("single string gets first character as prefix", () => {
    fcAssert(
      property(simpleSlugArb, (str) => {
        const prefixes = findShortestUniquePrefixes([str]);
        expect(prefixes.get(str)).toBe(str.charAt(0).toLowerCase());
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("prefixes never end with dash or underscore", () => {
    // Use slugs that may contain hyphens to test the extension logic
    fcAssert(
      property(
        uniqueArray(slugWithHyphensArb, {
          minLength: 1,
          maxLength: 10,
          comparator: (a, b) => a.toLowerCase() === b.toLowerCase(),
        }),
        (strings) => {
          const prefixes = findShortestUniquePrefixes(strings);

          for (const prefix of prefixes.values()) {
            expect(prefix.endsWith("-")).toBe(false);
            expect(prefix.endsWith("_")).toBe(false);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("empty array returns empty map", () => {
    const prefixes = findShortestUniquePrefixes([]);
    expect(prefixes.size).toBe(0);
  });
});

// Properties for findCommonWordPrefix

describe("property: findCommonWordPrefix", () => {
  test("returns common prefix for strings with shared word boundary", () => {
    fcAssert(
      property(commonPrefixStringsArb, (strings) => {
        const prefix = findCommonWordPrefix(strings);

        // Should find the common prefix
        expect(prefix.length).toBeGreaterThan(0);

        // All strings with boundaries should start with the prefix
        for (const str of strings) {
          expect(str.toLowerCase().startsWith(prefix)).toBe(true);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns empty string for strings without common boundary prefix", () => {
    fcAssert(
      property(
        uniqueArray(simpleSlugArb, { minLength: 2, maxLength: 5 }),
        (strings) => {
          // Simple slugs have no hyphens, so no common word prefix
          const prefix = findCommonWordPrefix(strings);
          expect(prefix).toBe("");
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns empty string for single element arrays", () => {
    fcAssert(
      property(slugWithHyphensArb, (str) => {
        const prefix = findCommonWordPrefix([str]);
        expect(prefix).toBe("");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns empty string for empty arrays", () => {
    const prefix = findCommonWordPrefix([]);
    expect(prefix).toBe("");
  });

  test("prefix ends with boundary character if found", () => {
    fcAssert(
      property(commonPrefixStringsArb, (strings) => {
        const prefix = findCommonWordPrefix(strings);

        if (prefix.length > 0) {
          // Should end with hyphen or underscore
          const lastChar = prefix.at(-1);
          expect(lastChar === "-" || lastChar === "_").toBe(true);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("prefix is lowercase", () => {
    fcAssert(
      property(commonPrefixStringsArb, (strings) => {
        const prefix = findCommonWordPrefix(strings);
        expect(prefix).toBe(prefix.toLowerCase());
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// Properties for buildOrgAwareAliases

describe("property: buildOrgAwareAliases", () => {
  test("every input pair gets an alias", () => {
    fcAssert(
      property(
        array(orgProjectPairArb, { minLength: 1, maxLength: 10 }),
        (pairs) => {
          const { aliasMap } = buildOrgAwareAliases(pairs);

          // Each unique org/project pair should have an alias
          const uniqueKeys = new Set(pairs.map((p) => `${p.org}/${p.project}`));
          expect(aliasMap.size).toBe(uniqueKeys.size);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("aliases are unique within the result", () => {
    fcAssert(
      property(
        array(orgProjectPairArb, { minLength: 1, maxLength: 10 }),
        (pairs) => {
          const { aliasMap } = buildOrgAwareAliases(pairs);
          const aliases = [...aliasMap.values()];
          const uniqueAliases = new Set(aliases);

          expect(uniqueAliases.size).toBe(aliases.length);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("aliases are lowercase", () => {
    fcAssert(
      property(
        array(orgProjectPairArb, { minLength: 1, maxLength: 10 }),
        (pairs) => {
          const { aliasMap } = buildOrgAwareAliases(pairs);

          for (const alias of aliasMap.values()) {
            expect(alias).toBe(alias.toLowerCase());
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("aliases are non-empty", () => {
    fcAssert(
      property(
        array(orgProjectPairArb, { minLength: 1, maxLength: 10 }),
        (pairs) => {
          const { aliasMap } = buildOrgAwareAliases(pairs);

          for (const alias of aliasMap.values()) {
            expect(alias.length).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("aliases never end with dash or underscore", () => {
    fcAssert(
      property(
        array(orgProjectPairArb, { minLength: 1, maxLength: 10 }),
        (pairs) => {
          const { aliasMap } = buildOrgAwareAliases(pairs);

          for (const alias of aliasMap.values()) {
            expect(alias.endsWith("-")).toBe(false);
            expect(alias.endsWith("_")).toBe(false);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("empty input returns empty map", () => {
    const { aliasMap } = buildOrgAwareAliases([]);
    expect(aliasMap.size).toBe(0);
  });

  test("colliding slugs get org-prefixed aliases", () => {
    // Create pairs with same project slug in different orgs
    fcAssert(
      property(
        tuple(simpleSlugArb, simpleSlugArb, simpleSlugArb),
        ([org1, org2, project]) => {
          if (org1 === org2) return; // Need different orgs

          const pairs: OrgProjectPair[] = [
            { org: org1, project },
            { org: org2, project },
          ];

          const { aliasMap } = buildOrgAwareAliases(pairs);

          // Both should have aliases
          expect(aliasMap.has(`${org1}/${project}`)).toBe(true);
          expect(aliasMap.has(`${org2}/${project}`)).toBe(true);

          // Aliases should be different
          const alias1 = aliasMap.get(`${org1}/${project}`);
          const alias2 = aliasMap.get(`${org2}/${project}`);
          expect(alias1).not.toBe(alias2);

          // Colliding aliases should contain "/" (org prefix)
          expect(alias1?.includes("/")).toBe(true);
          expect(alias2?.includes("/")).toBe(true);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("non-colliding slugs get simple prefixes (no org)", () => {
    fcAssert(
      property(
        tuple(
          simpleSlugArb,
          uniqueArray(simpleSlugArb, { minLength: 2, maxLength: 5 })
        ),
        ([org, projects]) => {
          const pairs: OrgProjectPair[] = projects.map((p) => ({
            org,
            project: p,
          }));
          const { aliasMap } = buildOrgAwareAliases(pairs);

          // All aliases should be simple (no "/")
          for (const alias of aliasMap.values()) {
            expect(alias.includes("/")).toBe(false);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("deterministic results for same input", () => {
    fcAssert(
      property(
        array(orgProjectPairArb, { minLength: 1, maxLength: 10 }),
        (pairs) => {
          const result1 = buildOrgAwareAliases(pairs);
          const result2 = buildOrgAwareAliases(pairs);

          expect(result1.aliasMap.size).toBe(result2.aliasMap.size);

          for (const [key, alias1] of result1.aliasMap) {
            expect(result2.aliasMap.get(key)).toBe(alias1);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// Cross-function Properties

describe("property: cross-function invariants", () => {
  test("common prefix stripping improves alias brevity", () => {
    fcAssert(
      property(commonPrefixStringsArb, (projects) => {
        // All in same org, all share prefix
        const pairs: OrgProjectPair[] = projects.map((p) => ({
          org: "acme",
          project: p,
        }));

        const { aliasMap } = buildOrgAwareAliases(pairs);

        // Aliases should be shorter than full project slugs
        for (const [key, alias] of aliasMap) {
          const project = key.split("/")[1]!;
          expect(alias.length).toBeLessThanOrEqual(project.length);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("findShortestUniquePrefixes is consistent with buildOrgAwareAliases for unique slugs", () => {
    fcAssert(
      property(
        tuple(
          simpleSlugArb,
          uniqueArray(simpleSlugArb, { minLength: 2, maxLength: 5 })
        ),
        ([org, projects]) => {
          // Build aliases through the full function
          const pairs: OrgProjectPair[] = projects.map((p) => ({
            org,
            project: p,
          }));
          const { aliasMap } = buildOrgAwareAliases(pairs);

          // Get prefixes directly
          const directPrefixes = findShortestUniquePrefixes(projects);

          // Aliases should match direct prefixes for simple unique slugs
          for (const [key, alias] of aliasMap) {
            const project = key.split("/")[1]!;
            expect(directPrefixes.get(project)).toBe(alias);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
