import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatErrorForUser, isExpectedToolError } from "./error-handling";
import {
  AgentExecutionError,
  UserInputError,
  ConfigurationError,
  LLMProviderError,
} from "../errors";
import { APICallError, RetryError } from "ai";

vi.mock("../telem/logging", () => ({
  logIssue: vi.fn(() => "mock-event-id"),
  logWarn: vi.fn(),
}));

import { logIssue, logWarn } from "../telem/logging";

describe("isExpectedToolError", () => {
  it("treats AI provider and user-facing failures as expected", () => {
    expect(isExpectedToolError(new LLMProviderError("budget exceeded"))).toBe(
      true,
    );
    expect(isExpectedToolError(new UserInputError("bad input"))).toBe(true);
    expect(
      isExpectedToolError(
        new AgentExecutionError("agent failed", { eventId: "evt-1" }),
      ),
    ).toBe(true);
    expect(
      isExpectedToolError(
        new APICallError({
          message: "provider down",
          url: "https://api.openai.com/v1/chat/completions",
          requestBodyValues: {},
          statusCode: 503,
          isRetryable: true,
        }),
      ),
    ).toBe(true);
    expect(isExpectedToolError(new Error("boom"))).toBe(false);
  });
});

describe("formatErrorForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("ConfigurationError", () => {
    const error = new ConfigurationError("OPENAI_API_KEY is not set");

    it("returns detailed message for stdio transport", async () => {
      const result = await formatErrorForUser(error, { transport: "stdio" });
      expect(result).toContain("OPENAI_API_KEY is not set");
      expect(result).toContain("**Configuration Error**");
      expect(result).not.toContain("Feature Unavailable");
      expect(logIssue).not.toHaveBeenCalled();
      expect(logWarn).not.toHaveBeenCalled();
    });

    it("returns generic message for http transport", async () => {
      const result = await formatErrorForUser(error, { transport: "http" });
      expect(result).toContain("**Feature Unavailable**");
      expect(result).toContain("server configuration issue");
      expect(result).not.toContain("OPENAI_API_KEY is not set");
      expect(logIssue).toHaveBeenCalledWith(error);
      expect(logWarn).not.toHaveBeenCalled();
    });

    it("returns detailed message when transport is undefined (backward compat)", async () => {
      const result = await formatErrorForUser(error);
      expect(result).toContain("OPENAI_API_KEY is not set");
      expect(result).toContain("**Configuration Error**");
      expect(logIssue).not.toHaveBeenCalled();
    });
  });

  describe("LLMProviderError", () => {
    const error = new LLMProviderError(
      "Workspace monthly budget of $15000.00 exceeded",
    );

    it("returns detailed message for stdio transport", async () => {
      const result = await formatErrorForUser(error, { transport: "stdio" });
      expect(result).toContain(
        "Workspace monthly budget of $15000.00 exceeded",
      );
      expect(result).toContain("**AI Provider Error**");
      expect(result).toContain("Other non-AI tools should still work");
      expect(result).not.toContain("Feature Unavailable");
      expect(logIssue).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledWith(
        error,
        expect.objectContaining({
          loggerScope: ["error-handling", "llm-provider"],
        }),
      );
    });

    it("returns graceful availability message for http transport without creating an issue", async () => {
      const result = await formatErrorForUser(error, { transport: "http" });
      expect(result).toContain("**Feature Unavailable**");
      expect(result).toContain(
        "AI-powered features are temporarily unavailable",
      );
      expect(result).toContain("do not require AI should still work");
      expect(result).not.toContain(
        "Workspace monthly budget of $15000.00 exceeded",
      );
      expect(result).not.toContain("server configuration issue");
      expect(logIssue).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledWith(
        error,
        expect.objectContaining({
          loggerScope: ["error-handling", "llm-provider"],
        }),
      );
    });

    it("returns detailed message when transport is undefined", async () => {
      const result = await formatErrorForUser(error);
      expect(result).toContain(
        "Workspace monthly budget of $15000.00 exceeded",
      );
      expect(logIssue).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalled();
    });
  });

  describe("APICallError 4xx", () => {
    const error = new APICallError({
      message: "Invalid API key provided",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 401,
      isRetryable: false,
    });

    it("returns detailed message for stdio transport", async () => {
      const result = await formatErrorForUser(error, { transport: "stdio" });
      expect(result).toContain("Invalid API key provided");
      expect(result).toContain("**AI Provider Error**");
      expect(result).not.toContain("Feature Unavailable");
      expect(logIssue).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalled();
    });

    it("returns graceful availability message for http transport without creating an issue", async () => {
      const result = await formatErrorForUser(error, { transport: "http" });
      expect(result).toContain("**Feature Unavailable**");
      expect(result).toContain(
        "AI-powered features are temporarily unavailable",
      );
      expect(result).not.toContain("Invalid API key provided");
      expect(logIssue).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalled();
    });

    it("returns detailed message when transport is undefined", async () => {
      const result = await formatErrorForUser(error);
      expect(result).toContain("Invalid API key provided");
      expect(logIssue).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalled();
    });
  });

  describe("APICallError 5xx", () => {
    const error = new APICallError({
      message: "Internal server error",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 503,
      isRetryable: true,
    });

    it("returns graceful availability message without creating an issue", async () => {
      const result = await formatErrorForUser(error, { transport: "http" });
      expect(result).toContain(
        "AI-powered features are temporarily unavailable",
      );
      expect(result).not.toContain("Internal server error");
      expect(logIssue).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalled();
    });

    it("returns detailed provider-down message for stdio transport", async () => {
      const result = await formatErrorForUser(error, { transport: "stdio" });
      expect(result).toContain("currently unavailable");
      expect(result).toContain("Internal server error");
      expect(logIssue).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalled();
    });
  });

  describe("RetryError", () => {
    const error = new RetryError({
      message: "Failed after 3 attempts. Last error: Internal server error",
      reason: "maxRetriesExceeded",
      errors: [
        new APICallError({
          message: "Internal server error",
          url: "https://api.openai.com/v1/chat/completions",
          requestBodyValues: {},
          statusCode: 503,
          isRetryable: true,
        }),
      ],
    });

    it("is treated as an expected tool error", () => {
      expect(isExpectedToolError(error)).toBe(true);
    });

    it("returns graceful availability message without creating an issue", async () => {
      const result = await formatErrorForUser(error, { transport: "http" });
      expect(result).toContain(
        "AI-powered features are temporarily unavailable",
      );
      expect(logIssue).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalled();
    });
  });

  describe("UserInputError", () => {
    const error = new UserInputError("Invalid issue ID format");

    it("returns detailed message for http transport (user can fix input)", async () => {
      const result = await formatErrorForUser(error, { transport: "http" });
      expect(result).toContain("Invalid issue ID format");
      expect(result).toContain("**Input Error**");
      expect(result).not.toContain("Feature Unavailable");
      expect(logIssue).not.toHaveBeenCalled();
    });

    it("returns detailed message for stdio transport", async () => {
      const result = await formatErrorForUser(error, { transport: "stdio" });
      expect(result).toContain("Invalid issue ID format");
      expect(result).toContain("**Input Error**");
      expect(logIssue).not.toHaveBeenCalled();
    });
  });

  describe("AgentExecutionError", () => {
    const error = new AgentExecutionError(
      "The AI agent failed to complete this request: No output generated.",
      { eventId: "evt-abc" },
    );

    it("returns a graceful AI processing error without creating another issue", async () => {
      const result = await formatErrorForUser(error, { transport: "http" });
      expect(result).toContain("**AI Processing Error**");
      expect(result).toContain("failed to complete this request");
      expect(result).toContain("**Event ID**: evt-abc");
      expect(logIssue).not.toHaveBeenCalled();
      expect(logWarn).not.toHaveBeenCalled();
    });
  });
});
