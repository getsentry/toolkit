/**
 * The `lazy-require-to-import` plugin in `vitest.config.ts` loads a lazy
 * `require("./x.js")` of a source module through Vite's module graph, so the
 * required module resolves its own `.js` imports and is the same instance
 * that tests import and spy on.
 */

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as target from "../fixtures/lazy-require/target.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  requireTarget,
  requireTargetDescriber,
} from "../fixtures/lazy-require/lazy.js";

describe("lazy relative require under vitest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("loads a module whose own imports use .js specifiers", () => {
    expect(requireTarget().describeTarget()).toBe("target of leaf");
  });

  test("returns the module instance that tests import", () => {
    vi.spyOn(target, "describeTarget").mockReturnValue("spied");

    expect(requireTarget().describeTarget()).toBe("spied");
  });

  test("handles a require call that spans lines", () => {
    expect(requireTargetDescriber()).toBe(target.describeTarget);
  });
});
