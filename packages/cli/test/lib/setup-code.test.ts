import { describe, expect, test } from "vitest";
import { redactCredentialText } from "../../src/lib/credential-redaction.js";
import { getSetupCodeHost } from "../../src/lib/setup-code.js";

const codeFor = (url: string) =>
  `sntryc_${Buffer.from(JSON.stringify({ url, iat: 1 })).toString("base64")}_${"a".repeat(43)}`;

describe("setup-code routing claims", () => {
  test("resolves the issuing instance and redacts the full code", () => {
    const code = codeFor("https://sentry.example.com/");
    expect(getSetupCodeHost(code)).toBe("https://sentry.example.com");
    expect(redactCredentialText(`code: ${code}`)).toBe("code: [REDACTED]");
  });

  test.each([
    "",
    "sntryc_invalid",
    codeFor("file:///etc/passwd"),
    codeFor("https://user:password@sentry.example.com"),
  ])("rejects malformed codes with a safe error", (code) => {
    expect(() => getSetupCodeHost(code)).toThrow(/Invalid/);
    try {
      getSetupCodeHost(code);
    } catch (error) {
      expect(String(error)).not.toContain("password");
    }
  });
});
