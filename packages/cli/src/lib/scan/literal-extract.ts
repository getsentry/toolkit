/**
 * Conservative literal-prefix extractor for grep's file-level gate.
 *
 * Walks a regex source looking for the longest contiguous run of
 * non-metacharacter literal bytes that every match must contain.
 * When found, `grep.ts::readAndGrep` checks whether the file
 * contains that literal via the vastly cheaper
 * `String.prototype.indexOf` and skips the regex engine entirely on
 * files where it doesn't appear — ripgrep's central perf trick,
 * adapted to pure JS as a file-level gate.
 *
 * The gate is deliberately file-level only. Per-line or per-match
 * use of the literal would introduce subtle correctness failures
 * for patterns whose match spans newlines (e.g., `foo\sbar`) or
 * whose compiled form differs from the user's source (e.g.,
 * `\x41foo` decodes to `Afoo`). Keeping the gate at file-level
 * sidesteps all of that: the regex engine still does the actual
 * matching on files that pass.
 *
 * ### Extraction rules (conservative; safety over completeness)
 *
 * A literal is "safe" if every match of the regex must contain that
 * exact byte sequence. We bail out on anything that could produce
 * matches without the candidate literal:
 *
 * - Top-level alternation (`foo|bar`): any branch could match, no
 *   single literal is required. v1 rejects these; v2 could return a
 *   Set and probe with multiple `indexOf` calls.
 * - Character class `[abc]`: the class matches any of its members;
 *   no single byte is required.
 * - Capturing / non-capturing group `(foo)`, `(?:foo)`: the content
 *   MIGHT be useful but its enclosure complicates extraction; v1
 *   extracts outside groups only.
 * - Quantifier `?`, `*`, `+`, `{0,n}`: the quantified atom may not
 *   appear. Drop the preceding character and break the current run.
 *   (For `{1,n}` and `{n,}` with n≥1 the preceding atom IS required,
 *   but v1 doesn't distinguish — all quantifiers break the run.)
 * - Escape sequences `\d`, `\w`, `\s`, etc.: not literal; break the
 *   run. Escaped literal chars (`\.`, `\/`, `\(`) could be included
 *   but v1 takes the safe path and breaks the run on any `\`.
 * - Anchors `^`, `$`: not bytes in the match; break the run without
 *   invalidating the prefix/suffix.
 * - Lookaround `(?=…)`, `(?!…)`, `(?<=…)`, `(?<!…)`: the assertion's
 *   content isn't consumed. Negative lookarounds can invalidate
 *   literal-extraction-by-greedy-scan. v1 bails on any `(?…)`.
 *
 * ### Thresholds
 *
 * Returns null if the longest run is:
 * - Shorter than `MIN_LITERAL_LEN` (3 by default). Single/double
 *   characters match everywhere and the indexOf scan costs more
 *   than the regex engine saves.
 * - Made entirely of whitespace or punctuation (same reason).
 *
 * ### Gate effectiveness
 *
 * When the extracted literal is rare (e.g., `Sentry.init` → `Sentry`),
 * the file-level gate rejects typically 95%+ of files in a large
 * tree. When the literal is common (e.g., `\sfoo\s` → `foo`), fewer
 * files are rejected, but the regex engine still only runs on files
 * where a match is actually possible — the gate is always at least
 * weakly useful.
 *
 * When the pattern is ITSELF a pure literal (no metachars, just
 * bytes), the extractor returns the whole pattern. The gate treats
 * it the same as any other literal — boolean `indexOf` presence
 * check, then fall through to the regex engine. V8's regex engine
 * handles pure-literal patterns efficiently, so no special-case
 * routing is warranted.
 */

/**
 * Minimum length for an extracted literal. Shorter strings match too
 * frequently to be worth the prefilter overhead.
 */
const MIN_LITERAL_LEN = 3;

/** Metacharacters that break literal runs. */
const META_CHARS = new Set([
  ".",
  "^",
  "$",
  "|",
  "?",
  "*",
  "+",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "\\",
]);

/** Quantifiers that mean "the preceding atom may not appear." */
const QUANTIFIER_CHARS = new Set(["?", "*", "+"]);

/** All-whitespace guard for extracted literals. */
const ALL_WHITESPACE_RE = /^\s+$/;

/** All-whitespace-or-punctuation guard (rejects literals that match everywhere). */
const ALL_PUNCTUATION_RE = /^[\s\p{P}]+$/u;

/**
 * Escape sequences where the following char represents itself as a
 * literal byte (e.g. `\.` is a literal dot). These are the escaped
 * metacharacters — everything in `META_CHARS` plus `/` (which is
 * common in regex literals) and `\\` (escaped backslash).
 *
 * Sequences NOT in this set (like `\d`, `\w`, `\b`, `\t`) are
 * character classes or anchors, not literals, and break the run.
 */
const ESCAPED_LITERAL_CHARS = new Set([
  ".",
  "^",
  "$",
  "|",
  "?",
  "*",
  "+",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "\\",
  "/",
]);

/**
 * Extract a conservative literal prefix/substring from a regex
 * pattern. Returns null if no safe literal of `MIN_LITERAL_LEN` or
 * more characters can be extracted.
 *
 * Honors the `i` flag by lower-casing the literal — the caller
 * should also lower-case the haystack before searching.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: single-pass parser over regex source; all branches are guarded cases
export function extractInnerLiteral(
  source: string,
  flags: string
): string | null {
  // Quick-reject: top-level alternation. Walk once checking for `|`
  // outside brackets/parens (rough; better than parsing the whole
  // regex). A false positive here just means we skip the prefilter —
  // no correctness issue.
  if (hasTopLevelAlternation(source)) {
    return null;
  }

  let best = "";
  let current = "";
  let i = 0;

  const commit = (): void => {
    if (current.length > best.length) {
      best = current;
    }
    current = "";
  };

  while (i < source.length) {
    const c = source[i];

    if (c === "\\") {
      // Escape sequence. Three cases:
      //
      // 1. Escaped metacharacter (`\.`, `\/`, `\\`, etc.) — represents
      //    a literal byte, extends the current run.
      //
      // 2. Multi-char escape sequences (`\x41`, `\u0041`, `\u{1F600}`,
      //    `\cA`, `\k<name>`) — these produce SPECIFIC characters but
      //    the tail (e.g., `41` after `\x`) is NOT a literal run
      //    extender. Skip past the whole sequence and break the run.
      //    (A future pass could decode the escape and contribute its
      //    char to the run — complex, bail-safe for v1.)
      //
      // 3. Character-class escapes (`\d`, `\w`, `\b`, `\t`, etc.) —
      //    not literals. Advance 2 and break the run.
      const next = source[i + 1];
      if (next === undefined) {
        // Trailing `\` — malformed, bail on this run.
        commit();
        i += 2;
        continue;
      }
      if (ESCAPED_LITERAL_CHARS.has(next)) {
        // Case 1: `\.`, `\/`, `\\` etc. — extends the literal run.
        current += next;
        i += 2;
        continue;
      }
      // Case 2 / 3: compute how far to advance past the whole escape
      // sequence. Anything we don't recognize defaults to 2 (single-
      // char escape like `\d`, `\b`, `\t`, `\n`, `\r`, `\s`, `\W`, etc.).
      commit();
      i += escapeSequenceLength(source, i);
      continue;
    }

    if (c === "[") {
      // Character class — content isn't a single required literal.
      commit();
      i = skipCharacterClass(source, i);
      continue;
    }

    if (c === "(") {
      // Group or lookaround — skip. v1 doesn't peek inside.
      commit();
      i = skipGroup(source, i);
      continue;
    }

    if (QUANTIFIER_CHARS.has(c ?? "") || c === "{") {
      // The preceding character was quantified — it may not appear
      // in the actual match. Drop it from the current run.
      if (current.length > 0) {
        current = current.slice(0, -1);
      }
      commit();
      // Advance past the quantifier (and past `{n,m}` if present).
      i += 1;
      if (c === "{") {
        while (i < source.length && source[i] !== "}") {
          i += 1;
        }
        i += 1; // past the `}`
      } else if (source[i] === "?") {
        // Lazy quantifier `??`, `*?`, `+?`
        i += 1;
      }
      continue;
    }

    if (META_CHARS.has(c ?? "")) {
      // Other metacharacter (`.`, `^`, `$`): break the run but don't
      // drop anything from current.
      commit();
      i += 1;
      continue;
    }

    // Literal byte — extend the current run.
    current += c;
    i += 1;
  }
  commit();

  if (best.length < MIN_LITERAL_LEN) {
    return null;
  }
  if (ALL_WHITESPACE_RE.test(best) || ALL_PUNCTUATION_RE.test(best)) {
    // All whitespace or all punctuation — too high a match rate.
    return null;
  }

  return flags.includes("i") ? best.toLowerCase() : best;
}

/**
 * Is there a top-level `|` (alternation) in the pattern?
 *
 * Character classes `[...]` are OPAQUE to this scan — their interior
 * contains literal bytes (including literal `(`, `)`, `|`) that must
 * not be interpreted as grouping or alternation metacharacters. We
 * skip the whole class in one step when `[` is seen.
 */
function hasTopLevelAlternation(source: string): boolean {
  let depthParen = 0;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      // Skip the whole escape sequence. An escaped char is never a
      // grouping/alternation metacharacter, and multi-char escapes
      // like `\x41`, `\u0041`, `\k<name>` have tails that must not
      // be mistaken for `|`, `(`, `)`.
      i += escapeSequenceLength(source, i);
      continue;
    }
    if (c === "[") {
      // Character class: content is opaque. Skip past the first
      // unescaped `]` (classes are NOT nestable — `[[]` matches a
      // single literal `[`). This prevents `[(]` from being
      // mistaken for an opening paren and corrupting `depthParen`,
      // which would hide a subsequent top-level `|` alternation.
      i = skipCharacterClass(source, i);
      continue;
    }
    if (c === "(") {
      depthParen += 1;
    } else if (c === ")") {
      depthParen -= 1;
    } else if (c === "|" && depthParen === 0) {
      return true;
    }
    i += 1;
  }
  return false;
}

/**
 * Compute the total length (in source characters) of an escape
 * sequence starting at `i` (where `source[i] === "\\"`). Handles:
 *
 * - `\xHH` — hex byte (4 source chars)
 * - `\uHHHH` — unicode BMP code point (6 source chars)
 * - `\u{H+}` — braced unicode code point (variable length)
 * - `\cX` — control char (3 source chars)
 * - `\k<name>` — named backref (variable length)
 * - `\p{Name}`, `\P{Name}` — Unicode property escape (variable)
 * - Anything else (single-char escape like `\d`, `\w`, `\b`, `\t`,
 *   escaped metachars, numeric backrefs) — 2 source chars.
 *
 * Used by the extractor to correctly skip past the ENTIRE escape
 * sequence so its tail characters don't get misinterpreted as
 * literal bytes. `\x41foo` must advance 4 chars past `\x41`, not
 * just 2 past `\x` — otherwise the extractor sees `41foo` as
 * literals and wrongly extracts `"41foo"`.
 */
function escapeSequenceLength(source: string, i: number): number {
  const next = source[i + 1];
  if (next === undefined) {
    return 2;
  }
  // Braced: `\u{H+}`, `\p{...}`, `\P{...}` — consume until closing `}`.
  if ((next === "u" || next === "p" || next === "P") && source[i + 2] === "{") {
    const close = source.indexOf("}", i + 3);
    if (close === -1) {
      return 2;
    }
    return close - i + 1;
  }
  // Fixed-width multi-char escapes.
  if (next === "x") {
    return 4; // \x + 2 hex digits
  }
  if (next === "u") {
    return 6; // \u + 4 hex digits
  }
  if (next === "c") {
    return 3; // \c + 1 control char
  }
  // Named backref: `\k<name>`.
  if (next === "k" && source[i + 2] === "<") {
    const close = source.indexOf(">", i + 3);
    if (close === -1) {
      return 2;
    }
    return close - i + 1;
  }
  // Default: single-char escape (`\d`, `\w`, `\b`, `\t`, etc., or
  // a single-digit numeric backref `\1`).
  return 2;
}

/**
 * Advance past a character class `[...]` starting at `i`
 * (where `source[i] === "["`). Unlike parens/groups, `[` inside
 * `[...]` is NOT nestable — it's a literal `[` character. Only the
 * first unescaped `]` closes the class.
 *
 * Handles escape sequences (`\]` stays inside the class).
 *
 * Returns the index just past the closing `]`, or `source.length` if
 * the class is unterminated (malformed regex; caller should still
 * advance past it).
 */
function skipCharacterClass(source: string, i: number): number {
  let j = i + 1;
  while (j < source.length) {
    const c = source[j];
    if (c === "\\") {
      j += escapeSequenceLength(source, j);
      continue;
    }
    if (c === "]") {
      return j + 1;
    }
    j += 1;
  }
  return j;
}

/**
 * Advance past a balanced `(...)` group starting at `i` (where
 * `source[i] === "("`). Handles nested groups and escaped chars.
 * Returns the index just past the matching `)`.
 *
 * CRITICAL: `[...]` character classes are OPAQUE to group-depth
 * tracking. A `)` or `(` inside a class is a literal byte, not a
 * grouping metacharacter, and MUST NOT change depth. Without this,
 * a pattern like `(foo[)]bar)?baz` would exit the group at the `)`
 * inside `[)]`, making the extractor treat `bar` as top-level and
 * missing the fact that the whole group is optional.
 *
 * NOTE: Regex character classes are NOT nestable — `[[]` is a
 * class containing a literal `[`, per regex spec.
 */
function skipGroup(source: string, i: number): number {
  let depth = 1;
  let j = i + 1;
  while (j < source.length && depth > 0) {
    const c = source[j];
    if (c === "\\") {
      j += escapeSequenceLength(source, j);
      continue;
    }
    if (c === "[") {
      // Skip the whole character class — `(` and `)` inside it
      // are literal and must not affect group depth.
      j = skipCharacterClass(source, j);
      continue;
    }
    if (c === "(") {
      depth += 1;
    } else if (c === ")") {
      depth -= 1;
    }
    j += 1;
  }
  return j;
}
