import { expect, test } from "vitest";
import { parseTransformations } from "../../../src/commands/dashboard/transformations.js";

test.each([
  "fill(zero)",
  "fill(linear)",
  "fill(locf)",
  "smooth(sma,1)",
  "smooth(ema,7)",
  "smooth(ema,7,.25)",
  "smooth(ema,7,1.)",
  "smooth(ema,7,2.5e-1)",
  "smooth(asap)",
  "smooth(asap,7)",
  "smooth( ema , 7 , 0.25 )",
])("preserves the accepted transformation %s verbatim", (transformation) => {
  expect(
    parseTransformations(JSON.stringify({ "0": [transformation] })),
  ).toEqual({
    "0": [transformation],
  });
});

test.each([
  "fill()",
  "fill(unknown)",
  "fill(zero,1)",
  "smooth(sma)",
  "smooth(sma,1,0.5)",
  "smooth(ema)",
  "smooth(ema,0)",
  "smooth(ema,1,0)",
  "smooth(ema,1,1.1)",
  "smooth(ema,1,0x1)",
  "smooth(ema,1,+0.5)",
  "smooth(asap,1,0.5)",
  "smooth(asap,-1)",
  "smooth(sma,01)",
  "smooth(sma,1.5)",
  "smooth(sma,9007199254740992)",
  "smooth(unknown,7)",
  "fill(zero\n)",
  "fill(zero)\n",
])("rejects the invalid transformation %s", (transformation) => {
  expect(() =>
    parseTransformations(JSON.stringify({ "0": [transformation] })),
  ).toThrow("Invalid transformation");
});

test.each([
  "01",
  "-1",
  "1.5",
  "1e2",
  "9007199254740992",
  "__proto__",
  "constructor",
])("rejects the invalid axis %s before parsing the record", (axis) => {
  expect(() => parseTransformations(JSON.stringify({ [axis]: [] }))).toThrow(
    "Invalid aggregate position",
  );
});

test("preserves transformation order, independent axes, and explicit clearing", () => {
  expect(
    parseTransformations(
      '{"0":["smooth(asap)","fill(zero)"],"1":["fill(linear)","smooth(ema,7)"],"2":[]}',
    ),
  ).toEqual({
    "0": ["smooth(asap)", "fill(zero)"],
    "1": ["fill(linear)", "smooth(ema,7)"],
    "2": [],
  });
});
