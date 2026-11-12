/**
 * Property-Based Tests for SDK positional packing
 *
 * `positionals()` turns a command's optional tuple entries into argv tokens. Each value must
 * stay in its own slot, and only trailing omissions may be dropped.
 */

import {
  array,
  constant,
  assert as fcAssert,
  oneof,
  property,
  string,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { positionals } from "../../src/lib/sdk-positionals.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

const valuesArb = array(oneof(string(), constant(undefined)), {
  maxLength: 6,
});

describe("positionals", () => {
  test("keeps every value in its declared slot", () => {
    fcAssert(
      property(valuesArb, (values) => {
        const result = positionals(...values);
        result.forEach((token, i) => {
          expect(token).toBe(values[i] ?? "");
        });
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("drops only trailing omissions", () => {
    fcAssert(
      property(valuesArb, (values) => {
        const result = positionals(...values);
        expect(values.slice(result.length).every((v) => v === undefined)).toBe(
          true,
        );
        if (result.length > 0) {
          expect(values[result.length - 1]).not.toBeUndefined();
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });
});
