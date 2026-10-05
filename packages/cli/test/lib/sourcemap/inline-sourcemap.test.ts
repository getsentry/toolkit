/**
 * Tests for inline (data: URL) sourcemap decode/encode.
 *
 * Core round-trip invariants are exercised with property-based tests; the
 * unit tests cover charset preservation, non-fatal failure modes, and the
 * cheap prefix predicate.
 */

import { dictionary, assert as fcAssert, property, string } from "fast-check";
import { describe, expect, test } from "vitest";
import {
  encodeInlineSourcemap,
  isInlineSourcemapUrl,
  tryDecodeInlineSourcemap,
} from "../../../src/lib/sourcemap/inline-sourcemap.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

/** Build a data URL from a JSON-serializable value. */
function toDataUrl(value: unknown, charset?: string): string {
  const prefix = charset
    ? `data:application/json;charset=${charset};base64,`
    : "data:application/json;base64,";
  return `${prefix}${Buffer.from(JSON.stringify(value)).toString("base64")}`;
}

describe("isInlineSourcemapUrl", () => {
  test("true for data:application/json URLs", () => {
    expect(isInlineSourcemapUrl("data:application/json;base64,e30=")).toBe(
      true
    );
    expect(
      isInlineSourcemapUrl("data:application/json;charset=utf-8;base64,e30=")
    ).toBe(true);
  });

  test("false for external/remote URLs", () => {
    expect(isInlineSourcemapUrl("app.js.map")).toBe(false);
    expect(isInlineSourcemapUrl("https://cdn.example.com/app.js.map")).toBe(
      false
    );
  });
});

describe("tryDecodeInlineSourcemap", () => {
  test("decodes a valid inline map", () => {
    const map = { version: 3, mappings: "AAAA", sources: ["a.ts"] };
    const decoded = tryDecodeInlineSourcemap(toDataUrl(map));
    expect(decoded?.map).toEqual(map);
    expect(decoded?.json).toBe(JSON.stringify(map));
  });

  test("preserves the charset prefix", () => {
    const decoded = tryDecodeInlineSourcemap(toDataUrl({}, "utf-8"));
    expect(decoded?.dataUrlPrefix).toBe(
      "data:application/json;charset=utf-8;base64,"
    );
  });

  test("returns undefined for invalid base64 (non-fatal)", () => {
    expect(
      tryDecodeInlineSourcemap("data:application/json;base64,@@@not-base64@@@")
    ).toBeUndefined();
  });

  test("returns undefined when decoded bytes are not JSON (non-fatal)", () => {
    // "not json" base64-encoded — decodes cleanly but is not JSON.
    const blob = Buffer.from("not json").toString("base64");
    expect(
      tryDecodeInlineSourcemap(`data:application/json;base64,${blob}`)
    ).toBeUndefined();
  });

  test("returns undefined for a non-data URL", () => {
    expect(tryDecodeInlineSourcemap("app.js.map")).toBeUndefined();
  });
});

describe("property: inline sourcemap round-trip", () => {
  test("decode(encode(map)) deep-equals the original map", () => {
    fcAssert(
      property(dictionary(string(), string()), (obj) => {
        const dataUrl = encodeInlineSourcemap(
          obj,
          "data:application/json;base64,"
        );
        const decoded = tryDecodeInlineSourcemap(dataUrl);
        expect(decoded?.map).toEqual(obj);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("charset prefix survives a round-trip", () => {
    fcAssert(
      property(dictionary(string(), string()), (obj) => {
        const prefix = "data:application/json;charset=utf-8;base64,";
        const decoded = tryDecodeInlineSourcemap(
          encodeInlineSourcemap(obj, prefix)
        );
        expect(decoded?.dataUrlPrefix).toBe(prefix);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
