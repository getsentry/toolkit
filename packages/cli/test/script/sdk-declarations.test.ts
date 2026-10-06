import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  buildCoreDeclarations,
  extractSentryOptions,
  SDK_TYPES_PATH,
} from "../../script/sdk-declarations.js";

/**
 * The published `SentryOptions` type used to be a hand-written copy of the one in
 * `sdk-types.ts`. It drifted silently: `headers` was added to the source and worked at
 * runtime in 0.44.0, but consumers passing it got "does not exist in type 'SentryOptions'".
 */
describe("SDK entry-point declarations", () => {
  const source = readFileSync(
    fileURLToPath(new URL(`../../${SDK_TYPES_PATH}`, import.meta.url)),
    "utf-8"
  );

  test("declares every option the source type declares", () => {
    const declarations = buildCoreDeclarations(source);

    const options = extractSentryOptions(source);
    const optionNames = [...options.matchAll(/^ {2}(\w+)\??:/gm)].map(
      (match) => match[1]
    );

    expect(optionNames).toContain("headers");
    for (const name of optionNames) {
      expect(declarations).toContain(`${name}?:`);
    }
  });

  test("throws when the source type can no longer be located", () => {
    expect(() => extractSentryOptions("export type Something = {};")).toThrow(
      SDK_TYPES_PATH
    );
  });

  test("captures the whole declaration when nested object literals are present", () => {
    const fixture = `export type SentryOptions = {
  token?: string;
  nested?: {
    inner: number;
  };
};`;
    expect(extractSentryOptions(fixture)).toBe(fixture);
  });
});
