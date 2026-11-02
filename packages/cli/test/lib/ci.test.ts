/** Tests for the shared CI environment detector. */

import { describe, expect, test } from "vitest";
import { isCi } from "../../src/lib/ci.js";

describe("isCi", () => {
  test("true when a CI variable is set", () => {
    expect(isCi({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(isCi({ TF_BUILD: "True" })).toBe(true);
    expect(isCi({ CI: "1" })).toBe(true);
  });

  test("false with no CI variables (and ignores opt-out values)", () => {
    expect(isCi({})).toBe(false);
    expect(isCi({ CI: "" })).toBe(false);
    expect(isCi({ CI: "false" })).toBe(false);
    expect(isCi({ CI: "0" })).toBe(false);
  });

  test("detects provider markers even when the generic marker is disabled", () => {
    expect(isCi({ CI: "false", GITHUB_ACTIONS: "true" })).toBe(true);
  });
});
