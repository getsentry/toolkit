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

  test.each([
    { field: "label", query: "BAKEND", expected: options[1] },
    { field: "value", query: "fronted-web", expected: options[0] },
    { field: "hint", query: "Pythn", expected: options[1] },
  ])("tolerates typos in the $field", ({ query, expected }) => {
    expect(filterSelectOptions(options, query)).toEqual([expected]);
  });

  test("missing or empty hints do not create unrelated fuzzy matches", () => {
    expect(
      filterSelectOptions(
        [
          { value: "frontend", label: "Web client" },
          { value: "backend", label: "API server", hint: "" },
        ],
        "zz",
      ),
    ).toEqual([]);
  });

  test("an empty filter restores every original option", () => {
    fcAssert(
      property(
        array(record({ value: string(), label: string(), hint: string() })),
        (generatedOptions) => {
          expect(filterSelectOptions(generatedOptions, "")).toBe(
            generatedOptions,
          );
        },
      ),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("matches are original options in their original order without duplicates", () => {
    fcAssert(
      property(
        array(record({ value: string(), label: string(), hint: string() })),
        string(),
        (generatedOptions, query) => {
          const matches = filterSelectOptions(generatedOptions, query);
          let previousIndex = -1;
          for (const match of matches) {
            const index = generatedOptions.indexOf(match);
            expect(index).toBeGreaterThan(previousIndex);
            previousIndex = index;
          }
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
