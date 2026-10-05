/**
 * Tests for `resolveOAuthScopeString` — the helper that maps `auth login`
 * scope-selection flags (--read-only / --scope) to the space-joined scope
 * string sent in the OAuth device-code request.
 *
 * Core invariants (default = full set, read-only subset, explicit-scope
 * round-trips) are covered with property-based tests; the remaining cases
 * document specific error behavior and edge cases.
 */

import {
  constantFrom,
  assert as fcAssert,
  property,
  uniqueArray,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { SENTRY_SCOPES } from "../../src/lib/api-scope.js";
import { ValidationError } from "../../src/lib/errors.js";
import { OAUTH_SCOPES, resolveOAuthScopeString } from "../../src/lib/oauth.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

const knownScopeArb = constantFrom(...SENTRY_SCOPES);

describe("resolveOAuthScopeString", () => {
  test("default scopes include Team Admin for project creation", () => {
    expect(OAUTH_SCOPES).toContain("team:admin");
  });

  test("default (no selection) returns the full OAUTH_SCOPES set", () => {
    expect(resolveOAuthScopeString()).toBe(OAUTH_SCOPES.join(" "));
    expect(resolveOAuthScopeString({})).toBe(OAUTH_SCOPES.join(" "));
  });

  test("readOnly returns only :read scopes from OAUTH_SCOPES", () => {
    const result = resolveOAuthScopeString({ readOnly: true }).split(" ");
    expect(result.length).toBeGreaterThan(0);
    for (const scope of result) {
      expect(scope.endsWith(":read")).toBe(true);
    }
    // Every read scope the CLI requests is present.
    const expected = OAUTH_SCOPES.filter((s) => s.endsWith(":read"));
    expect(result).toEqual(expected);
  });

  test("readOnly never includes write or admin scopes", () => {
    const result = resolveOAuthScopeString({ readOnly: true });
    expect(result).not.toContain(":write");
    expect(result).not.toContain(":admin");
  });

  test("readOnly is ignored when explicit scopes are provided", () => {
    // `scopes` takes precedence over `readOnly`.
    expect(
      resolveOAuthScopeString({ readOnly: true, scopes: ["project:write"] })
    ).toBe("project:write");
  });

  test("explicit scopes preserve first-seen order and lowercase", () => {
    expect(
      resolveOAuthScopeString({ scopes: ["ORG:READ", "project:read"] })
    ).toBe("org:read project:read");
  });

  test("explicit scopes are de-duplicated", () => {
    expect(
      resolveOAuthScopeString({
        scopes: ["org:read", "project:read", "org:read"],
      })
    ).toBe("org:read project:read");
  });

  test("blank entries are skipped", () => {
    expect(resolveOAuthScopeString({ scopes: ["  ", "org:read", ""] })).toBe(
      "org:read"
    );
  });

  test("throws ValidationError with field 'scope' for unknown scope", () => {
    try {
      resolveOAuthScopeString({ scopes: ["not:a:scope"] });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe("scope");
      expect((error as ValidationError).message).toContain("not:a:scope");
    }
  });

  test("throws ValidationError when scopes resolve to empty", () => {
    expect(() => resolveOAuthScopeString({ scopes: [] })).toThrow(
      ValidationError
    );
    expect(() => resolveOAuthScopeString({ scopes: ["", "   "] })).toThrow(
      ValidationError
    );
  });
});

describe("property: resolveOAuthScopeString", () => {
  test("any subset of SENTRY_SCOPES round-trips to its space-joined form", () => {
    fcAssert(
      property(uniqueArray(knownScopeArb, { minLength: 1 }), (scopes) => {
        const result = resolveOAuthScopeString({ scopes });
        // Order preserved, lowercase, space-joined.
        expect(result).toBe(scopes.map((s) => s.toLowerCase()).join(" "));
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("any single known scope is accepted", () => {
    fcAssert(
      property(knownScopeArb, (scope) => {
        expect(resolveOAuthScopeString({ scopes: [scope] })).toBe(scope);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
