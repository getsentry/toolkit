import { describe, it, expect } from "vitest";
import { validateRegionUrl } from "./validate-region-url";
import { UserInputError } from "../../errors";

describe("validateRegionUrl", () => {
  describe("base host validation", () => {
    it("allows exact match for base host", () => {
      const result = validateRegionUrl("https://sentry.io", "sentry.io");
      expect(result).toBe("sentry.io");
    });

    it.each(["sentry.company.com", "example.my.sentry.io"])(
      "allows exact match for configured host %s",
      (host) => {
        expect(validateRegionUrl(`https://${host}`, host)).toBe(host);
      },
    );

    it("allows exact match for any base host", () => {
      const result = validateRegionUrl("https://example.com", "example.com");
      expect(result).toBe("example.com");
    });
  });

  describe("allowlist validation", () => {
    it("allows us.sentry.io from allowlist", () => {
      const result = validateRegionUrl("https://us.sentry.io", "sentry.io");
      expect(result).toBe("us.sentry.io");
    });

    it("allows de.sentry.io from allowlist", () => {
      const result = validateRegionUrl("https://de.sentry.io", "sentry.io");
      expect(result).toBe("de.sentry.io");
    });

    it("allows sentry.io from allowlist even with different base", () => {
      const result = validateRegionUrl("https://sentry.io", "mycompany.com");
      expect(result).toBe("sentry.io");
    });

    it("allows us.sentry.io even with self-hosted base", () => {
      const result = validateRegionUrl("https://us.sentry.io", "mycompany.com");
      expect(result).toBe("us.sentry.io");
    });

    it("rejects domains not in allowlist", () => {
      expect(() =>
        validateRegionUrl("https://evil.sentry.io", "sentry.io"),
      ).toThrow(UserInputError);
      expect(() =>
        validateRegionUrl("https://evil.sentry.io", "sentry.io"),
      ).toThrow("The domain 'evil.sentry.io' is not allowed");
    });

    it("rejects completely different domains", () => {
      expect(() => validateRegionUrl("https://evil.com", "sentry.io")).toThrow(
        UserInputError,
      );
      expect(() => validateRegionUrl("https://evil.com", "sentry.io")).toThrow(
        "The domain 'evil.com' is not allowed",
      );
    });

    it("rejects a different single-tenant host", () => {
      expect(() =>
        validateRegionUrl("https://other.my.sentry.io", "example.my.sentry.io"),
      ).toThrow("The domain 'other.my.sentry.io' is not allowed");
    });

    it("rejects subdomains of self-hosted that aren't base host", () => {
      expect(() =>
        validateRegionUrl("https://eu.mycompany.com", "mycompany.com"),
      ).toThrow(UserInputError);
      expect(() =>
        validateRegionUrl("https://eu.mycompany.com", "mycompany.com"),
      ).toThrow("The domain 'eu.mycompany.com' is not allowed");
    });
  });

  describe("protocol validation", () => {
    it("rejects URLs without protocol", () => {
      expect(() => validateRegionUrl("sentry.io", "sentry.io")).toThrow(
        UserInputError,
      );
      expect(() => validateRegionUrl("sentry.io", "sentry.io")).toThrow(
        "Must be a valid URL",
      );
    });

    it("rejects non-https protocols", () => {
      expect(() => validateRegionUrl("ftp://sentry.io", "sentry.io")).toThrow(
        UserInputError,
      );
      expect(() => validateRegionUrl("ftp://sentry.io", "sentry.io")).toThrow(
        "Must use HTTPS protocol for security",
      );
      expect(() => validateRegionUrl("http://sentry.io", "sentry.io")).toThrow(
        "Must use HTTPS protocol for security",
      );
    });

    it("rejects malformed URLs", () => {
      expect(() => validateRegionUrl("https://", "sentry.io")).toThrow(
        UserInputError,
      );
      expect(() => validateRegionUrl("https://", "sentry.io")).toThrow(
        "Must be a valid URL",
      );
    });

    it("rejects protocol-only hosts", () => {
      expect(() => validateRegionUrl("https://https", "sentry.io")).toThrow(
        UserInputError,
      );
      expect(() => validateRegionUrl("https://https", "sentry.io")).toThrow(
        "The host cannot be just a protocol name",
      );
    });
  });

  describe("case sensitivity", () => {
    it("handles case-insensitive matching for sentry.io", () => {
      const result = validateRegionUrl("https://US.SENTRY.IO", "sentry.io");
      expect(result).toBe("us.sentry.io");
    });

    it("handles case-insensitive self-hosted domains", () => {
      const result = validateRegionUrl(
        "https://SENTRY.COMPANY.COM",
        "sentry.company.com",
      );
      expect(result).toBe("sentry.company.com");
    });

    it("handles mixed case base host for sentry.io", () => {
      const result = validateRegionUrl("https://us.sentry.io", "SENTRY.IO");
      expect(result).toBe("us.sentry.io");
    });
  });

  describe("edge cases", () => {
    it("handles trailing slashes in URL", () => {
      const result = validateRegionUrl("https://us.sentry.io/", "sentry.io");
      expect(result).toBe("us.sentry.io");
    });

    it("handles URL with path", () => {
      const result = validateRegionUrl(
        "https://us.sentry.io/api/0/organizations/",
        "sentry.io",
      );
      expect(result).toBe("us.sentry.io");
    });

    it("handles URL with query params", () => {
      const result = validateRegionUrl(
        "https://us.sentry.io?test=1",
        "sentry.io",
      );
      expect(result).toBe("us.sentry.io");
    });

    it("handles URL with port for sentry.io", () => {
      const result = validateRegionUrl("https://us.sentry.io:443", "sentry.io");
      expect(result).toBe("us.sentry.io");
    });

    it("allows self-hosted with matching port", () => {
      const result = validateRegionUrl(
        "https://sentry.company.com:8080",
        "sentry.company.com:8080",
      );
      expect(result).toBe("sentry.company.com:8080");
    });

    it("rejects self-hosted with non-matching port", () => {
      expect(() =>
        validateRegionUrl(
          "https://sentry.company.com:8080",
          "sentry.company.com",
        ),
      ).toThrow(UserInputError);
      expect(() =>
        validateRegionUrl(
          "https://sentry.company.com:8080",
          "sentry.company.com",
        ),
      ).toThrow("The domain 'sentry.company.com:8080' is not allowed");
    });
  });
});
