import { describe, expect, it } from "vitest";
import { buildSentryApiUrl } from "./api-request.js";

describe("buildSentryApiUrl", () => {
  it.each([
    [
      "https://sentry.io",
      "/organizations/org/",
      "https://sentry.io/api/0/organizations/org/",
    ],
    [
      "https://us.sentry.io/",
      "organizations/org/?cursor=a%3Ab",
      "https://us.sentry.io/api/0/organizations/org/?cursor=a%3Ab",
    ],
    [
      "https://self-hosted.example/sentry/",
      "/organizations/org/",
      "https://self-hosted.example/sentry/api/0/organizations/org/",
    ],
    [
      "https://self-hosted.example/sentry////",
      "organizations/org/",
      "https://self-hosted.example/sentry/api/0/organizations/org/",
    ],
  ])("assembles %s with %s", (baseUrl, endpoint, expected) => {
    expect(buildSentryApiUrl(baseUrl, endpoint)).toBe(expected);
  });

  it("preserves encoded identifiers without decoding them", () => {
    expect(buildSentryApiUrl("https://sentry.io", "issues/a%2Fb/")).toBe(
      "https://sentry.io/api/0/issues/a%2Fb/",
    );
  });
});
