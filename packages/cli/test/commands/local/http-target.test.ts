import { describe, expect, test } from "vitest";
import { httpTargetAttribute } from "../../../src/commands/local/http-target.js";

describe("httpTargetAttribute", () => {
  test.each([
    [
      { "http.route": "/r", "url.template": "/t", "url.full": "http://h/f" },
      { key: "http.route", value: "/r" },
    ],
    [
      { "url.template": "/t", "url.full": "http://h/f", "url.path": "/p" },
      { key: "url.template", value: "/t" },
    ],
    [
      { "url.full": "http://h/f", "url.path": "/p" },
      { key: "url.full", value: "http://h/f" },
    ],
    [
      { "http.route": "", "url.path": "/p" },
      { key: "url.path", value: "/p" },
    ],
    [{}, undefined],
  ])("picks the best target from %o", (attributes, expected) => {
    const attrs: Record<string, string> = attributes;
    expect(httpTargetAttribute((key) => attrs[key])).toEqual(expected);
  });
});
