import { afterEach, describe, expect, test } from "vitest";
import {
  interactivePromptsAllowed,
  setInteractivePromptsAllowed,
} from "../../src/lib/interactive-prompts.js";

describe("interactive-prompts gate", () => {
  afterEach(() => {
    // Restore the default so other tests/files aren't affected.
    setInteractivePromptsAllowed(true);
  });

  test("defaults to allowed so non-wrapper callers fall back to their own checks", () => {
    expect(interactivePromptsAllowed()).toBe(true);
  });

  test("reflects the value set by the command wrapper (JSON mode disables it)", () => {
    setInteractivePromptsAllowed(false);
    expect(interactivePromptsAllowed()).toBe(false);
    setInteractivePromptsAllowed(true);
    expect(interactivePromptsAllowed()).toBe(true);
  });
});
