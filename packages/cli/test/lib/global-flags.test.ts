/**
 * Unit tests for {@link buildTopLevelFlags}, which derives the route-scanner
 * allow-list from {@link GLOBAL_FLAGS}.
 *
 * The end-to-end behavior (a global flag placed before the subcommand reaching
 * the leaf command) is covered via the patched Stricli scanner in
 * `scanner-flags.integration.test.ts`. These tests pin the derivation contract so
 * the allow-list stays in sync with the flag definitions and matches the shape
 * Stricli's `scanner.topLevelFlags` option expects.
 */

import { describe, expect, test } from "vitest";
import {
  buildTopLevelFlags,
  GLOBAL_FLAGS,
} from "../../src/lib/global-flags.js";

describe("buildTopLevelFlags", () => {
  test("every boolean flag contributes --name, its short alias, and --no-name", () => {
    const { booleanFlags } = buildTopLevelFlags();
    for (const flag of GLOBAL_FLAGS) {
      if (flag.kind !== "boolean") {
        continue;
      }
      expect(booleanFlags.has(`--${flag.name}`)).toBe(true);
      expect(booleanFlags.has(`--no-${flag.name}`)).toBe(true);
      if (flag.short !== null) {
        expect(booleanFlags.has(`-${flag.short}`)).toBe(true);
      }
    }
  });

  test("every value flag contributes --name (and its short alias)", () => {
    const { valueFlags } = buildTopLevelFlags();
    for (const flag of GLOBAL_FLAGS) {
      if (flag.kind !== "value") {
        continue;
      }
      expect(valueFlags.has(`--${flag.name}`)).toBe(true);
      if (flag.short !== null) {
        expect(valueFlags.has(`-${flag.short}`)).toBe(true);
      }
    }
  });

  test("boolean and value token sets are disjoint", () => {
    const { booleanFlags, valueFlags } = buildTopLevelFlags();
    for (const token of booleanFlags) {
      expect(valueFlags.has(token)).toBe(false);
    }
  });

  test("value flags never carry a --no- negation", () => {
    const { valueFlags } = buildTopLevelFlags();
    for (const token of valueFlags) {
      expect(token.startsWith("--no-")).toBe(false);
    }
  });

  test("matches the current GLOBAL_FLAGS definition", () => {
    const { booleanFlags, valueFlags } = buildTopLevelFlags();
    expect([...booleanFlags].sort()).toEqual(
      ["--verbose", "-v", "--no-verbose", "--json", "--no-json"].sort()
    );
    expect([...valueFlags].sort()).toEqual(
      ["--log-level", "--fields", "--org", "--project"].sort()
    );
  });
});
