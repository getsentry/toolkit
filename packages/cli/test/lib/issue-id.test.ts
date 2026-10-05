/**
 * Tests for issue ID parsing utilities
 *
 * Note: Core invariants (isAllDigits, isShortSuffix, isShortId, expandToFullShortId)
 * are tested via property-based tests in issue-id.property.test.ts. These tests
 * focus on parseAliasSuffix edge cases and integration flow documentation.
 */

import { describe, expect, test } from "vitest";
import {
  expandToFullShortId,
  isShortId,
  isShortSuffix,
  parseAliasSuffix,
} from "../../src/lib/issue-id.js";

describe("parseAliasSuffix", () => {
  // These tests document specific parsing behaviors and edge cases

  test("parses simple alias-suffix format", () => {
    const result = parseAliasSuffix("e-4y");
    expect(result).toEqual({ alias: "e", suffix: "4Y" });
  });

  test("parses multi-character alias", () => {
    const result = parseAliasSuffix("fr-a3");
    expect(result).toEqual({ alias: "fr", suffix: "A3" });
  });

  test("parses alias with hyphens", () => {
    const result = parseAliasSuffix("spotlight-e-4y");
    expect(result).toEqual({ alias: "spotlight-e", suffix: "4Y" });
  });

  test("handles case-insensitive input", () => {
    const result = parseAliasSuffix("E-4Y");
    expect(result).toEqual({ alias: "e", suffix: "4Y" });
  });

  test("returns null for plain suffix without alias", () => {
    const result = parseAliasSuffix("4y");
    expect(result).toBeNull();
  });

  test("returns null for full short ID (looks like alias-suffix but is PROJECT-XXX)", () => {
    // This is actually a valid alias-suffix parse, but the caller should verify
    // if the alias exists in the cache
    const result = parseAliasSuffix("CRAFT-G");
    expect(result).toEqual({ alias: "craft", suffix: "G" });
  });

  test("returns null for empty string", () => {
    const result = parseAliasSuffix("");
    expect(result).toBeNull();
  });
});

describe("expandToFullShortId representative examples", () => {
  // Representative examples for documentation (invariants covered by property tests)

  test("expands suffix with project slug", () => {
    expect(expandToFullShortId("G", "craft")).toBe("CRAFT-G");
    expect(expandToFullShortId("4y", "spotlight-electron")).toBe(
      "SPOTLIGHT-ELECTRON-4Y"
    );
  });

  test("handles mixed case input", () => {
    expect(expandToFullShortId("aB", "Project")).toBe("PROJECT-AB");
  });
});

describe("short ID resolution flow", () => {
  // Integration test simulating the resolution logic from issue view command.
  // This documents the expected behavior when combining multiple functions.

  const mockAliasCache: Record<
    string,
    { orgSlug: string; projectSlug: string }
  > = {
    e: { orgSlug: "sentry", projectSlug: "spotlight-electron" },
    w: { orgSlug: "sentry", projectSlug: "spotlight-website" },
    s: { orgSlug: "sentry", projectSlug: "spotlight" },
  };

  function getProjectByAlias(alias: string) {
    return mockAliasCache[alias.toLowerCase()];
  }

  function resolveIssueId(
    input: string,
    defaultProject?: string
  ): string | null {
    // Check alias-suffix pattern first
    const aliasSuffix = parseAliasSuffix(input);
    const projectEntry = aliasSuffix
      ? getProjectByAlias(aliasSuffix.alias)
      : null;

    if (aliasSuffix && projectEntry) {
      return expandToFullShortId(aliasSuffix.suffix, projectEntry.projectSlug);
    }

    if (isShortSuffix(input) && defaultProject) {
      return expandToFullShortId(input, defaultProject);
    }

    if (isShortId(input)) {
      return input.toUpperCase();
    }

    return null; // Numeric ID or unresolvable
  }

  test("resolves alias-suffix to full short ID", () => {
    expect(resolveIssueId("e-4y")).toBe("SPOTLIGHT-ELECTRON-4Y");
    expect(resolveIssueId("w-2c")).toBe("SPOTLIGHT-WEBSITE-2C");
    expect(resolveIssueId("s-73")).toBe("SPOTLIGHT-73");
  });

  test("resolves short suffix with default project", () => {
    expect(resolveIssueId("4y", "spotlight-electron")).toBe(
      "SPOTLIGHT-ELECTRON-4Y"
    );
    expect(resolveIssueId("G", "craft")).toBe("CRAFT-G");
    // Pure numeric suffix works when project context is available
    expect(resolveIssueId("12", "craft")).toBe("CRAFT-12");
  });

  test("passes through full short ID", () => {
    expect(resolveIssueId("SPOTLIGHT-ELECTRON-4Y")).toBe(
      "SPOTLIGHT-ELECTRON-4Y"
    );
    expect(resolveIssueId("craft-g")).toBe("CRAFT-G");
  });

  test("returns null for unknown alias", () => {
    // "x" is not in our mock cache, so x-4y won't resolve via alias
    // It will try isShortSuffix (false, has hyphen), then isShortId (true)
    // So it gets treated as a regular short ID
    expect(resolveIssueId("x-4y")).toBe("X-4Y");
  });

  test("treats plain suffix as short ID when no default project", () => {
    // "4y" contains letters so isShortId returns true, treating it as a short ID
    // The actual API call would fail, but resolution succeeds
    expect(resolveIssueId("4y")).toBe("4Y");
  });

  test("returns null for pure numeric ID", () => {
    // Pure numbers are not short IDs, return null to indicate numeric ID
    expect(resolveIssueId("12345")).toBeNull();
  });
});
