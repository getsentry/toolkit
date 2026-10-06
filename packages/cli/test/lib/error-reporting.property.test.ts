/**
 * Property-Based Tests for Error Reporting Helpers
 *
 * Verifies that `extractResourceKind` produces stable grouping keys
 * regardless of the user-supplied slug/id embedded in the resource string.
 */

import {
  array,
  constantFrom,
  assert as fcAssert,
  integer,
  property,
  stringMatching,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { extractResourceKind } from "../../src/lib/error-reporting.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

/** Lowercase alphanumeric slug with optional hyphens. */
const slugArb = array(
  constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-".split("")),
  { minLength: 1, maxLength: 25 }
)
  .map((chars) => chars.join(""))
  .filter((s) => !(s.startsWith("-") || s.endsWith("-")) && s.length > 0);

/** Slug that contains at least one hyphen (matches the entity-name strip regex). */
const hyphenatedSlugArb = slugArb.filter((s) => s.includes("-"));

/** 32-character lowercase hex id (trace/event/log id). */
const hexIdArb = stringMatching(/^[0-9a-f]{32}$/).filter(
  (s) => s.length === 32
);

/** Arbitrary numeric id across the full range (small issue IDs to large). */
const numericIdArb = integer({ min: 1, max: 9_999_999_999 }).map(String);

describe("extractResourceKind — property tests", () => {
  test("single-quoted slug produces same kind for any slug", () => {
    fcAssert(
      property(slugArb, slugArb, (a, b) => {
        const ka = extractResourceKind(`Project '${a}'`);
        const kb = extractResourceKind(`Project '${b}'`);
        expect(ka).toBe(kb);
        expect(ka).toBe("Project");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("double-quoted slug produces same kind as single-quoted", () => {
    fcAssert(
      property(slugArb, (slug) => {
        expect(extractResourceKind(`Project '${slug}'`)).toBe(
          extractResourceKind(`Project "${slug}"`)
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("numeric-id stripping is slug-invariant", () => {
    fcAssert(
      property(numericIdArb, numericIdArb, (id1, id2) => {
        expect(extractResourceKind(`Issue ${id1} not found.`)).toBe(
          extractResourceKind(`Issue ${id2} not found.`)
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("hex-id stripping is slug-invariant", () => {
    fcAssert(
      property(hexIdArb, hexIdArb, (h1, h2) => {
        expect(extractResourceKind(`Trace ${h1} not found`)).toBe(
          extractResourceKind(`Trace ${h2} not found`)
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("idempotent on output", () => {
    fcAssert(
      property(slugArb, (slug) => {
        const once = extractResourceKind(`Project '${slug}' not found.`);
        expect(extractResourceKind(once)).toBe(once);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("not-found template is slug-invariant for org/project pair", () => {
    fcAssert(
      property(slugArb, slugArb, slugArb, slugArb, (o1, p1, o2, p2) => {
        expect(
          extractResourceKind(
            `Project '${p1}' not found in organization '${o1}'`
          )
        ).toBe(
          extractResourceKind(
            `Project '${p2}' not found in organization '${o2}'`
          )
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("org/project path in headline is stripped for any org/project", () => {
    fcAssert(
      property(slugArb, slugArb, slugArb, slugArb, (o1, p1, o2, p2) => {
        expect(extractResourceKind(`not found in ${o1}/${p1}`)).toBe(
          extractResourceKind(`not found in ${o2}/${p2}`)
        );
        expect(extractResourceKind(`not found in ${o1}/${p1}`)).toBe(
          "not found"
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("small numeric IDs are stripped just like large ones", () => {
    fcAssert(
      property(integer({ min: 1, max: 99 }), numericIdArb, (small, large) => {
        expect(extractResourceKind(`Issue ${small} not found.`)).toBe(
          extractResourceKind(`Issue ${large} not found.`)
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("bare slug after 'in' (no slash) is stripped for any slug", () => {
    fcAssert(
      property(slugArb, slugArb, (a, b) => {
        expect(extractResourceKind(`not found in ${a}`)).toBe(
          extractResourceKind(`not found in ${b}`)
        );
        expect(extractResourceKind(`not found in ${a}`)).toBe("not found");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("hyphenated slug after entity name is stripped for any slug", () => {
    fcAssert(
      property(hyphenatedSlugArb, hyphenatedSlugArb, (a, b) => {
        expect(extractResourceKind(`Organization ${a}`)).toBe(
          extractResourceKind(`Organization ${b}`)
        );
        expect(extractResourceKind(`Organization ${a}`)).toBe("Organization");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("Dashboard with numeric ID and slug produces same kind", () => {
    fcAssert(
      property(
        numericIdArb,
        slugArb,
        numericIdArb,
        slugArb,
        (n1, s1, n2, s2) => {
          expect(extractResourceKind(`Dashboard ${n1} in ${s1}`)).toBe(
            extractResourceKind(`Dashboard ${n2} in ${s2}`)
          );
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
