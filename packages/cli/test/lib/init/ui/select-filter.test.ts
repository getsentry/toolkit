import {
  array,
  constantFrom,
  assert as fcAssert,
  property,
  record,
  string,
} from "fast-check";
import { describe, expect, test } from "vitest";
import {
  filterSelectOptions,
  removeLastFilterCharacter,
  sanitizeSelectFilterInput,
} from "../../../../src/lib/init/ui/select-filter.js";
import { DEFAULT_NUM_RUNS } from "../../../model-based/helpers.js";

const options = [
  { value: "frontend-web", label: "Web", hint: "JavaScript" },
  { value: "api", label: "Backend", hint: "Python" },
  { value: "mobile", label: "Frontend Mobile" },
] as const;

describe("filterSelectOptions", () => {
  test("matches names, slugs, and hints without case sensitivity or reordering", () => {
    expect(filterSelectOptions(options, "FRONT")).toEqual([
      options[0],
      options[2],
    ]);
    expect(filterSelectOptions(options, "python")).toEqual([options[1]]);
    expect(filterSelectOptions(options, "missing")).toEqual([]);
  });

  test("an empty filter restores every original option", () => {
    fcAssert(
      property(
        array(record({ value: string(), label: string(), hint: string() })),
        (generatedOptions) => {
          expect(filterSelectOptions(generatedOptions, "")).toEqual(
            generatedOptions,
          );
        },
      ),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("extending a query can only remove matches and preserves their order", () => {
    fcAssert(
      property(
        array(record({ value: string(), label: string(), hint: string() })),
        string(),
        string(),
        (generatedOptions, query, suffix) => {
          const matches = filterSelectOptions(generatedOptions, query);
          const narrowerMatches = filterSelectOptions(
            generatedOptions,
            query + suffix,
          );
          const narrowerSet = new Set(narrowerMatches);
          expect(narrowerMatches).toEqual(
            matches.filter((option) => narrowerSet.has(option)),
          );
        },
      ),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });
});

describe("sanitizeSelectFilterInput", () => {
  test("keeps ordinary pasted text while removing terminal escapes and controls", () => {
    expect(
      sanitizeSelectFilterInput(
        "\u001b[31mFront\u001b[0m\t End\r\n\u0000\u007f",
      ),
    ).toBe("Front End");
    expect(sanitizeSelectFilterInput("Equipo 👩🏽‍💻")).toBe("Equipo 👩🏽‍💻");
    expect(sanitizeSelectFilterInput("\u001b[A")).toBe("");
  });
});

describe("removeLastFilterCharacter", () => {
  test("removes the final displayed character without breaking Unicode", () => {
    fcAssert(
      property(
        array(constantFrom("a", " ", "é", "e\u0301", "👩🏽‍💻", "🇪🇸")),
        (characters) => {
          expect(removeLastFilterCharacter(characters.join(""))).toBe(
            characters.slice(0, -1).join(""),
          );
        },
      ),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });
});
