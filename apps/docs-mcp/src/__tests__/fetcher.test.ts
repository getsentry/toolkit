import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchDocPage, normalizeDocPath } from "../sentry-docs/fetcher";

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

describe("normalizeDocPath query strings and fragments", () => {
  test.each([
    ["https://docs.sentry.io/platforms/javascript/#tracing", "/platforms/javascript"],
    ["https://docs.sentry.io/platforms/javascript/?platform=node", "/platforms/javascript"],
    ["https://docs.sentry.io/platforms/javascript?platform=node#tracing", "/platforms/javascript"],
    ["/platforms/javascript/#tracing", "/platforms/javascript"],
    ["platforms/javascript?x=1", "/platforms/javascript"],
    ["/platforms/javascript.md#tracing", "/platforms/javascript"],
    ["https://docs.sentry.io?x=1", "/"],
    ["https://docs.sentry.io#top", "/"],
  ])("drops the query string and fragment from %s", (input, expected) => {
    expect(normalizeDocPath(input)).toBe(expected);
  });

  test("keeps the exact-origin boundary when a query string is present", () => {
    expect(
      normalizeDocPath("https://docs.sentry.io.example.com/a?x=1"),
    ).toBe("/https://docs.sentry.io.example.com/a");
  });
});

describe("fetchDocPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("requests <pathname>.md for a URL with a fragment and a query string", async () => {
    const fetchMock = vi.fn(async () => new Response("# page"));
    vi.stubGlobal("fetch", fetchMock);

    await fetchDocPage(
      "https://docs.sentry.io/platforms/javascript/?platform=node#tracing",
    );

    const request = (fetchMock.mock.calls[0] as unknown as [Request])[0];
    expect(request.url).toBe("https://docs.sentry.io/platforms/javascript.md");
  });
});
