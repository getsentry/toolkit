import { describe, expect, test } from "vitest";
import { withoutUndefined } from "./objects.ts";

describe("withoutUndefined", () => {
  test("omits undefined properties and keeps other falsy values", () => {
    const value = withoutUndefined({
      id: "span",
      parentId: undefined as string | undefined,
      count: 0,
      label: "",
      payload: null,
    });
    expect(value).toStrictEqual({
      id: "span",
      count: 0,
      label: "",
      payload: null,
    });
    expect("parentId" in value).toBe(false);
  });

  test("accepts only plain records, whose own keys are all it copies", () => {
    class Span {
      id = "span";
      get label(): string {
        return "inherited";
      }
    }
    // @ts-expect-error A class instance's prototype members would be dropped.
    expect(withoutUndefined(new Span())).toStrictEqual({ id: "span" });
  });
});
