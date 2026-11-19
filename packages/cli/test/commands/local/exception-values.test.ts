import { describe, expect, test } from "vitest";
import {
  exceptionMessage,
  exceptionValueText,
  exceptionValues,
  frameFile,
} from "../../../src/commands/local/exception-values.js";

describe("exceptionValues", () => {
  const thrown = { type: "ValueError", value: "bad input" };

  test.each([
    ["a sentry-go list", [thrown], [thrown]],
    ["a values object", { values: [thrown] }, [thrown]],
    ["null", null, []],
    ["a string", "ValueError: bad input", []],
    ["a values string", { values: "x" }, []],
  ])("reads %s", (_name, exception, expected) => {
    expect(exceptionValues(exception)).toEqual(expected);
  });
});

describe("exceptionMessage", () => {
  test.each([
    [
      "drops the class name sentry-ruby appends",
      "OrderNotFound",
      "order 7 not found (OrderNotFound)",
      "order 7 not found",
    ],
    [
      "drops the class name from the first line of a multi-line message",
      "NoMethodError",
      "undefined method 'name' for nil (NoMethodError)\n\n    user.name\n        ^^^^^",
      "undefined method 'name' for nil\n\n    user.name\n        ^^^^^",
    ],
    [
      "keeps parentheses that belong to the message",
      "TimeoutError",
      "request timed out (after 30s)",
      "request timed out (after 30s)",
    ],
    [
      "keeps a different type",
      "OrderNotFound",
      "order 7 not found (OrderMissing)",
      "order 7 not found (OrderMissing)",
    ],
    [
      "keeps the type when it is not the suffix",
      "OrderNotFound",
      "order 7 not found (OrderNotFound) twice",
      "order 7 not found (OrderNotFound) twice",
    ],
    [
      "keeps the type on a later line",
      "OrderNotFound",
      "order 7 not found\n(OrderNotFound)",
      "order 7 not found\n(OrderNotFound)",
    ],
    [
      "keeps a message that is only the suffix",
      "OrderNotFound",
      " (OrderNotFound)",
      " (OrderNotFound)",
    ],
    [
      "drops the class name before a Windows line ending",
      "NoMethodError",
      "undefined method 'name' for nil (NoMethodError)\r\n    user.name",
      "undefined method 'name' for nil\r\n    user.name",
    ],
    [
      "keeps untyped messages",
      undefined,
      "order 7 not found (undefined)",
      "order 7 not found (undefined)",
    ],
  ])("%s", (_name, type, value, expected) => {
    expect(exceptionMessage(type, value)).toBe(expected);
  });
});

describe("exceptionValueText", () => {
  test.each([
    ["boom", "boom"],
    [42, "42"],
    [0, "0"],
    ["", undefined],
    [null, undefined],
    [undefined, undefined],
    [true, "true"],
    [[], "[]"],
    [{}, "{}"],
    [{ code: 7 }, '{"code":7}'],
  ])("reads %j as %j", (value, expected) => {
    expect(exceptionValueText(value)).toBe(expected);
  });
});

describe("frameFile", () => {
  test.each([
    ["filename", { filename: "app.ts", abs_path: "/app/app.ts" }, "app.ts"],
    ["a POSIX abs_path", { abs_path: "/app/main.go" }, "main.go"],
    ["a Windows abs_path", { abs_path: "C:\\app\\main.go" }, "main.go"],
    [
      "a Windows long abs_path",
      { abs_path: "\\\\?\\C:\\app\\main.go" },
      "main.go",
    ],
    ["a directory abs_path", { abs_path: "/app/" }, undefined],
    ["an empty abs_path", { abs_path: "" }, undefined],
    [
      "an empty filename",
      { filename: "", abs_path: "/app/main.go" },
      "main.go",
    ],
    [
      "a URL abs_path",
      { abs_path: "https://shop.example/assets/app.js?v=3#L10" },
      "app.js",
    ],
    [
      "a URL abs_path with a hash",
      { abs_path: "app://bundle.js#x" },
      "bundle.js",
    ],
    ["no file", {}, undefined],
  ])("reads %s", (_name, frame, expected) => {
    expect(frameFile(frame)).toBe(expected);
  });
});
