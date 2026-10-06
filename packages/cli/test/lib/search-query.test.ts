/**
 * Search Query Sanitization Tests
 *
 * Tests for `sanitizeQuery` and its OR→in-list rewriting logic
 * in `src/lib/search-query.ts`.
 *
 * Core invariants (round-trips, random inputs) are tested via
 * property-based tests in `search-query.property.test.ts`.
 * These tests focus on specific rewrite cases, edge cases,
 * and error messages.
 */

import { describe, expect, test } from "vitest";
import { ValidationError } from "../../src/lib/errors.js";
import { __testing, sanitizeQuery } from "../../src/lib/search-query.js";

const { normalizeQuery, transformUnquoted } = __testing;

// ---------------------------------------------------------------------------
// Passthrough (no operators)
// ---------------------------------------------------------------------------

describe("sanitizeQuery: passthrough", () => {
  test("passes through a simple qualifier query unchanged", () => {
    expect(sanitizeQuery("is:unresolved level:error")).toBe(
      "is:unresolved level:error"
    );
  });

  test("passes through a plain text query unchanged", () => {
    expect(sanitizeQuery("timeout crash")).toBe("timeout crash");
  });

  test("does not match 'and'/'or' as substrings of normal words", () => {
    expect(sanitizeQuery("sandbox handler")).toBe("sandbox handler");
    expect(sanitizeQuery("order error")).toBe("order error");
  });

  test("does not match OR inside qualifier values (tag:OR)", () => {
    expect(sanitizeQuery("tag:OR")).toBe("tag:OR");
  });

  test("does not match AND inside qualifier values (tag:AND)", () => {
    expect(sanitizeQuery("tag:AND")).toBe("tag:AND");
  });

  test("does not match OR inside quoted strings", () => {
    expect(sanitizeQuery('message:"error OR timeout"')).toBe(
      'message:"error OR timeout"'
    );
  });

  test("does not match AND inside quoted strings", () => {
    expect(sanitizeQuery('title:"error AND timeout"')).toBe(
      'title:"error AND timeout"'
    );
  });

  test("does not match OR in qualifier values with more context", () => {
    expect(sanitizeQuery("is:unresolved tag:OR_something")).toBe(
      "is:unresolved tag:OR_something"
    );
  });
});

// ---------------------------------------------------------------------------
// AND stripping
// ---------------------------------------------------------------------------

describe("sanitizeQuery: AND", () => {
  test("strips AND and returns cleaned query", () => {
    expect(sanitizeQuery("error AND timeout")).toBe("error timeout");
  });

  test("strips multiple AND operators", () => {
    expect(sanitizeQuery("error AND timeout AND crash")).toBe(
      "error timeout crash"
    );
  });

  test("handles case-insensitive AND", () => {
    expect(sanitizeQuery("error And timeout")).toBe("error timeout");
    expect(sanitizeQuery("error and timeout")).toBe("error timeout");
  });

  test("strips AND with qualifiers", () => {
    expect(sanitizeQuery("is:unresolved AND level:error")).toBe(
      "is:unresolved level:error"
    );
  });

  test("handles leading AND", () => {
    expect(sanitizeQuery("AND error timeout")).toBe("error timeout");
  });

  test("handles trailing AND", () => {
    expect(sanitizeQuery("error timeout AND")).toBe("error timeout");
  });
});

// ---------------------------------------------------------------------------
// project:<digits> → project_id
// ---------------------------------------------------------------------------

describe("sanitizeQuery: numeric project:", () => {
  test("rewrites a numeric project: filter to project_id", () => {
    expect(
      sanitizeQuery("project:4511730126487632 environment:vercel-production")
    ).toBe("project_id:4511730126487632 environment:vercel-production");
  });

  test("rewrites a numeric project: in-list", () => {
    expect(
      sanitizeQuery("is:unresolved project:[4505521413357568,6442225]")
    ).toBe("is:unresolved project_id:[4505521413357568,6442225]");
  });

  test("rewrites a negated numeric project: filter", () => {
    expect(sanitizeQuery("!project:1423462 lastSeen:-1h")).toBe(
      "!project_id:1423462 lastSeen:-1h"
    );
  });

  test("leaves project slugs alone", () => {
    expect(sanitizeQuery("project:frontend is:unresolved")).toBe(
      "project:frontend is:unresolved"
    );
  });

  test("leaves project_id numeric filters alone", () => {
    expect(sanitizeQuery("project_id:4511730126487632")).toBe(
      "project_id:4511730126487632"
    );
  });

  test("leaves namespaced project keys alone", () => {
    expect(sanitizeQuery("bolt.project_id:70054175")).toBe(
      "bolt.project_id:70054175"
    );
    expect(sanitizeQuery("bolt.project:70054175")).toBe(
      "bolt.project:70054175"
    );
  });

  test("does not rewrite a numeric id inside a quoted value", () => {
    expect(sanitizeQuery('message:"project:4511730126487632"')).toBe(
      'message:"project:4511730126487632"'
    );
  });

  test("does not rewrite mixed slug/numeric in-lists", () => {
    expect(sanitizeQuery("project:[frontend,6442225]")).toBe(
      "project:[frontend,6442225]"
    );
  });

  test("rewrites numeric project: then OR in one step", () => {
    expect(sanitizeQuery("project:123 OR project:456")).toBe(
      "project_id:[123,456]"
    );
  });
});

// ---------------------------------------------------------------------------
// OR → in-list rewrites (successful)
// ---------------------------------------------------------------------------

describe("sanitizeQuery: OR → in-list (success)", () => {
  test("rewrites same-key qualifier OR to in-list", () => {
    expect(sanitizeQuery("level:error OR level:warning")).toBe(
      "level:[error,warning]"
    );
  });

  test("rewrites OR chain of 3+ same-key qualifiers", () => {
    expect(sanitizeQuery("level:error OR level:warning OR level:fatal")).toBe(
      "level:[error,warning,fatal]"
    );
  });

  test("preserves surrounding tokens", () => {
    expect(sanitizeQuery("is:unresolved level:error OR level:warning")).toBe(
      "is:unresolved level:[error,warning]"
    );
  });

  test("preserves surrounding tokens on both sides", () => {
    expect(
      sanitizeQuery("is:unresolved level:error OR level:warning firstSeen:-24h")
    ).toBe("is:unresolved level:[error,warning] firstSeen:-24h");
  });

  test("rewrites quoted values", () => {
    expect(
      sanitizeQuery('message:"pool exhaustion" OR message:"connection timeout"')
    ).toBe('message:["pool exhaustion","connection timeout"]');
  });

  test("merges existing in-list value with plain value", () => {
    expect(sanitizeQuery("level:[error,warning] OR level:fatal")).toBe(
      "level:[error,warning,fatal]"
    );
  });

  test("merges two in-list values", () => {
    expect(sanitizeQuery("level:[error] OR level:[warning,fatal]")).toBe(
      "level:[error,warning,fatal]"
    );
  });

  test("rewrites multiple independent OR groups", () => {
    expect(
      sanitizeQuery(
        "level:error OR level:warning browser:Chrome OR browser:Firefox"
      )
    ).toBe("level:[error,warning] browser:[Chrome,Firefox]");
  });

  test("handles case-insensitive OR", () => {
    expect(sanitizeQuery("level:error or level:warning")).toBe(
      "level:[error,warning]"
    );
    expect(sanitizeQuery("level:error Or level:warning")).toBe(
      "level:[error,warning]"
    );
  });

  test("handles mixed AND and OR", () => {
    expect(
      sanitizeQuery("is:unresolved AND level:error OR level:warning")
    ).toBe("is:unresolved level:[error,warning]");
  });

  test("preserves key casing from first token", () => {
    expect(sanitizeQuery("Level:error OR level:warning")).toBe(
      "Level:[error,warning]"
    );
  });

  test("handles leading OR (stray)", () => {
    expect(sanitizeQuery("OR level:error OR level:warning")).toBe(
      "level:[error,warning]"
    );
  });

  test("handles trailing OR (stray)", () => {
    expect(sanitizeQuery("level:error OR level:warning OR")).toBe(
      "level:[error,warning]"
    );
  });
});

// ---------------------------------------------------------------------------
// OR → throws (cannot rewrite)
// ---------------------------------------------------------------------------

describe("sanitizeQuery: OR → throws", () => {
  test("throws for free-text OR", () => {
    expect(() => sanitizeQuery("error OR timeout")).toThrow(ValidationError);
  });

  test("throws for different keys across OR", () => {
    expect(() => sanitizeQuery("level:error OR assigned:me")).toThrow(
      ValidationError
    );
  });

  test("throws for is: qualifier (not supported with in-list)", () => {
    expect(() => sanitizeQuery("is:unresolved OR is:resolved")).toThrow(
      ValidationError
    );
  });

  test("throws for has: qualifier (not supported with in-list)", () => {
    expect(() => sanitizeQuery("has:user OR has:email")).toThrow(
      ValidationError
    );
  });

  test("throws for negated qualifiers", () => {
    expect(() => sanitizeQuery("!level:error OR !level:warning")).toThrow(
      ValidationError
    );
  });

  test("throws for wildcards in values", () => {
    expect(() => sanitizeQuery("message:*error* OR message:*timeout*")).toThrow(
      ValidationError
    );
  });

  test("throws for comparison operator values (not valid in in-list)", () => {
    expect(() => sanitizeQuery("age:>24h OR age:>7d")).toThrow(ValidationError);
    expect(() => sanitizeQuery("times_seen:>100 OR times_seen:>200")).toThrow(
      ValidationError
    );
    expect(() =>
      sanitizeQuery("span.duration:>=1s OR span.duration:>=500ms")
    ).toThrow(ValidationError);
    expect(() =>
      sanitizeQuery("firstSeen:<=2024-01-01 OR firstSeen:<=2024-06-01")
    ).toThrow(ValidationError);
  });

  test("throws for mixed free-text and qualifier OR", () => {
    expect(() => sanitizeQuery("is:unresolved error OR timeout")).toThrow(
      ValidationError
    );
  });

  test("error includes field and rewritable example", () => {
    try {
      sanitizeQuery("error OR timeout");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const ve = error as ValidationError;
      expect(ve.field).toBe("query");
      expect(ve.message).toContain("OR");
      expect(ve.message).toContain("level:error OR level:warning");
      expect(ve.message).toContain("key:[val1,val2]");
    }
  });

  test("throws for OR with qualifiers mixed in (real-world query 1)", () => {
    // From CLI-16J: AI agent tried free-text OR
    expect(() =>
      sanitizeQuery(
        "is:unresolved pool exhaustion OR connection timeout OR connection terminated"
      )
    ).toThrow(ValidationError);
  });

  test("throws for parenthesized groups across OR boundary", () => {
    expect(() =>
      sanitizeQuery("(level:error assigned:me) OR (level:warning assigned:bob)")
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Paren group handling
// ---------------------------------------------------------------------------

describe("sanitizeQuery: paren groups", () => {
  test("throws for OR inside paren groups", () => {
    expect(() => sanitizeQuery("(level:error OR level:warning)")).toThrow(
      ValidationError
    );
  });

  test("throws for OR inside paren groups with surrounding filters", () => {
    expect(() =>
      sanitizeQuery("(level:error OR level:warning) assigned:me")
    ).toThrow(ValidationError);
  });

  test("passes through paren groups without boolean operators", () => {
    expect(sanitizeQuery("(level:error) assigned:me")).toBe(
      "(level:error) assigned:me"
    );
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("sanitizeQuery: edge cases", () => {
  test("throws for all-OR input", () => {
    expect(() => sanitizeQuery("OR OR OR")).toThrow(ValidationError);
  });

  test("passes through malformed queries (unmatched parens)", () => {
    // Unmatched parens cause PEG parse failure — pass through to API
    expect(sanitizeQuery("(level:error")).toBe("(level:error");
    expect(sanitizeQuery("level:error)")).toBe("level:error)");
  });

  test("throws for OR in paren group even with rewritable top-level OR", () => {
    expect(() =>
      sanitizeQuery("level:error OR level:warning (a:1 OR a:2)")
    ).toThrow(ValidationError);
  });

  test("passes through AND inside paren groups unchanged", () => {
    // AND inside parens can't be stripped from opaque raw text — pass through
    expect(sanitizeQuery("(error AND timeout)")).toBe("(error AND timeout)");
  });

  test("rejects wildcard values in existing in-list during merge", () => {
    expect(() => sanitizeQuery("key:[*err*] OR key:val")).toThrow(
      ValidationError
    );
  });
});

describe("normalizeQuery: pre-parse text normalization", () => {
  describe("mismatched brackets", () => {
    test("fixes wrong closing delimiter ) → ]", () => {
      expect(normalizeQuery("status_code:[401,403,429,500,)")).toBe(
        "status_code:[401,403,429,500]"
      );
    });

    test("fixes trailing comma + wrong delimiter combined", () => {
      expect(normalizeQuery("error.http.status_code:[401,403,429,500,)")).toBe(
        "error.http.status_code:[401,403,429,500]"
      );
    });

    test("repairs within a longer query", () => {
      expect(
        normalizeQuery(
          "is:unresolved error.http.status_code:[401,403,429,500,)"
        )
      ).toBe("is:unresolved error.http.status_code:[401,403,429,500]");
    });
  });

  describe("trailing list commas", () => {
    test("strips trailing comma in in-list filter", () => {
      expect(normalizeQuery("level:[error,warning,]")).toBe(
        "level:[error,warning]"
      );
    });

    test("strips trailing comma with spaces", () => {
      expect(normalizeQuery("level:[error, warning, ]")).toBe(
        "level:[error, warning]"
      );
    });
  });

  describe("passthrough", () => {
    test("leaves valid queries unchanged", () => {
      expect(normalizeQuery("level:[error,warning]")).toBe(
        "level:[error,warning]"
      );
    });

    test("leaves non-list queries unchanged", () => {
      expect(normalizeQuery("is:unresolved level:error")).toBe(
        "is:unresolved level:error"
      );
    });

    test("leaves empty query unchanged", () => {
      expect(normalizeQuery("")).toBe("");
    });

    test("does not cross filter boundaries", () => {
      // Two filters — each should be repaired independently
      expect(normalizeQuery("a:[1,) b:[2,)")).toBe("a:[1] b:[2]");
    });
  });

  describe("quote awareness", () => {
    test("does not modify bracket content inside double quotes", () => {
      expect(normalizeQuery('message:"error [500,] found"')).toBe(
        'message:"error [500,] found"'
      );
    });

    test("does not modify mismatched brackets inside quotes", () => {
      expect(normalizeQuery('message:"codes [401,403,)"')).toBe(
        'message:"codes [401,403,)"'
      );
    });

    test("repairs unquoted filter but preserves quoted content", () => {
      expect(
        normalizeQuery('level:[error,warning,) message:"[trailing,]"')
      ).toBe('level:[error,warning] message:"[trailing,]"');
    });

    test("handles multiple quoted regions", () => {
      expect(normalizeQuery('a:"[1,]" level:[x,) b:"[2,]"')).toBe(
        'a:"[1,]" level:[x] b:"[2,]"'
      );
    });

    test("handles escaped quotes inside quoted strings", () => {
      // The input has backslash-escaped quotes inside the quoted value:
      // message:"say \"hello [500,]\"" level:[a,]
      const input = 'message:"say \\"hello [500,]\\"" level:[a,]';
      const expected = 'message:"say \\"hello [500,]\\"" level:[a]';
      expect(normalizeQuery(input)).toBe(expected);
    });
  });
});

describe("transformUnquoted", () => {
  const upper = (s: string) => s.toUpperCase();

  test("transforms entire string when no quotes present", () => {
    expect(transformUnquoted("hello world", upper)).toBe("HELLO WORLD");
  });

  test("preserves quoted segments", () => {
    expect(transformUnquoted('hello "world" foo', upper)).toBe(
      'HELLO "world" FOO'
    );
  });

  test("handles string that is entirely quoted", () => {
    expect(transformUnquoted('"hello world"', upper)).toBe('"hello world"');
  });

  test("handles adjacent quoted segments", () => {
    expect(transformUnquoted('"a""b"', upper)).toBe('"a""b"');
  });

  test("handles empty string", () => {
    expect(transformUnquoted("", upper)).toBe("");
  });
});

describe("sanitizeQuery: normalization integration", () => {
  test("normalizes trailing comma before ] (pre-parse)", () => {
    // Trailing comma is stripped before PEG parsing
    const result = sanitizeQuery("level:[error,warning,]");
    expect(result).toBe("level:[error,warning]");
  });

  test("normalizes wrong closing delimiter ) (pre-parse)", () => {
    const result = sanitizeQuery("level:[error,warning,)");
    expect(result).toBe("level:[error,warning]");
  });

  test("normalizes complex filter in longer query", () => {
    const result = sanitizeQuery(
      "is:unresolved error.http.status_code:[401,403,429,500,)"
    );
    expect(result).toBe(
      "is:unresolved error.http.status_code:[401,403,429,500]"
    );
  });

  test("unfixable malformed query passes through to API", () => {
    const result = sanitizeQuery("((( broken");
    expect(result).toBe("((( broken");
  });
});
