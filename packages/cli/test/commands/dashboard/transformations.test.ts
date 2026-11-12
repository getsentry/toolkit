import { expect, test } from "vitest";
import { parseTransformationFlags } from "../../../src/commands/dashboard/transformations.js";

test("normalizes raw SDK flags into independent keep, remove, and replace decisions", () => {
  expect(
    parseTransformationFlags({
      "transform-aggregate": "2",
      "transform-fill": "none",
      "transform-smooth": "ema",
      "transform-window": "7",
      "transform-alpha": ".25",
      "transform-order": "smooth-first",
    }),
  ).toEqual({
    aggregate: 2,
    fill: { kind: "remove" },
    smooth: { kind: "set", expression: "smooth(ema,7,0.25)" },
    order: "smooth-first",
  });
  expect(parseTransformationFlags({ "transform-fill": "linear" })).toEqual({
    aggregate: undefined,
    fill: { kind: "set", expression: "fill(linear)" },
    smooth: { kind: "keep" },
    order: undefined,
  });
  expect(
    parseTransformationFlags({
      "transform-aggregate": "all",
      "transform-clear": true,
    }),
  ).toEqual({
    aggregate: "all",
    fill: { kind: "remove" },
    smooth: { kind: "remove" },
    order: undefined,
  });
  expect(
    parseTransformationFlags({ query: ["count"], "transform-clear": false }),
  ).toBeUndefined();
});

test.each([
  [{ "transform-smooth": "asap" }, "smooth(asap)"],
  [{ "transform-smooth": "asap", "transform-window": "9" }, "smooth(asap,9)"],
  [{ "transform-smooth": "ema", "transform-window": "7" }, "smooth(ema,7)"],
  [{ "transform-smooth": "sma", "transform-window": "1" }, "smooth(sma,1)"],
])("builds complete smoothing configurations %j", (flags, expression) => {
  expect(parseTransformationFlags(flags)?.smooth).toEqual({
    kind: "set",
    expression,
  });
});

test.each(["0", "01", "-1", "1.5", "1e2", "9007199254740992", "__proto__"])(
  "rejects invalid aggregate selectors %s",
  (value) => {
    expect(() =>
      parseTransformationFlags({
        "transform-aggregate": value,
        "transform-fill": "zero",
      }),
    ).toThrow("Invalid --transform-aggregate");
  },
);

test.each(["0", "01", "-1", "1.5", "9007199254740992"])(
  "rejects invalid windows %s",
  (value) => {
    expect(() =>
      parseTransformationFlags({
        "transform-smooth": "sma",
        "transform-window": value,
      }),
    ).toThrow("Invalid --transform-window");
  },
);

test.each(["0", "1.1", "0x1", "Infinity", "NaN"])(
  "rejects invalid EMA factors %s",
  (value) => {
    expect(() =>
      parseTransformationFlags({
        "transform-smooth": "ema",
        "transform-window": "7",
        "transform-alpha": value,
      }),
    ).toThrow("Invalid --transform-alpha");
  },
);

test.each([
  [{ "transform-fill": "unknown" }, "Invalid --transform-fill"],
  [{ "transform-smooth": "unknown" }, "Invalid --transform-smooth"],
  [{ "transform-order": "unknown" }, "Invalid --transform-order"],
  [{ "transform-clear": "true" }, "Invalid --transform-clear"],
  [{ "transform-aggregate": "all" }, "requires a transformation setting"],
  [{ "transform-clear": true, "transform-fill": "none" }, "cannot be combined"],
  [{ "transform-window": "7" }, "requires --transform-smooth"],
  [
    { "transform-alpha": ".25", "transform-smooth": "asap" },
    "requires --transform-smooth ema",
  ],
  [{ "transform-smooth": "ema" }, "requires --transform-window"],
  [{ "transform-smooth": "sma" }, "requires --transform-window"],
])("rejects invalid flag combinations %j", (flags, message) => {
  expect(() => parseTransformationFlags(flags)).toThrow(message);
});
