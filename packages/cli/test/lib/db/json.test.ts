/**
 * Unit tests for the safeParseJson cache helper.
 */

import { describe, expect, test } from "vitest";
import { safeParseJson } from "../../../src/lib/db/json.js";

describe("safeParseJson", () => {
  test("parses valid JSON", () => {
    expect(safeParseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(safeParseJson<number[]>("[1,2,3]")).toEqual([1, 2, 3]);
  });

  test("returns undefined for null/undefined input", () => {
    expect(safeParseJson(null)).toBeUndefined();
    expect(safeParseJson(undefined)).toBeUndefined();
  });

  test("returns undefined for unparseable JSON instead of throwing", () => {
    expect(safeParseJson("{not json")).toBeUndefined();
    expect(safeParseJson("")).toBeUndefined();
  });

  test("returns undefined when the validator rejects the parsed value", () => {
    const isStringArray = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((x) => typeof x === "string");

    expect(safeParseJson('["a","b"]', isStringArray)).toEqual(["a", "b"]);
    expect(safeParseJson('{"a":1}', isStringArray)).toBeUndefined();
    expect(safeParseJson("[1,2]", isStringArray)).toBeUndefined();
  });
});
