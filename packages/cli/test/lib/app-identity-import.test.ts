/**
 * Hints name the running program, which an entry point registers only after
 * the command modules load, so no hint may be built at import.
 */

import { expect, test, vi } from "vitest";

const builtAtImport: string[] = [];

vi.mock("../../src/lib/app-identity.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/app-identity.js")>();
  return {
    ...actual,
    sentry: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const hint = actual.sentry(strings, ...values);
      builtAtImport.push(hint);
      return hint;
    },
  };
});

test("loading the commands builds no hints", async () => {
  await import("../../src/app.js");
  await import("../../src/mcp-server-app.js");
  expect(builtAtImport).toEqual([]);
});
