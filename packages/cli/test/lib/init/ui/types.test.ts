/**
 * Tests for the WizardUI shared cancellation sentinel and type guard.
 *
 * The interface itself has no runtime surface — these tests cover only
 * the helpers in `types.ts` that ship with it.
 */

import { describe, expect, test } from "vitest";
import { CANCELLED, isCancelled } from "../../../../src/lib/init/ui/types.js";

describe("CANCELLED sentinel", () => {
  test("is a symbol", () => {
    expect(typeof CANCELLED).toBe("symbol");
  });

  test("is registered globally so cross-bundle equality holds", () => {
    // Symbol.for ensures any caller that imports `CANCELLED` from this
    // module path gets the exact same symbol — important when the wizard
    // straddles bundled and source contexts (compiled binary vs tests).
    expect(CANCELLED).toBe(Symbol.for("sentry-cli:wizard-ui:cancelled"));
  });
});

describe("isCancelled", () => {
  test("returns true for the sentinel", () => {
    expect(isCancelled(CANCELLED)).toBe(true);
  });

  test("returns false for arbitrary values", () => {
    expect(isCancelled(undefined)).toBe(false);
    expect(isCancelled(null)).toBe(false);
    expect(isCancelled(false)).toBe(false);
    expect(isCancelled(0)).toBe(false);
    expect(isCancelled("")).toBe(false);
    expect(isCancelled("CANCELLED")).toBe(false);
    expect(isCancelled({})).toBe(false);
  });

  test("returns false for unrelated symbols", () => {
    expect(isCancelled(Symbol("cancelled"))).toBe(false);
    expect(isCancelled(Symbol.for("other"))).toBe(false);
  });
});
