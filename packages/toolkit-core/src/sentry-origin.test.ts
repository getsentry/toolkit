import { describe, expect, it } from "vitest";
import { isSaaSTrustOrigin } from "./sentry-origin.js";

describe("isSaaSTrustOrigin", () => {
  it.each([
    "https://sentry.io",
    "https://us.sentry.io/api/0/",
    "https://de.sentry.io:443",
    "https://tenant.my.sentry.io/",
  ])("accepts a credential-free SaaS HTTPS origin: %s", (url) => {
    expect(isSaaSTrustOrigin(url)).toBe(true);
  });

  it.each([
    "http://sentry.io",
    "http://us.sentry.io",
    "https://sentry.io:8443",
    "https://evil@us.sentry.io",
    "https://user:password@sentry.io",
    "https://sentry.io.example.com",
    "https://notsentry.io",
    "not-a-url",
  ])("rejects an untrusted origin: %s", (url) => {
    expect(isSaaSTrustOrigin(url)).toBe(false);
  });
});
