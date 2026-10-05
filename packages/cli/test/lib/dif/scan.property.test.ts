/**
 * Property-based tests for `debug-files upload` scanning filters.
 *
 * Verifies the pure filter predicates in `src/lib/dif/scan.ts`
 * ({@link objectPassesFilters}, {@link normalizeDebugId}, {@link buildDifFilters})
 * hold for arbitrary parsed-object inputs, without touching the filesystem.
 */

import {
  type Arbitrary,
  boolean,
  constant,
  constantFrom,
  assert as fcAssert,
  oneof,
  property,
  record,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import type { DifObjectInfo } from "../../../src/lib/dif/index.js";
import {
  buildDifFilters,
  type DifFilters,
  debugIdMatches,
  normalizeDebugId,
  objectPassesFilters,
  VALID_DIF_TYPES,
} from "../../../src/lib/dif/scan.js";
import { ValidationError } from "../../../src/lib/errors.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

const NIL_DEBUG_ID = "00000000-0000-0000-0000-000000000000";

const hexGroup = (length: number) =>
  tuple(
    ...Array.from({ length }, () => constantFrom(..."0123456789abcdef"))
  ).map((chars) => chars.join(""));

/** A non-nil UUID (8-4-4-4-12). May coincide with nil with negligible odds. */
const uuidArb = tuple(
  hexGroup(8),
  hexGroup(4),
  hexGroup(4),
  hexGroup(4),
  hexGroup(12)
).map((parts) => parts.join("-"));

/** A debug id: valid UUID, UUID+age suffix, or the nil id. */
const debugIdArb = oneof(
  uuidArb,
  tuple(uuidArb, hexGroup(8)).map(([id, age]) => `${id}-${age}`),
  constant(NIL_DEBUG_ID)
);

const formatArb = constantFrom(
  "elf",
  "macho",
  "pe",
  "pdb",
  "portablepdb",
  "wasm",
  "breakpad",
  "sourcebundle",
  "unknown"
);

const difObjectArb: Arbitrary<DifObjectInfo> = record({
  debugId: debugIdArb,
  codeId: oneof(constant<string | null>(null), hexGroup(16)),
  arch: constant("x86_64"),
  fileFormat: formatArb,
  kind: constant("dbg"),
  hasSymbols: boolean(),
  hasDebugInfo: boolean(),
  hasUnwindInfo: boolean(),
  hasSources: boolean(),
});

/** The default filter set: every feature wanted, no type/id restriction. */
const defaultFilters = (): DifFilters => buildDifFilters({});

describe("property: normalizeDebugId", () => {
  test("is idempotent", () => {
    fcAssert(
      property(debugIdArb, (id) => {
        const once = normalizeDebugId(id);
        expect(normalizeDebugId(once)).toBe(once);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output is lowercase and brace-free", () => {
    fcAssert(
      property(debugIdArb, (id) => {
        const wrapped = `{${id.toUpperCase()}}`;
        const normalized = normalizeDebugId(wrapped);
        expect(normalized).toBe(normalized.toLowerCase());
        expect(normalized).not.toContain("{");
        expect(normalized).not.toContain("}");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: objectPassesFilters", () => {
  test("a nil debug id never passes, regardless of filters", () => {
    fcAssert(
      property(difObjectArb, (obj) => {
        const nilObj = { ...obj, debugId: NIL_DEBUG_ID };
        expect(objectPassesFilters(nilObj, defaultFilters())).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("an object with no features never passes", () => {
    fcAssert(
      property(difObjectArb, (obj) => {
        const featureless = {
          ...obj,
          hasSymbols: false,
          hasDebugInfo: false,
          hasUnwindInfo: false,
          hasSources: false,
        };
        expect(objectPassesFilters(featureless, defaultFilters())).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("dropping every feature filter rejects everything", () => {
    const noFeatures = buildDifFilters({
      noDebug: true,
      noUnwind: true,
      noSources: true,
    });
    fcAssert(
      property(difObjectArb, (obj) => {
        expect(objectPassesFilters(obj, noFeatures)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("a type filter excludes objects of other formats", () => {
    fcAssert(
      property(difObjectArb, (obj) => {
        // Filter for ELF only; any non-ELF, non-nil object must be excluded.
        const elfOnly = buildDifFilters({ types: ["elf"] });
        if (obj.fileFormat !== "elf") {
          expect(objectPassesFilters(obj, elfOnly)).toBe(false);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("a valid id + at least one feature passes with default filters", () => {
    fcAssert(
      property(uuidArb, constantFrom(0, 1, 2, 3), (id, featureIdx) => {
        const obj: DifObjectInfo = {
          debugId: id,
          codeId: null,
          arch: "x86_64",
          fileFormat: "elf",
          kind: "dbg",
          hasSymbols: featureIdx === 0,
          hasDebugInfo: featureIdx === 1,
          hasUnwindInfo: featureIdx === 2,
          hasSources: featureIdx === 3,
        };
        expect(objectPassesFilters(obj, defaultFilters())).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("an id filter matches regardless of age suffix", () => {
    fcAssert(
      property(uuidArb, hexGroup(8), (id, age) => {
        const obj: DifObjectInfo = {
          debugId: `${id}-${age}`,
          codeId: null,
          arch: "x86_64",
          fileFormat: "pe",
          kind: "dbg",
          hasSymbols: true,
          hasDebugInfo: false,
          hasUnwindInfo: false,
          hasSources: false,
        };
        // Requesting the base UUID (no age) still matches the aged object.
        const idFilter = buildDifFilters({ ids: [id] });
        expect(objectPassesFilters(obj, idFilter)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: debugIdMatches", () => {
  test("is reflexive and case/brace insensitive", () => {
    fcAssert(
      property(debugIdArb, (id) => {
        expect(debugIdMatches(id, id)).toBe(true);
        expect(debugIdMatches(id, `{${id.toUpperCase()}}`)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("a base UUID matches its aged form (PE/PDB)", () => {
    fcAssert(
      property(uuidArb, hexGroup(8), (id, age) => {
        expect(debugIdMatches(id, `${id}-${age}`)).toBe(true);
        expect(debugIdMatches(`${id}-${age}`, id)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("buildDifFilters", () => {
  test("accepts every documented type", () => {
    for (const type of VALID_DIF_TYPES) {
      expect(() => buildDifFilters({ types: [type] })).not.toThrow();
    }
  });

  test("throws ValidationError on an unknown type", () => {
    expect(() => buildDifFilters({ types: ["bogus"] })).toThrow(
      ValidationError
    );
  });

  test("--no-debug drops both debug and symtab features", () => {
    const filters = buildDifFilters({ noDebug: true });
    expect(filters.debug).toBe(false);
    expect(filters.symtab).toBe(false);
    expect(filters.unwind).toBe(true);
    expect(filters.sources).toBe(true);
  });
});
