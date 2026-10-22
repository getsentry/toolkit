import { describe, expect, test } from "vitest";
import { normalizeDocPath } from "../sentry-docs/fetcher";

describe("normalizeDocPath", () => {
  test.each([
    ["/platforms/javascript/", "/platforms/javascript"],
    ["/platforms/javascript", "/platforms/javascript"],
    ["platforms/javascript", "/platforms/javascript"],
    ["https://docs.sentry.io/platforms/javascript/", "/platforms/javascript"],
    ["/platforms/javascript/.md", "/platforms/javascript"],
    ["https://docs.sentry.io", "/"],
    ["https://docs.sentry.io/", "/"],
  ])("normalizes supported docs input %s", (input, expected) => {
    expect(normalizeDocPath(input)).toBe(expected);
  });

  test.each([
    "https://docs.sentry.io.example.com/platforms/javascript",
    "https://docs.sentry.io@example.com/platforms/javascript",
  ])("does not strip the docs prefix from a different origin: %s", (input) => {
    expect(normalizeDocPath(input)).toBe(`/${input}`);
  });
});
