import { describe, expect, it } from "vitest";
import { normalizeAuthToken, trimAuthToken } from "./auth-token";

describe("Sentry bearer credentials", () => {
  it("preserves every visible ASCII byte through edge normalization", () => {
    const visible = Array.from({ length: 94 }, (_, index) =>
      String.fromCharCode(index + 0x21),
    ).join("");
    expect(normalizeAuthToken(`\x00 \u00a0${visible}\t\x7f`)).toBe(visible);
    expect(normalizeAuthToken(visible)).toBe(visible);
  });

  it("never removes invalid bytes from inside a credential", () => {
    for (const code of [0, 9, 10, 32, 127, 128, 255]) {
      const value = `before${String.fromCharCode(code)}after`;
      expect(trimAuthToken(value)).toBe(value);
      expect(normalizeAuthToken(value)).toBeNull();
    }
    expect(normalizeAuthToken("  \t\x00  ")).toBeNull();
    expect(normalizeAuthToken("é")).toBeNull();
  });
});
