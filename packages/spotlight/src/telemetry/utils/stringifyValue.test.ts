import { expect, test } from "vitest";
import { stringifyValue } from "./stringifyValue.ts";

test("formats scalar attributes and structured wire values explicitly", () => {
  expect(stringifyValue("text")).toBe("text");
  expect(stringifyValue(0)).toBe("0");
  expect(stringifyValue(false)).toBe("false");
  expect(stringifyValue(null)).toBe("null");
  expect(stringifyValue({ text: "hello" })).toBe('{"text":"hello"}');
  expect(stringifyValue(["one", "two"])).toBe('["one","two"]');
  const circular: { self?: unknown } = {};
  circular.self = circular;
  expect(stringifyValue(circular)).toBe("");
});
