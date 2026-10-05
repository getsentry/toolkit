/**
 * Minimal regex translation for user-supplied grep patterns.
 *
 * The init wizard's Mastra server sends regex sources written for
 * ripgrep (Rust regex syntax). JS `RegExp` covers almost everything
 * rg's default mode supports, with one real gap: **inline flag groups**
 * like `(?i)foo`. JS requires flags at RegExp construction time; it
 * can't flip them mid-pattern.
 *
 * This module bridges that gap by recognizing a leading `(?[imsU]+)`
 * or `(?[imsU]+:…)` and translating it to JS flags. Everything else
 * is passed to `new RegExp` unchanged — if it's not valid JS regex,
 * `ValidationError` is thrown with the engine's error message.
 *
 * ### Scope
 *
 * - Leading-only. `foo(?i)bar` (mid-pattern flag) stays as-is, which
 *   will typically fail to compile under JS and raise ValidationError.
 * - Flag mapping: `i` → `i`, `m` → `m`, `s` → `s`, `U` → `s` (rg's
 *   `U` == multiline-dotall is modeled by JS's `/s` flag).
 * - The scoped form `(?i:foo)bar` is translated as
 *   `{ cleaned: "foobar", flags: "i" }` — we widen the flag to the
 *   whole pattern because JS can't scope flags to a group. This is a
 *   documented limitation.
 */

import { ValidationError } from "../errors.js";

/**
 * Matches a leading inline-flag group at position 0 of a regex source.
 * Group 1 captures the flag letters. Group 2 captures `:` if the form
 * is the scoped `(?i:...)` variant, empty otherwise.
 *
 * We don't support uppercase-off flags (e.g. rg's `(?-i)`) — those are
 * rare and harder to translate cleanly; they raise ValidationError at
 * compile time if they sneak through.
 */
const INLINE_FLAG_RE = /^\(\?([imsU]+)(:|\))/;

/** Canonical JS-side flag alphabet we emit. Sorted for determinism. */
const VALID_JS_FLAGS = "imsu";

/**
 * Extract a leading inline-flag group from `source`.
 *
 * @returns `{ cleaned: pattern-with-flags-stripped, flags: jsFlagString }`.
 *   Callers combine `flags` with their own options (e.g.,
 *   `caseSensitive: false` → force `i`) and pass to `new RegExp`.
 *
 * When `source` has no leading flag group the function returns
 * `{ cleaned: source, flags: "" }` without inspecting the rest of the
 * pattern.
 */
export function extractInlineFlags(source: string): {
  cleaned: string;
  flags: string;
} {
  const match = INLINE_FLAG_RE.exec(source);
  if (!match) {
    return { cleaned: source, flags: "" };
  }
  const rawFlags = match[1] as string;
  const separator = match[2] as ":" | ")";
  const flags = translateFlags(rawFlags);

  if (separator === ")") {
    // (?i)pattern — strip the flag group entirely.
    return { cleaned: source.slice(match[0].length), flags };
  }
  // (?i:pattern)tail — unwrap the group, widening the flag to the
  // whole cleaned source. We have to find the matching closing paren,
  // respecting nested groups. A small state machine is enough; we
  // don't need to parse character classes specially because `)` inside
  // `[...]` doesn't close a group.
  const inner = unwrapScopedGroup(source, match[0].length);
  if (inner === null) {
    // Malformed group — leave source alone, report no flags. `new
    // RegExp` downstream will raise a ValidationError.
    return { cleaned: source, flags: "" };
  }
  return { cleaned: inner, flags };
}

/**
 * Unwrap `(?i:foo)bar` → `foobar`.
 *
 * `openIndex` points one past the closing `:` (start of `foo`). We
 * find the matching `)`, tracking parenthesis nesting and skipping
 * paired `[]` ranges. If we run off the end or the syntax is
 * malformed, return null so the caller falls back to "no translation."
 *
 * The branchy control flow is inherent to a tiny regex-syntax
 * tokenizer — we track three states (char class, paren depth, escape)
 * and each needs its own branch.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: regex tokenizer is inherently branchy
function unwrapScopedGroup(source: string, openIndex: number): string | null {
  let depth = 1;
  let i = openIndex;
  let inClass = false;
  while (i < source.length) {
    const ch = source.charCodeAt(i);
    // Backslash escapes the next char regardless of context.
    if (ch === CHAR_BACKSLASH) {
      i += 2;
      continue;
    }
    if (inClass) {
      if (ch === CHAR_CLOSE_BRACKET) {
        inClass = false;
      }
      i += 1;
      continue;
    }
    if (ch === CHAR_OPEN_BRACKET) {
      inClass = true;
      i += 1;
      continue;
    }
    if (ch === CHAR_OPEN_PAREN) {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === CHAR_CLOSE_PAREN) {
      depth -= 1;
      if (depth === 0) {
        // `foo` is source[openIndex..i]; tail is source[i+1..].
        return source.slice(openIndex, i) + source.slice(i + 1);
      }
    }
    i += 1;
  }
  return null;
}

const CHAR_BACKSLASH = "\\".charCodeAt(0);
const CHAR_OPEN_PAREN = "(".charCodeAt(0);
const CHAR_CLOSE_PAREN = ")".charCodeAt(0);
const CHAR_OPEN_BRACKET = "[".charCodeAt(0);
const CHAR_CLOSE_BRACKET = "]".charCodeAt(0);

/**
 * Translate rg-style inline flag letters to JS RegExp flag letters.
 * Unknown letters are dropped silently (the guard regex already
 * restricts the input to `[imsU]+`).
 */
function translateFlags(raw: string): string {
  const seen = new Set<string>();
  for (const letter of raw) {
    if (letter === "U") {
      // rg's U == dotall (--multiline-dotall). Model with JS /s.
      seen.add("s");
    } else if (letter === "i" || letter === "m" || letter === "s") {
      seen.add(letter);
    }
  }
  // Deterministic, RegExp-accepted order.
  return [...seen]
    .filter((f) => VALID_JS_FLAGS.includes(f))
    .sort()
    .join("");
}

/** Options for `compilePattern`. Both default to falsy. */
export type CompilePatternOptions = {
  /**
   * When false, forces the `i` flag regardless of inline flags.
   * Default: true (case-sensitive, matching `rg`'s default).
   */
  caseSensitive?: boolean;
  /** Force the `m` flag. Default: false. */
  multiline?: boolean;
};

/**
 * Compile a user-supplied pattern (string or RegExp) into a JS RegExp
 * suitable for grep.
 *
 * Pre-compiled regex input is trusted and returned unchanged —
 * callers that want `caseSensitive: false` on an existing RegExp
 * must reconstruct it.
 *
 * String input goes through `extractInlineFlags` + `new RegExp`.
 * The resulting regex is always `g`-less: grep tests one line at a
 * time, and the `g` flag's `lastIndex` state is a foot-gun in that
 * usage. Callers that want a `matchAll`-style regex should build
 * their own.
 *
 * Throws `ValidationError` on any compile-time regex error,
 * preserving the engine's message for user-facing diagnostics.
 */
export function compilePattern(
  pattern: string | RegExp,
  opts: CompilePatternOptions = {}
): RegExp {
  if (pattern instanceof RegExp) {
    return pattern;
  }
  const { cleaned, flags: inline } = extractInlineFlags(pattern);
  const flags = new Set<string>();
  for (const f of inline) {
    flags.add(f);
  }
  if (opts.caseSensitive === false) {
    flags.add("i");
  }
  if (opts.multiline) {
    flags.add("m");
  }
  const flagString = [...flags].sort().join("");
  try {
    return new RegExp(cleaned, flagString);
  } catch (error) {
    throw new ValidationError(
      `Invalid grep pattern: ${(error as Error).message}`,
      "pattern"
    );
  }
}

/**
 * Return a RegExp with the `g` flag set. If the input already has
 * `g`, it's returned as-is; otherwise we clone with `g` added.
 *
 * `content.matchAll(regex)` and `regex.exec(content)` with manual
 * `lastIndex` management both require `/g`. The grep engine iterates
 * matches on the whole file buffer, so we need to guarantee the flag
 * is present — `compilePattern` strips `g` by default (historically
 * grep tested one line at a time), so callers must pass through this
 * helper before a whole-buffer iteration.
 */
export function ensureGlobalFlag(regex: RegExp): RegExp {
  if (regex.flags.includes("g")) {
    return regex;
  }
  return new RegExp(regex.source, `${regex.flags}g`);
}

/**
 * Return a RegExp with the `m` (multiline) flag set so `^` and `$`
 * match at line boundaries inside a multi-line buffer.
 *
 * Why this exists: grep historically worked by splitting content on
 * `\n` and testing each line individually, which made `^` match the
 * start of any line by accident (each line was its own string). Now
 * that grep iterates the whole buffer via `matchAll`, patterns like
 * `^foo` need the `m` flag for equivalent semantics — without it,
 * `^` anchors to the buffer start and only matches the first line.
 */
export function ensureMultilineFlag(regex: RegExp): RegExp {
  if (regex.flags.includes("m")) {
    return regex;
  }
  return new RegExp(regex.source, `${regex.flags}m`);
}

/**
 * Compose `ensureGlobalFlag` + `ensureMultilineFlag` in one clone.
 * Single-pass avoids building a throwaway intermediate RegExp.
 */
export function ensureGlobalMultilineFlags(regex: RegExp): RegExp {
  const needsG = !regex.flags.includes("g");
  const needsM = !regex.flags.includes("m");
  if (!(needsG || needsM)) {
    return regex;
  }
  let flags = regex.flags;
  if (needsG) {
    flags += "g";
  }
  if (needsM) {
    flags += "m";
  }
  return new RegExp(regex.source, flags);
}
