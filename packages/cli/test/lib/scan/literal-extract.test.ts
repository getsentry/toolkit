import { describe, expect, test } from "vitest";
import { extractInnerLiteral } from "../../../src/lib/scan/literal-extract.js";

describe("extractInnerLiteral — basic patterns", () => {
  test.each([
    // [pattern, flags, expected literal]
    ["import.*from", "", "import"], // quantifier breaks run
    ["function\\s+\\w+", "", "function"], // \s, \w are not literals
    ["http://", "", "http://"], // no metachars at all
    ["SENTRY_DSN", "", "SENTRY_DSN"], // pure literal
    ["hello world", "", "hello world"], // literal with space
    ["^foo$", "", "foo"], // anchors break run, leaving foo
    ["^foo", "", "foo"], // leading anchor only
    ["foo$", "", "foo"], // trailing anchor only
  ])("extracts %p with flags %p → %p", (pattern, flags, expected) => {
    expect(extractInnerLiteral(pattern, flags)).toBe(expected);
  });
});

describe("extractInnerLiteral — escaped metacharacters", () => {
  test.each([
    ["Sentry\\.init", "", "Sentry.init"], // \. is literal dot
    ["foo\\.bar", "", "foo.bar"],
    ["a\\/b", "", "a/b"], // escaped slash
    ["\\\\foo", "", "\\foo"], // escaped backslash
    ["a\\(b\\)", "", "a(b)"], // escaped parens
    ["a\\[b\\]", "", "a[b]"], // escaped brackets
  ])("recognizes escaped literal %p → %p", (pattern, flags, expected) => {
    expect(extractInnerLiteral(pattern, flags)).toBe(expected);
  });
});

describe("extractInnerLiteral — escape sequences that break runs", () => {
  test.each([
    ["\\bfoo\\b", "foo"], // \b anchor, not literal b
    ["\\w+foo\\d+", "foo"], // \w, \d are classes
    ["\\tfoo\\t", "foo"], // \t is tab escape
    ["\\nfoo\\n", "foo"], // \n is newline escape
    ["\\sfoo\\s", "foo"], // \s is whitespace class
  ])("breaks run on non-literal escape %p → %p", (pattern, expected) => {
    expect(extractInnerLiteral(pattern, "")).toBe(expected);
  });
});

describe("extractInnerLiteral — returns null", () => {
  test.each([
    [".*", ""], // no literal content
    [".", ""], // single metachar
    ["foo|bar", ""], // top-level alternation
    ["(foo|bar)", ""], // group with alternation
    ["[abc]", ""], // character class only
    ["a?", ""], // quantified single char (too short after drop)
    ["ab", ""], // below MIN_LITERAL_LEN (3)
    ["   ", ""], // all whitespace
    ["!!!", ""], // all punctuation
  ])("returns null for %p", (pattern, flags) => {
    expect(extractInnerLiteral(pattern, flags)).toBeNull();
  });
});

describe("extractInnerLiteral — case-insensitive flag", () => {
  test("lowercases the extracted literal when flags include i", () => {
    expect(extractInnerLiteral("SENTRY_DSN", "i")).toBe("sentry_dsn");
    expect(extractInnerLiteral("Import.*From", "i")).toBe("import");
  });

  test("leaves the literal case-sensitive without i flag", () => {
    expect(extractInnerLiteral("SENTRY_DSN", "")).toBe("SENTRY_DSN");
    expect(extractInnerLiteral("SENTRY_DSN", "gm")).toBe("SENTRY_DSN");
  });
});

describe("extractInnerLiteral — quantifier handling", () => {
  test("drops the quantified character from the run", () => {
    // `abc*def` — c is quantified (may be absent), so "ab" is one
    // run (length 2, below threshold) and "def" (length 3) wins.
    expect(extractInnerLiteral("abc*def", "")).toBe("def");
  });

  test("handles ? quantifier", () => {
    expect(extractInnerLiteral("a?bcdef", "")).toBe("bcdef");
  });

  test("handles + quantifier", () => {
    // `abc+def` — with +, c IS required (1+ of), but the extractor
    // conservatively drops the preceding char. "ab" too short,
    // "def" wins.
    expect(extractInnerLiteral("abc+def", "")).toBe("def");
  });

  test("handles {n,m} quantifier", () => {
    expect(extractInnerLiteral("abc{2,3}def", "")).toBe("def");
  });

  test("longest run wins when multiple exist", () => {
    // `short.*longer_run.*short` — `longer_run` wins over `short`.
    expect(extractInnerLiteral("short.*longer_run.*short", "")).toBe(
      "longer_run"
    );
  });
});

describe("extractInnerLiteral — character-class opaqueness (Cursor bug #1)", () => {
  /**
   * Regression: `[(]foo|bar` previously extracted `"foo"` because
   * the alternation detector treated `(` inside `[...]` as an
   * opening paren, which corrupted `depthParen` and hid the
   * top-level `|` that followed. The prefilter then silently
   * skipped lines matching only the `bar` branch.
   *
   * The fix: character classes are opaque to the alternation
   * detector. When we see `[`, skip past the first unescaped `]`
   * in one step. Also `[...]` is NOT nestable — `[[]` is a class
   * containing a literal `[`.
   */
  test.each([
    ["[(]foo|bar", null], // ( inside class + top-level alternation
    ["[)]foo|bar", null],
    ["[[]foo|bar", null], // [ inside class (nested-looking but flat)
    ["[|]foo|bar", null], // | inside class is literal; second | is top-level
    ["[(|)]foo|bar", null], // class containing (, |, )
  ])("returns null for %p — alternation hidden by class corrupting paren depth", (pattern, expected) => {
    expect(extractInnerLiteral(pattern, "")).toBe(expected);
  });

  test.each([
    ["foo[(]bar", "foo"], // ( inside class, no alternation → longest run "foo"
    ["foo[abc]bar", "foo"], // normal class between literals
    ["[\\]]foo", "foo"], // escaped ] inside class
    ["[^abc]def", "def"], // negated class
    ["[a-z]{3,5}MARKER", "MARKER"], // class + quantifier + literal
  ])("extracts %p → %p (no alternation present)", (pattern, expected) => {
    expect(extractInnerLiteral(pattern, "")).toBe(expected);
  });
});

describe("extractInnerLiteral — class-in-group opaqueness (Cursor bug #1 followup)", () => {
  /**
   * Sibling of the earlier char-class-opaqueness bug: the group-
   * skipper `skipGroup` (formerly `skipToMatching`) didn't treat
   * `[...]` as opaque, so a `)` inside a char class closed the
   * enclosing group early. For `(ABC[)]DEF)?GHI`, the extractor
   * thought `DEF` was outside the optional group (hence "required"),
   * and used it as the prefilter — silently missing lines that
   * matched only `GHI`.
   *
   * Fix: `skipGroup` now calls `skipCharacterClass` when it sees
   * `[`, making classes opaque to group-depth tracking.
   */
  test.each([
    // Optional group containing a literal paren inside a class —
    // the content of the group is NOT required; only what follows is.
    ["(ABC[)]DEF)?GHI", "GHI"],
    ["(foo[)]bar)?baz", "baz"],
    ["(foo[(]bar)?baz", "baz"],
    ["(A[[]B)?CDE", "CDE"],
    ["(A[\\)]B)?CDE", "CDE"],
  ])("extracts the post-group literal when group contains a class with ( or )", (pattern, expected) => {
    expect(extractInnerLiteral(pattern, "")).toBe(expected);
  });

  test.each([
    ["(foo)bar", "bar"], // regular group + literal
    ["(foo)?bar", "bar"], // optional group + literal
    ["(abc)?xyz", "xyz"], // sanity check
    ["((foo))?bar", "bar"], // nested groups (skipGroup handles nesting)
  ])("control: regular groups still skip correctly", (pattern, expected) => {
    expect(extractInnerLiteral(pattern, "")).toBe(expected);
  });
});

describe("extractInnerLiteral — multi-char escape sequences (review followup)", () => {
  /**
   * Regression: `\x41` is a hex-escape encoding `A` — the literal
   * is 4 source chars long (`\`, `x`, `4`, `1`). The old extractor
   * always advanced escape sequences by 2, leaving `41` behind as
   * "literal" text. For `\x41foo` the extractor returned `"41foo"`
   * but the compiled regex matches `Afoo` — silent miss on the
   * gate (file containing `Afoo` but not `41foo` got skipped).
   *
   * Fix: `escapeSequenceLength` correctly computes the full length
   * of `\x..`, `\u....`, `\u{...}`, `\cX`, `\k<name>`, and
   * `\p{...}` / `\P{...}` sequences. The extractor now skips past
   * the WHOLE sequence and breaks the run (we don't try to decode
   * the escape into its character — conservative).
   */
  test.each([
    // Multi-char escapes — tail must NOT be extracted as literal
    ["\\x41foo", "foo"], // \x41 = A; skip + foo is the literal
    ["\\u0041foo", "foo"], // \u0041 = A
    ["\\u{1F600}foo", "foo"], // braced unicode
    ["\\cAfoo", "foo"], // control-A
    ["\\k<name>foo", "foo"], // named backref
    ["\\p{L}foo", "foo"], // Unicode property
    ["\\P{L}foo", "foo"], // negated Unicode property
    // Pre-escape literals still work (first-tied-longest)
    ["bar\\x41foo", "bar"], // both runs length 3; first wins
    ["longer_bar\\x41foo", "longer_bar"], // longer_bar > foo, longer wins
  ])("correctly skips multi-char escape %p → %p", (pattern, expected) => {
    expect(extractInnerLiteral(pattern, "")).toBe(expected);
  });
});
