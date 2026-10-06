/**
 * Tests for the byte-level `sourceMappingURL` directive parser.
 *
 * The reader (`readLastLine`) is internal and exercised end-to-end via
 * discovery tests (see inject.test.ts, including the >2MB inline-blob case).
 * Here we test the directive classification directly.
 */

import { describe, expect, test } from "vitest";
import { parseSourceMappingDirective } from "../../../src/lib/sourcemap/inject.js";

/** Parse a directive from a UTF-8 string line. */
function parse(line: string) {
  return parseSourceMappingDirective(Buffer.from(line, "utf-8"));
}

describe("parseSourceMappingDirective", () => {
  test("classifies an external relative path", () => {
    expect(parse("//# sourceMappingURL=app.js.map")).toEqual({
      kind: "external",
      value: "app.js.map",
    });
  });

  test("classifies an inline data URL", () => {
    const result = parse(
      "//# sourceMappingURL=data:application/json;base64,e30="
    );
    expect(result?.kind).toBe("inline");
    expect(result?.value).toBe("data:application/json;base64,e30=");
  });

  test("classifies a remote URL", () => {
    expect(
      parse("//# sourceMappingURL=https://cdn.example.com/app.js.map")?.kind
    ).toBe("remote");
  });

  test("accepts the //@ marker variant", () => {
    expect(parse("//@ sourceMappingURL=app.js.map")?.value).toBe("app.js.map");
  });

  test("tolerates a trailing CR (CRLF line)", () => {
    expect(parse("//# sourceMappingURL=app.js.map\r")?.value).toBe(
      "app.js.map"
    );
  });

  test("returns undefined for a non-directive line", () => {
    expect(parse("console.log(1)")).toBeUndefined();
    expect(parse("// just a comment")).toBeUndefined();
    expect(parse("")).toBeUndefined();
  });

  test("returns undefined when the value is missing", () => {
    expect(parse("//# sourceMappingURL=")).toBeUndefined();
  });
});
