/**
 * Module Mock Helpers
 *
 * Side-effect free, so a `vi.mock` factory can import it dynamically
 * without loading the module being mocked (test/helpers.ts imports src
 * modules that tests mock).
 */

import { vi } from "vitest";

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

/**
 * A copy of a module's exports with each function wrapped in `vi.fn`,
 * calling through to the original. Return it from a `vi.mock` factory so
 * tests can stub any export with `vi.spyOn` or `vi.mocked`.
 */
export function mockFunctionExports<T extends object>(actual: T): T {
  return Object.fromEntries(
    Object.entries(actual).map(([key, value]: [string, unknown]) => [
      key,
      isFunction(value) ? vi.fn(value) : value,
    ]),
  ) as T;
}
