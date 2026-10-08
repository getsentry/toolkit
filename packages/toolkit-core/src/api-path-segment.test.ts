import { describe, expect, it } from "vitest";
import { encodeApiPathSegment } from "./api-path-segment.js";

describe("encodeApiPathSegment", () => {
  it.each([".", ".."])("rejects a bare dot segment %s", (value) => {
    expect(encodeApiPathSegment(value)).toBeNull();
  });

  it.each([
    "release/feature",
    "../other-org",
    "%2e%2e",
    "abc/#",
    "..\\other-org",
  ])("keeps %s inside one path segment after URL parsing", (value) => {
    const segment = encodeApiPathSegment(value);
    expect(segment).not.toBeNull();
    const url = new URL(
      `https://sentry.io/api/0/organizations/my-org/releases/${segment}/`,
    );
    expect(url.pathname).toBe(
      `/api/0/organizations/my-org/releases/${encodeURIComponent(value)}/`,
    );
  });

  it("preserves ordinary identifiers and numeric IDs", () => {
    expect(encodeApiPathSegment("v1.2.3")).toBe("v1.2.3");
    expect(encodeApiPathSegment(42)).toBe("42");
  });
});
