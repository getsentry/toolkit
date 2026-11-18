import { describe, expect, test } from "vitest";
import { classifyEvent } from "../../../src/commands/local/event-kind.js";

describe("classifyEvent", () => {
  test("JS SDK 11 captureMessage with a synthetic, untyped exception is a message", () => {
    // @sentry/node 11.14.0: captureMessage("Checkout retry limit reached", "warning")
    expect(
      classifyEvent({
        level: "warning",
        message: "Checkout retry limit reached",
        exception: {
          values: [
            {
              value: "Checkout retry limit reached",
              stacktrace: { frames: [{ filename: "/app/capture.mjs" }] },
              mechanism: { type: "generic", handled: true, synthetic: true },
            },
          ],
        },
      }),
    ).toBe("message");
  });

  test.each([
    [
      {
        exception: { values: [{ type: "TypeError", value: "x is undefined" }] },
      },
      "exception",
    ],
    [
      {
        logentry: { message: "Checkout failed", params: [] },
        exception: {
          values: [{ type: "ZeroDivisionError", value: "division by zero" }],
        },
      },
      "exception",
    ],
    [{ logentry: { formatted: "Payment failed for order 42" } }, "message"],
    [{ message: "Payment retry limit reached", level: "error" }, "message"],
    [
      { exception: { values: [{ mechanism: { type: "generic" } }] } },
      "exception",
    ],
    [{ message: "", logentry: { message: "" } }, undefined],
    [{ level: "error" }, undefined],
  ])("%j is %s", (event, kind) => {
    expect(classifyEvent(event)).toBe(kind);
  });
});
