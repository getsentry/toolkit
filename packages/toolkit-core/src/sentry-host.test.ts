import { describe, expect, it } from "vitest";
import { isSentryHost } from "./sentry-host";

describe("isSentryHost", () => {
  it.each(["sentry.io", "us.sentry.io", "tenant.my.sentry.io"])(
    "recognizes %s as a Sentry hostname",
    (host) => {
      expect(isSentryHost(host)).toBe(true);
    },
  );

  it.each([
    "",
    "sentry.io.example.com",
    "notsentry.io",
    "sentry.io.",
    "SENTRY.IO",
  ])("does not classify %s as a Sentry hostname", (host) => {
    expect(isSentryHost(host)).toBe(false);
  });
});
