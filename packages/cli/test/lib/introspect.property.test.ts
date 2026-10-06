/**
 * Property-Based Tests for Route Tree Introspection
 *
 * Uses fast-check to verify invariants that should hold for any valid
 * route tree structure.
 */

import {
  array,
  boolean,
  constantFrom,
  assert as fcAssert,
  oneof,
  property,
  record,
  string,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import type {
  Command,
  FlagDef,
  RouteMap,
  RouteMapEntry,
} from "../../src/lib/introspect.js";
import {
  extractAllRoutes,
  extractFlags,
  getPositionalString,
  resolveCommandPath,
} from "../../src/lib/introspect.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Valid flag kinds */
const flagKindArb = constantFrom(...(["boolean", "parsed", "enum"] as const));

/** Generate a FlagDef */
const flagDefArb = record({
  kind: flagKindArb,
  brief: string(),
  hidden: boolean(),
  optional: boolean(),
  variadic: boolean(),
}) as import("fast-check").Arbitrary<FlagDef>;

/** Generate a simple name (letters + hyphens, no leading/trailing hyphen) */
const nameArb = array(constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), {
  minLength: 1,
  maxLength: 10,
}).map((chars) => chars.join(""));

/** Generate flag definitions map */
const flagsMapArb = array(tuple(nameArb, flagDefArb), {
  minLength: 0,
  maxLength: 5,
}).map((pairs) => Object.fromEntries(pairs));

/** Generate a Command */
const commandArb = record({
  brief: string(),
  flags: flagsMapArb,
}).map(
  ({ brief, flags }): Command => ({
    brief,
    parameters: { flags, aliases: {} },
  })
);

/** Generate a RouteMapEntry with a command */
const commandEntryArb = tuple(nameArb, commandArb, boolean()).map(
  ([name, cmd, hidden]): RouteMapEntry => ({
    name: { original: name },
    target: cmd,
    hidden,
  })
);

/** Generate a simple RouteMap (one level) */
const routeMapArb = tuple(
  string(),
  array(commandEntryArb, { minLength: 0, maxLength: 5 })
).map(
  ([brief, entries]): RouteMap => ({
    brief,
    getAllEntries: () => entries,
  })
);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("property: extractFlags", () => {
  test("always returns one FlagInfo per input entry", () => {
    fcAssert(
      property(flagsMapArb, (flags) => {
        const result = extractFlags(flags);
        expect(result).toHaveLength(Object.keys(flags).length);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("preserves flag names", () => {
    fcAssert(
      property(flagsMapArb, (flags) => {
        const result = extractFlags(flags);
        const resultNames = new Set(result.map((f) => f.name));
        for (const name of Object.keys(flags)) {
          expect(resultNames.has(name)).toBe(true);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("boolean flags default to optional=true", () => {
    fcAssert(
      property(flagsMapArb, (flags) => {
        const result = extractFlags(flags);
        for (const flag of result) {
          if (
            flag.kind === "boolean" &&
            flags[flag.name].optional === undefined
          ) {
            expect(flag.optional).toBe(true);
          }
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: getPositionalString", () => {
  test("tuple always produces angle-bracket placeholders", () => {
    fcAssert(
      property(
        array(
          record({ placeholder: oneof(string(), constantFrom(undefined)) })
        ),
        (params) => {
          const result = getPositionalString({
            kind: "tuple",
            parameters: params,
          });
          if (params.length > 0) {
            expect(result).toContain("<");
            expect(result).toContain(">");
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("array always includes ellipsis", () => {
    fcAssert(
      property(string(), (placeholder) => {
        const result = getPositionalString({
          kind: "array",
          parameter: { placeholder: placeholder || undefined },
        });
        expect(result).toContain("...");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: extractAllRoutes", () => {
  test("never includes hidden entries", () => {
    fcAssert(
      property(routeMapArb, (routeMap) => {
        const routes = extractAllRoutes(routeMap);
        const allEntries = routeMap.getAllEntries();

        // Build a set of names that are ONLY hidden (no visible entry with same name)
        const visibleNames = new Set(
          allEntries.filter((e) => !e.hidden).map((e) => e.name.original)
        );
        const onlyHiddenNames = allEntries
          .filter((e) => e.hidden && !visibleNames.has(e.name.original))
          .map((e) => e.name.original);

        for (const route of routes) {
          expect(onlyHiddenNames).not.toContain(route.name);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("route count <= total visible entries", () => {
    fcAssert(
      property(routeMapArb, (routeMap) => {
        const routes = extractAllRoutes(routeMap);
        const visibleCount = routeMap
          .getAllEntries()
          .filter((e) => !e.hidden).length;
        expect(routes.length).toBeLessThanOrEqual(visibleCount);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: resolveCommandPath", () => {
  test("empty path always returns null", () => {
    fcAssert(
      property(routeMapArb, (routeMap) => {
        expect(resolveCommandPath(routeMap, [])).toBeNull();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("resolved command path starts with 'sentry'", () => {
    fcAssert(
      property(routeMapArb, nameArb, (routeMap, name) => {
        const result = resolveCommandPath(routeMap, [name]);
        if (result && result.kind === "command") {
          expect(result.info.path.startsWith("sentry ")).toBe(true);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
