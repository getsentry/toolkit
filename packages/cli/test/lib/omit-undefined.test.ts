import { describe, expect, test } from "vitest";
import { omitUndefined } from "../../src/lib/omit-undefined.js";

describe("omitUndefined", () => {
  test("drops undefined values and keeps every other value", () => {
    const result = omitUndefined({
      cursor: undefined,
      limit: 0,
      query: "",
      flag: false,
      parent: null,
    });

    expect(result).toEqual({ limit: 0, query: "", flag: false, parent: null });
    expect("cursor" in result).toBe(false);
  });
});
