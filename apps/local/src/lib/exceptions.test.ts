import { describe, expect, test } from "vitest";
import { formatExceptionTitle, getEventExceptions } from "./exceptions.ts";
import { goPanicEvent } from "../../../../packages/cli/test/fixtures/local-sdk-events.ts";
import { sdkException } from "../test-fixtures/sdk-exception.ts";

describe("getEventExceptions", () => {
  test.each([
    null,
    {},
    { exception: null },
    { exception: { values: "invalid" } },
    { exception: { values: [null, false, [], {}] } },
  ])("ignores malformed exception data: %j", (payload) => {
    expect(getEventExceptions(payload)).toEqual([]);
  });

  test.each([
    [{ type: "E", value: 42 }, "E: 42"],
    [{ type: "E", value: null }, "E: Unknown error"],
    [{ value: 42 }, "Error: 42"],
    [{ value: true }, "Error: true"],
    [{ type: 42, value: [] }, "Error: []"],
  ])("titles %j the way the tail does", (value, title) => {
    const exceptions = getEventExceptions({ exception: { values: [value] } });
    expect(exceptions).toHaveLength(1);
    const [exception] = exceptions;
    expect(exception && formatExceptionTitle(exception)).toBe(title);
  });

  test.each([
    [{ value: 42 }, "Checkout retry limit reached"],
    [{ value: "Checkout retry limit reached" }, "Checkout retry limit reached"],
    [{ type: "CheckoutError", value: 42 }, "CheckoutError: 42"],
  ])(
    "titles the current exception %j with an event message the way the tail does",
    (value, title) => {
      const [current] = getEventExceptions({
        message: "Checkout retry limit reached",
        exception: { values: [value] },
      });
      expect(current && formatExceptionTitle(current)).toBe(title);
    },
  );

  test("titles a typed exception without a value with the event message", () => {
    const [current, cause] = getEventExceptions({
      message: "Fallback message",
      exception: { values: [{ type: "CauseError" }, { type: "TypeError" }] },
    });
    expect(current && formatExceptionTitle(current)).toBe(
      "TypeError: Fallback message",
    );
    expect(cause && formatExceptionTitle(cause)).toBe(
      "CauseError: Unknown error",
    );
  });

  test("reads a multi-line sentry-ruby message without the class name", () => {
    const [exception] = getEventExceptions({
      exception: {
        values: [
          {
            type: "NoMethodError",
            value:
              "undefined method 'name' for nil (NoMethodError)\n\n    user.name",
          },
        ],
      },
    });
    expect(exception?.value).toBe(
      "undefined method 'name' for nil\n\n    user.name",
    );
  });

  test("reads a sentry-go exception list", () => {
    const [exception] = getEventExceptions(goPanicEvent);
    expect(exception).toMatchObject({
      type: "*errors.errorString",
      value: "order 7 not found",
    });
    expect(exception?.frames.map((frame) => frame.filename)).toEqual([
      "/app/main.go",
      "/usr/local/go/src/runtime/proc.go",
    ]);
  });

  test("reads SDK ordering without mutating exceptions or frames", () => {
    const before = structuredClone(sdkException);
    const exceptions = getEventExceptions(sdkException);
    expect(exceptions.map((exception) => exception.type)).toEqual([
      "TypeError",
      "Error",
    ]);
    expect(exceptions[0]?.frames.map((frame) => frame.function)).toEqual([
      "submitOrder",
      "runMain",
    ]);
    expect(sdkException).toEqual(before);
  });

  test("keeps valid frames and source text beside malformed entries", () => {
    const [exception] = getEventExceptions({
      exception: {
        values: [
          {
            type: "Error",
            stacktrace: {
              frames: [
                null,
                5,
                {},
                {
                  abs_path: "/app/task.ts",
                  lineno: 0,
                  colno: 3,
                  context_line: "throw error;",
                },
                {
                  module: "worker",
                  function: "process",
                  lineno: "12",
                  colno: Infinity,
                },
              ],
            },
          },
        ],
      },
    });
    expect(exception?.frames).toEqual([
      {
        filename: "worker",
        function: "process",
        line: undefined,
        column: undefined,
        source: undefined,
      },
      {
        filename: "/app/task.ts",
        function: "<anonymous>",
        line: 0,
        column: 3,
        source: "throw error;",
      },
    ]);
  });
});
