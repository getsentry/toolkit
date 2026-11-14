import type { Event as SentryEvent } from "@sentry/core";
import { describe, it, expect } from "vitest";
import { sentryBeforeSend } from "./sentry";

describe("sentry", () => {
  describe("OpenAI API key scrubbing", () => {
    it("should scrub OpenAI API keys from message", () => {
      const event: SentryEvent = {
        message:
          "Error with key: sk-abc123def456ghi789jkl012mno345pqr678stu901vwx234",
      };

      const result = sentryBeforeSend(event, {});
      expect(result.message).toBe("Error with key: [REDACTED_OPENAI_KEY]");
    });

    it("should scrub multiple OpenAI keys", () => {
      const event: SentryEvent = {
        message:
          "Keys: sk-abc123def456ghi789jkl012mno345pqr678stu901vwx234 and sk-xyz123def456ghi789jkl012mno345pqr678stu901vwx234",
      };

      const result = sentryBeforeSend(event, {});
      expect(result.message).toBe(
        "Keys: [REDACTED_OPENAI_KEY] and [REDACTED_OPENAI_KEY]",
      );
    });

    it("should not scrub partial matches", () => {
      const event: SentryEvent = {
        message:
          "Not a key: sk-abc or task-abc123def456ghi789jkl012mno345pqr678stu901vwx234",
      };

      const result = sentryBeforeSend(event, {});
      expect(result.message).toBe(event.message);
    });
  });

  describe("Bearer token scrubbing", () => {
    it("should scrub Bearer tokens", () => {
      const event: SentryEvent = {
        message:
          "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      };

      const result = sentryBeforeSend(event, {});
      expect(result.message).toBe("Authorization: Bearer [REDACTED_TOKEN]");
    });
  });

  describe("Sentry token scrubbing", () => {
    it("should scrub Sentry access tokens", () => {
      const event: SentryEvent = {
        message:
          "Using token: sntrys_eyJpYXQiOjE2OTQwMzMxNTMuNzk0NjI4LCJ1cmwiOiJodHRwczovL3NlbnRyeS5pbyIsInJlZ2lvbl91cmwiOiJodHRwczovL3VzLnNlbnRyeS5pbyIsIm9yZyI6InNlbnRyeSJ9_abcdef123456",
      };

      const result = sentryBeforeSend(event, {});
      expect(result.message).toBe("Using token: [REDACTED_SENTRY_TOKEN]");
    });
  });

  describe("Deep object scrubbing", () => {
    it("should scrub sensitive data from nested objects", () => {
      const event: SentryEvent = {
        extra: {
          config: {
            apiKey: "sk-abc123def456ghi789jkl012mno345pqr678stu901vwx234",
            headers: {
              Authorization: "Bearer token123",
            },
          },
        },
      };

      const result = sentryBeforeSend(event, {});
      expect(result.extra).toEqual({
        config: {
          apiKey: "[REDACTED_OPENAI_KEY]",
          headers: {
            Authorization: "Bearer [REDACTED_TOKEN]",
          },
        },
      });
    });

    it("should scrub breadcrumbs", () => {
      const event: SentryEvent = {
        message: "Test event",
        breadcrumbs: [
          {
            message:
              "API call with sk-abc123def456ghi789jkl012mno345pqr678stu901vwx234",
            data: {
              tokens: ["sntrys_token1", "sntrys_token2"],
            },
          },
        ],
      };

      const result = sentryBeforeSend(event, {});
      expect(result.breadcrumbs?.[0]?.message).toBe(
        "API call with [REDACTED_OPENAI_KEY]",
      );
      expect(result.breadcrumbs?.[0]?.data?.["tokens"]).toEqual([
        "[REDACTED_SENTRY_TOKEN]",
        "[REDACTED_SENTRY_TOKEN]",
      ]);
      expect(result.message).toBe("Test event");
    });
  });

  describe("Exception scrubbing", () => {
    it("should scrub from exception values", () => {
      const event: SentryEvent = {
        exception: {
          values: [
            {
              type: "Error",
              value:
                "Failed to authenticate with sk-abc123def456ghi789jkl012mno345pqr678stu901vwx234",
            },
          ],
        },
      };

      const result = sentryBeforeSend(event, {});
      expect(result.exception?.values?.[0]?.value).toBe(
        "Failed to authenticate with [REDACTED_OPENAI_KEY]",
      );
    });
  });

  describe("No sensitive data", () => {
    it("should return event unchanged when no sensitive data", () => {
      const event: SentryEvent = {
        message: "Normal error message",
        extra: {
          foo: "bar",
        },
      };

      const result = sentryBeforeSend(event, {});
      expect(result).toEqual(event);
    });
  });

  describe("Regex state handling", () => {
    it("should handle multiple calls without regex state corruption", () => {
      // This tests the bug where global regex patterns maintain lastIndex between calls
      const event1: SentryEvent = {
        message:
          "First error with sk-abc123def456ghi789jkl012mno345pqr678stu901vwx234",
      };

      const event2: SentryEvent = {
        message:
          "Second error with sk-xyz123def456ghi789jkl012mno345pqr678stu901vwx234",
      };

      // Call sentryBeforeSend multiple times
      const result1 = sentryBeforeSend(event1, {});
      const result2 = sentryBeforeSend(event2, {});

      // Both should be properly scrubbed
      expect(result1.message).toBe("First error with [REDACTED_OPENAI_KEY]");
      expect(result2.message).toBe("Second error with [REDACTED_OPENAI_KEY]");

      // Test multiple replacements in the same string
      const event3: SentryEvent = {
        message:
          "Multiple keys: sk-abc123def456ghi789jkl012mno345pqr678stu901vwx234 and sk-xyz123def456ghi789jkl012mno345pqr678stu901vwx234",
      };

      const result3 = sentryBeforeSend(event3, {});
      expect(result3.message).toBe(
        "Multiple keys: [REDACTED_OPENAI_KEY] and [REDACTED_OPENAI_KEY]",
      );
    });
  });

  describe("Max depth handling", () => {
    it("should handle deeply nested objects without stack overflow", () => {
      // Create a deeply nested object
      let deep: any = {
        value: "sk-abc123def456ghi789jkl012mno345pqr678stu901vwx234",
      };
      for (let i = 0; i < 25; i++) {
        deep = { nested: deep };
      }

      const event: SentryEvent = {
        message: "Deep nesting test",
        extra: deep,
      };

      const result = sentryBeforeSend(event, {});
      // Should not throw, and should handle max depth gracefully
      expect(result).toBeDefined();
      expect(result.message).toBe("Deep nesting test");
    });
  });
});
