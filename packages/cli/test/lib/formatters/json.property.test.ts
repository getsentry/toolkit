/**
 * Property-based tests for JSON field filtering and parsing.
 *
 * Tests invariants of {@link filterFields} and {@link parseFieldsList}
 * that should hold for any valid input.
 */

import {
  array,
  constantFrom,
  dictionary,
  assert as fcAssert,
  integer,
  jsonValue,
  oneof,
  property,
  string,
  uniqueArray,
} from "fast-check";
import { describe, expect, test } from "vitest";
import {
  filterFields,
  parseFieldsList,
} from "../../../src/lib/formatters/json.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generates simple field names (lowercase letters, 1-8 chars) */
const fieldNameArb = array(
  constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
  { minLength: 1, maxLength: 8 }
).map((chars) => chars.join(""));

/** Generates dot-notated paths (1-3 segments) */
const fieldPathArb = array(fieldNameArb, { minLength: 1, maxLength: 3 }).map(
  (segments) => segments.join(".")
);

/** Generates a flat object with known string keys and JSON-compatible values */
const flatObjectArb = dictionary(fieldNameArb, jsonValue(), {
  minKeys: 0,
  maxKeys: 10,
});

// ---------------------------------------------------------------------------
// filterFields properties
// ---------------------------------------------------------------------------

describe("property: filterFields", () => {
  test("identity: no fields means empty result", () => {
    fcAssert(
      property(flatObjectArb, (obj) => {
        const result = filterFields(obj, []);
        expect(result).toEqual({});
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("subset: result keys are a subset of requested fields", () => {
    fcAssert(
      property(
        flatObjectArb,
        uniqueArray(fieldNameArb, { minLength: 1, maxLength: 5 }),
        (obj, fields) => {
          const result = filterFields(obj, fields) as Record<string, unknown>;
          const resultKeys = Object.keys(result);
          for (const key of resultKeys) {
            expect(fields).toContain(key);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("existing fields are preserved exactly", () => {
    fcAssert(
      property(flatObjectArb, (obj) => {
        const keys = Object.keys(obj);
        if (keys.length === 0) {
          return;
        }
        const result = filterFields(obj, keys) as Record<string, unknown>;
        for (const key of keys) {
          expect(result[key]).toEqual(obj[key]);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("missing fields are silently ignored", () => {
    fcAssert(
      property(
        flatObjectArb,
        uniqueArray(fieldNameArb, { minLength: 1, maxLength: 5 }),
        (obj, extraFields) => {
          // Filter with fields that may or may not exist
          const result = filterFields(obj, extraFields);
          // Result should never have more keys than the source
          expect(
            Object.keys(result as Record<string, unknown>).length
          ).toBeLessThanOrEqual(Object.keys(obj).length);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("idempotent: filtering twice gives same result", () => {
    fcAssert(
      property(
        flatObjectArb,
        uniqueArray(fieldNameArb, { minLength: 1, maxLength: 5 }),
        (obj, fields) => {
          const once = filterFields(obj, fields);
          const twice = filterFields(once, fields);
          expect(twice).toEqual(once);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("arrays: each element is filtered independently", () => {
    fcAssert(
      property(
        array(flatObjectArb, { minLength: 1, maxLength: 5 }),
        uniqueArray(fieldNameArb, { minLength: 1, maxLength: 3 }),
        (items, fields) => {
          const result = filterFields(items, fields) as Record<
            string,
            unknown
          >[];
          expect(result).toHaveLength(items.length);
          for (let i = 0; i < items.length; i++) {
            expect(result[i]).toEqual(filterFields(items[i], fields));
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("dot-notation: nested fields are extracted correctly", () => {
    // Use a controlled nested object where all keys are simple field names
    // (no dots or special chars) so dot-notation paths are unambiguous
    const safeNestedArb = dictionary(
      fieldNameArb,
      dictionary(fieldNameArb, jsonValue(), { minKeys: 1, maxKeys: 5 }),
      { minKeys: 1, maxKeys: 5 }
    );

    fcAssert(
      property(safeNestedArb, (obj) => {
        const topKeys = Object.keys(obj);
        if (topKeys.length === 0) {
          return;
        }
        const nestedKey = topKeys[0];
        if (!nestedKey) {
          return;
        }
        const inner = obj[nestedKey] as Record<string, unknown>;
        const innerKeys = Object.keys(inner);
        if (innerKeys.length === 0) {
          return;
        }
        const innerKey = innerKeys[0];
        if (!innerKey) {
          return;
        }
        const path = `${nestedKey}.${innerKey}`;

        const result = filterFields(obj, [path]) as Record<
          string,
          Record<string, unknown>
        >;
        expect(result[nestedKey]?.[innerKey]).toEqual(inner[innerKey]);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("primitives pass through unchanged", () => {
    fcAssert(
      property(
        oneof(string(), integer(), constantFrom(null, undefined, true, false)),
        uniqueArray(fieldNameArb, { minLength: 1, maxLength: 3 }),
        (value, fields) => {
          const result = filterFields(value, fields);
          expect(result).toBe(value);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// ---------------------------------------------------------------------------
// parseFieldsList properties
// ---------------------------------------------------------------------------

describe("property: parseFieldsList", () => {
  test("round-trip: joining with commas and re-parsing yields same set", () => {
    fcAssert(
      property(
        uniqueArray(fieldPathArb, { minLength: 1, maxLength: 10 }),
        (fields) => {
          const joined = fields.join(",");
          const parsed = parseFieldsList(joined);
          expect(new Set(parsed)).toEqual(new Set(fields));
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("deduplication: result has no duplicates", () => {
    fcAssert(
      property(
        array(fieldPathArb, { minLength: 1, maxLength: 10 }),
        (fields) => {
          const input = fields.join(",");
          const parsed = parseFieldsList(input);
          expect(parsed.length).toBe(new Set(parsed).size);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("whitespace tolerance: extra spaces don't affect result", () => {
    fcAssert(
      property(
        uniqueArray(fieldPathArb, { minLength: 1, maxLength: 5 }),
        (fields) => {
          const withSpaces = fields.map((f) => `  ${f}  `).join(" , ");
          const clean = fields.join(",");
          expect(parseFieldsList(withSpaces)).toEqual(parseFieldsList(clean));
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("empty segments are filtered out", () => {
    fcAssert(
      property(
        uniqueArray(fieldPathArb, { minLength: 1, maxLength: 5 }),
        (fields) => {
          const withEmpty = `,${fields.join(",,")},`;
          const parsed = parseFieldsList(withEmpty);
          expect(parsed).toEqual(parseFieldsList(fields.join(",")));
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("all-commas yields empty list", () => {
    fcAssert(
      property(integer({ min: 1, max: 10 }), (count) => {
        const input = ",".repeat(count);
        expect(parseFieldsList(input)).toEqual([]);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
