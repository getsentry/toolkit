/**
 * Property-Based Tests for INI Parser
 *
 * Uses fast-check to verify properties that should always hold true
 * for parseIni/serializeIni, regardless of input.
 */

import {
  array,
  constantFrom,
  dictionary,
  assert as fcAssert,
  property,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { type IniData, parseIni } from "../../src/lib/ini.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

/**
 * Serialize IniData to INI string for round-trip testing.
 * Global (empty-key) section is emitted first without a header.
 */
function serializeIni(data: IniData): string {
  const lines: string[] = [];
  const sections = Object.keys(data).sort((a, b) => {
    if (a === "") {
      return -1;
    }
    if (b === "") {
      return 1;
    }
    return a.localeCompare(b);
  });

  for (const section of sections) {
    const entries = data[section] ?? {};
    if (section !== "") {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push(`[${section}]`);
    }
    for (const [key, value] of Object.entries(entries)) {
      lines.push(`${key} = ${value}`);
    }
  }

  return lines.join("\n");
}

// Arbitraries

/** Valid INI section names: lowercase alpha + digits + hyphens/underscores */
const sectionNameChars = "abcdefghijklmnopqrstuvwxyz0123456789-_";
const sectionNameArb = array(constantFrom(...sectionNameChars.split("")), {
  minLength: 1,
  maxLength: 20,
}).map((chars) => chars.join(""));

/** Valid INI key names: lowercase alpha + digits + underscores/hyphens */
const keyChars = "abcdefghijklmnopqrstuvwxyz0123456789_-";
const keyNameArb = array(constantFrom(...keyChars.split("")), {
  minLength: 1,
  maxLength: 20,
}).map((chars) => chars.join(""));

/**
 * Valid INI values: printable characters that don't start with quotes
 * and don't contain newlines. Avoids leading `"` or `'` to prevent
 * round-trip issues with quote stripping.
 */
const safeValueChars =
  "abcdefghijklmnopqrstuvwxyz0123456789 !@#$%^&*()-_=+[]{}|:/<>.?~`";
const valueArb = array(constantFrom(...safeValueChars.split("")), {
  minLength: 0,
  maxLength: 50,
}).map((chars) => chars.join("").trim());

/** Generate a section as a dict of key→value pairs */
const sectionArb = dictionary(keyNameArb, valueArb, {
  minKeys: 0,
  maxKeys: 5,
});

/** Generate valid IniData (only named sections, no global) for round-trip */
const iniDataArb = dictionary(sectionNameArb, sectionArb, {
  minKeys: 1,
  maxKeys: 5,
});

/** Generate a comment line */
const commentArb = constantFrom(
  "# this is a comment",
  "; another comment",
  "# key = value",
  "; [section]"
);

describe("property: parseIni", () => {
  test("round-trip: serialize then parse recovers all data", () => {
    fcAssert(
      property(iniDataArb, (data) => {
        const serialized = serializeIni(data);
        const parsed = parseIni(serialized);

        // All sections and keys from input should be in output
        for (const [section, entries] of Object.entries(data)) {
          for (const [key, value] of Object.entries(entries)) {
            // Keys and sections are lowercased by parseIni, serializeIni outputs lowercase
            const normalizedSection = section.toLowerCase();
            const normalizedKey = key.toLowerCase();
            expect(parsed[normalizedSection]?.[normalizedKey]).toBe(value);
          }
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("idempotency: parse(serialize(parse(x))) === parse(x)", () => {
    fcAssert(
      property(iniDataArb, (data) => {
        const serialized1 = serializeIni(data);
        const parsed1 = parseIni(serialized1);
        const serialized2 = serializeIni(parsed1);
        const parsed2 = parseIni(serialized2);

        // Remove empty global section for comparison
        const clean1 = { ...parsed1 };
        const clean2 = { ...parsed2 };
        if (clean1[""] && Object.keys(clean1[""]).length === 0) {
          delete clean1[""];
        }
        if (clean2[""] && Object.keys(clean2[""]).length === 0) {
          delete clean2[""];
        }

        expect(clean2).toEqual(clean1);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("inserting comment lines does not change parsed values", () => {
    fcAssert(
      property(iniDataArb, commentArb, (data, comment) => {
        const serialized = serializeIni(data);
        const lines = serialized.split("\n");

        // Insert comment at random positions
        const withComments = lines.flatMap((line) => [comment, line]);
        const withCommentsStr = withComments.join("\n");

        const original = parseIni(serialized);
        const withCommentsData = parseIni(withCommentsStr);

        // All non-empty-global sections should match
        for (const [section, entries] of Object.entries(original)) {
          if (section === "" && Object.keys(entries).length === 0) {
            continue;
          }
          for (const [key, value] of Object.entries(entries)) {
            expect(withCommentsData[section]?.[key]).toBe(value);
          }
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("key names are case-insensitive", () => {
    fcAssert(
      property(sectionNameArb, keyNameArb, valueArb, (section, key, value) => {
        const upper = `[${section}]\n${key.toUpperCase()} = ${value}`;
        const lower = `[${section}]\n${key.toLowerCase()} = ${value}`;

        const parsedUpper = parseIni(upper);
        const parsedLower = parseIni(lower);

        const normalizedSection = section.toLowerCase();
        const normalizedKey = key.toLowerCase();

        expect(parsedUpper[normalizedSection]?.[normalizedKey]).toBe(
          parsedLower[normalizedSection]?.[normalizedKey]
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("section names are case-insensitive", () => {
    fcAssert(
      property(sectionNameArb, keyNameArb, valueArb, (section, key, value) => {
        const upper = `[${section.toUpperCase()}]\n${key} = ${value}`;
        const lower = `[${section.toLowerCase()}]\n${key} = ${value}`;

        const parsedUpper = parseIni(upper);
        const parsedLower = parseIni(lower);

        const normalizedSection = section.toLowerCase();
        const normalizedKey = key.toLowerCase();

        expect(parsedUpper[normalizedSection]?.[normalizedKey]).toBe(
          parsedLower[normalizedSection]?.[normalizedKey]
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("last-write-wins for duplicate keys in same section", () => {
    fcAssert(
      property(
        sectionNameArb,
        keyNameArb,
        valueArb,
        valueArb,
        (section, key, value1, value2) => {
          const content = `[${section}]\n${key} = ${value1}\n${key} = ${value2}`;
          const parsed = parseIni(content);
          const normalizedSection = section.toLowerCase();
          const normalizedKey = key.toLowerCase();
          expect(parsed[normalizedSection]?.[normalizedKey]).toBe(value2);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
