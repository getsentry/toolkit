/**
 * Tests for src/lib/utils.ts
 *
 * Note: Core invariants (charset, idempotency, no leading/trailing/consecutive
 * hyphens) are tested via property-based tests in utils.property.test.ts.
 * These tests focus on specific inputs documented in JSDoc and regression
 * cases for the npm-scope / monorepo path bug (CLI-1XX).
 */

import { describe, expect, test } from "vitest";
import { isAllDigits, slugify } from "../../src/lib/utils.js";

describe("slugify", () => {
  describe("JSDoc examples (canonical alignment)", () => {
    test('slugify("My Cool App") → "my-cool-app"', () => {
      expect(slugify("My Cool App")).toBe("my-cool-app");
    });

    test('slugify("my-app") → "my-app"', () => {
      expect(slugify("my-app")).toBe("my-app");
    });

    test('slugify("Café Project") → "cafe-project"', () => {
      expect(slugify("Café Project")).toBe("cafe-project");
    });

    test('slugify("my_app") → "my_app"', () => {
      expect(slugify("my_app")).toBe("my_app");
    });
  });

  describe("npm scoped package names", () => {
    // Regression for the t3tools/web monorepo report — silently stripping
    // `/` produced unreadable mashups like `t3toolsweb` instead of a useful
    // `t3tools-web` slug.
    test('slugify("@t3tools/web") → "t3tools-web"', () => {
      expect(slugify("@t3tools/web")).toBe("t3tools-web");
    });

    test('slugify("@scope/pkg") → "scope-pkg"', () => {
      expect(slugify("@scope/pkg")).toBe("scope-pkg");
    });

    test('slugify("@my-org/some-package") → "my-org-some-package"', () => {
      expect(slugify("@my-org/some-package")).toBe("my-org-some-package");
    });
  });

  describe("monorepo path-style names", () => {
    test('slugify("packages/api") → "packages-api"', () => {
      expect(slugify("packages/api")).toBe("packages-api");
    });

    test('slugify("apps/api/web") → "apps-api-web"', () => {
      expect(slugify("apps/api/web")).toBe("apps-api-web");
    });

    test('slugify("apps\\\\api") → "apps-api"', () => {
      expect(slugify("apps\\api")).toBe("apps-api");
    });

    test('slugify("@scope/My App") → "scope-my-app"', () => {
      expect(slugify("@scope/My App")).toBe("scope-my-app");
    });
  });

  describe("edge cases", () => {
    test('slugify("") → ""', () => {
      expect(slugify("")).toBe("");
    });

    test('slugify("///") → ""', () => {
      expect(slugify("///")).toBe("");
    });

    test('slugify("@@@") → ""', () => {
      expect(slugify("@@@")).toBe("");
    });

    test('slugify("@/foo") → "foo"', () => {
      expect(slugify("@/foo")).toBe("foo");
    });

    test('slugify("///foo///") → "foo"', () => {
      expect(slugify("///foo///")).toBe("foo");
    });

    test('slugify("---foo---") → "foo"', () => {
      expect(slugify("---foo---")).toBe("foo");
    });

    test("collapses runs of slashes/spaces/hyphens", () => {
      expect(slugify("foo // bar -- baz")).toBe("foo-bar-baz");
    });
  });
});

describe("isAllDigits", () => {
  test("returns true for pure digits", () => {
    expect(isAllDigits("0")).toBe(true);
    expect(isAllDigits("123456")).toBe(true);
  });

  test("returns false for non-digit strings", () => {
    expect(isAllDigits("PROJECT-ABC")).toBe(false);
    expect(isAllDigits("abc123")).toBe(false);
    expect(isAllDigits("123abc")).toBe(false);
    expect(isAllDigits("")).toBe(false);
    expect(isAllDigits("12.3")).toBe(false);
    expect(isAllDigits("-1")).toBe(false);
    expect(isAllDigits(" 123")).toBe(false);
  });
});
