/**
 * Unit Tests for Generated SDK Flag Types
 *
 * Stricli passes variadic flags to a command as arrays, and the SDK forwards flags to the
 * handler unchanged. The generator used to declare them with their element type, so
 * `sdk.auth.login({ scope: "org:read" })` type-checked and then failed inside the handler
 * (`flags.scope.flatMap is not a function`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const declarations = readFileSync(
  fileURLToPath(new URL("../../src/sdk.generated.d.cts", import.meta.url)),
  "utf-8"
);

function paramsType(name: string): string {
  const start = declarations.indexOf(`export type ${name} = {`);
  if (start === -1) {
    throw new Error(`${name} is missing from the generated SDK declarations`);
  }
  return declarations.slice(start, declarations.indexOf("\n};", start));
}

describe("generated SDK flag types", () => {
  test("declares variadic flags as arrays and keeps scalar flags scalar", () => {
    const login = paramsType("AuthLoginParams");
    expect(login).toContain("scope?: Array<string>;");
    expect(login).toContain("token?: string;");
  });
});
