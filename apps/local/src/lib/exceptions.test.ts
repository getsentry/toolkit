import { describe, expect, test } from "vitest";
import { getEventExceptions } from "./exceptions.ts";
import { goPanicEvent } from "../../../../packages/cli/test/fixtures/local-sdk-events.ts";
import { sdkException } from "../test-fixtures/sdk-exception.ts";

describe("getEventExceptions", () => {
  test.each([
    null,
    {},
    { exception: null },
    { exception: { values: "invalid" } },
    { exception: { values: [null, false, [], {}, { type: 42, value: [] }] } },
  ])("ignores malformed exception data: %j", (payload) => {
    expect(getEventExceptions(payload)).toEqual([]);
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
