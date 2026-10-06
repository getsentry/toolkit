/**
 * Unit tests for `src/lib/scan/regex.ts`.
 *
 * Tabular coverage of `extractInlineFlags` across the four cases that
 * actually matter for init-wizard patterns:
 *   1. No inline flag group — identity.
 *   2. `(?i)foo` — strip flag group, flags = "i".
 *   3. `(?i:foo)bar` — unwrap scoped group, flag widens to whole pattern.
 *   4. `foo(?i)bar` — mid-pattern group left alone (identity).
 *
 * Plus `compilePattern` success / failure modes.
 */

import { describe, expect, test } from "vitest";
import { ValidationError } from "../../../src/lib/errors.js";
import {
  compilePattern,
  ensureGlobalFlag,
  ensureGlobalMultilineFlags,
  ensureMultilineFlag,
  extractInlineFlags,
} from "../../../src/lib/scan/regex.js";

describe("extractInlineFlags", () => {
  test.each<[string, { cleaned: string; flags: string }]>([
    ["foo", { cleaned: "foo", flags: "" }],
    ["", { cleaned: "", flags: "" }],
    ["(?i)foo", { cleaned: "foo", flags: "i" }],
    ["(?im)^foo$", { cleaned: "^foo$", flags: "im" }],
    ["(?ims)anything", { cleaned: "anything", flags: "ims" }],
    // rg's `U` → JS `s` (dotall).
    ["(?U)foo.bar", { cleaned: "foo.bar", flags: "s" }],
    // Scoped form widens to whole pattern.
    ["(?i:foo)bar", { cleaned: "foobar", flags: "i" }],
    ["(?i:hello)world", { cleaned: "helloworld", flags: "i" }],
    // Mid-pattern flag group is untouched.
    ["foo(?i)bar", { cleaned: "foo(?i)bar", flags: "" }],
    // Escape before `(` — still recognized as inline flag
    // (only leading position matters; the backslash after is part of
    // the remaining pattern).
    ["(?i)\\d+", { cleaned: "\\d+", flags: "i" }],
  ])("extracts %p", (input, expected) => {
    expect(extractInlineFlags(input)).toEqual(expected);
  });

  test("scoped form with nested groups: (?i:foo(bar))baz", () => {
    expect(extractInlineFlags("(?i:foo(bar))baz")).toEqual({
      cleaned: "foo(bar)baz",
      flags: "i",
    });
  });

  test("scoped form with char class containing ): (?i:[a-z)])", () => {
    // Inside a `[...]` class, `)` doesn't close the group. The
    // matching `)` is the outer one, outside the class.
    expect(extractInlineFlags("(?i:[a-z)])")).toEqual({
      cleaned: "[a-z)]",
      flags: "i",
    });
  });

  test("malformed scoped form (unclosed) passes through unchanged", () => {
    // No matching close paren — translator falls back to "leave
    // everything alone" so downstream compile throws a useful error.
    expect(extractInlineFlags("(?i:foo")).toEqual({
      cleaned: "(?i:foo",
      flags: "",
    });
  });
});

describe("compilePattern", () => {
  test("string without flags → plain RegExp", () => {
    expect(compilePattern("foo").toString()).toBe("/foo/");
  });

  test("string with (?i) → /i flag", () => {
    expect(compilePattern("(?i)foo").toString()).toBe("/foo/i");
  });

  test("caseSensitive: false adds i flag", () => {
    expect(compilePattern("foo", { caseSensitive: false }).toString()).toBe(
      "/foo/i"
    );
  });

  test("inline + caseSensitive merge cleanly", () => {
    expect(
      compilePattern("(?m)^foo", { caseSensitive: false }).toString()
    ).toBe("/^foo/im");
  });

  test("multiline: true adds m flag", () => {
    expect(compilePattern("foo", { multiline: true }).toString()).toBe(
      "/foo/m"
    );
  });

  test("pre-compiled RegExp returned as-is", () => {
    const re = /foo/gi;
    expect(compilePattern(re)).toBe(re);
  });

  test("bad pattern throws ValidationError with a helpful message", () => {
    expect(() => compilePattern("[unterminated")).toThrow(ValidationError);
    try {
      compilePattern("[unterminated");
    } catch (error) {
      expect((error as ValidationError).field).toBe("pattern");
      expect((error as ValidationError).message).toMatch(
        /Invalid grep pattern:/
      );
    }
  });

  test("no g flag — grep tests line-by-line", () => {
    // Ensure we never leak the g flag even when requested via inline.
    // (Our translator doesn't accept g, so the user can't provide it
    // through extractInlineFlags; but a pre-compiled RegExp can bring
    // its own.)
    expect(compilePattern("(?i)foo").flags).toBe("i");
  });
});

describe("ensureGlobalFlag", () => {
  test("adds g to a regex without it", () => {
    const re = ensureGlobalFlag(/foo/i);
    expect(re.flags).toBe("gi");
    expect(re.source).toBe("foo");
  });

  test("returns input unchanged when g is already present", () => {
    const input = /foo/gi;
    expect(ensureGlobalFlag(input)).toBe(input);
  });
});

describe("ensureMultilineFlag", () => {
  test("adds m to a regex without it", () => {
    const re = ensureMultilineFlag(/foo/i);
    expect(re.flags).toBe("im");
  });

  test("returns input unchanged when m is already present", () => {
    const input = /foo/m;
    expect(ensureMultilineFlag(input)).toBe(input);
  });

  test("^ matches at line boundaries with m flag", () => {
    const re = ensureMultilineFlag(/^foo/);
    expect(re.test("bar\nfoo")).toBe(true);
  });
});

describe("ensureGlobalMultilineFlags", () => {
  test("adds both g and m in one clone", () => {
    const re = ensureGlobalMultilineFlags(/foo/i);
    expect(re.flags.includes("g")).toBe(true);
    expect(re.flags.includes("m")).toBe(true);
    expect(re.flags.includes("i")).toBe(true);
  });

  test("returns input unchanged when both flags already present", () => {
    const input = /foo/gim;
    expect(ensureGlobalMultilineFlags(input)).toBe(input);
  });

  test("preserves source verbatim", () => {
    const re = ensureGlobalMultilineFlags(/[\w.]+@example\.com/);
    expect(re.source).toBe("[\\w.]+@example\\.com");
  });
});
