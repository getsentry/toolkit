import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatErrorForUser, isExpectedToolError } from "./error-handling";
import {
  AgentExecutionError,
  UserInputError,
  ConfigurationError,
  LLMProviderError,
} from "../errors";
import { APICallError, RetryError } from "ai";
import {
  ApiPermissionError,
  ApiRateLimitError,
  createApiError,
} from "../api-client";

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

  describe("ApiRateLimitError", () => {
    it("tells the agent when to retry and to stop calling tools in parallel", async () => {
      const error = new ApiRateLimitError(
        "Limit is 40 requests in 1 seconds",
        undefined,
        undefined,
        30_000,
      );

      const result = await formatErrorForUser(error, { transport: "http" });

      expect(result).toBe(
        [
          "**Rate Limited**",
          "The Sentry API is rate limiting these requests. Short waits are already retried automatically.",
          "API error (429): Limit is 40 requests in 1 seconds. Retry in 30 seconds.",
          "Call Sentry tools one at a time instead of in parallel, and don't repeat this call before then.",
        ].join("\n\n"),
      );
      expect(logIssue).not.toHaveBeenCalled();
    });
  });

  describe("insufficient_scope ApiPermissionError", () => {
    const detail = "You do not have permission to perform this action.";
    const expected = [
      "**Missing Permission**",
      "API error (403): You do not have permission to perform this action. The access token is missing the scope this endpoint requires; it needs one of: event:write, seer:write. Retrying with the same token will not help.",
      "Reconnect Sentry with a token or authorization that includes one of these scopes, then try again.",
    ].join("\n\n");

    it("names the accepted scopes and says retrying won't help", async () => {
      const error = createApiError(detail, 403, detail, { detail }, undefined, [
        "event:write",
        "seer:write",
      ]);

      expect(await formatErrorForUser(error, { transport: "http" })).toBe(
        expected,
      );
      expect(isExpectedToolError(error)).toBe(true);
      expect(logIssue).not.toHaveBeenCalled();
    });

    it("finds the scopes when a tool rewraps the error as an input error", async () => {
      const cause = new ApiPermissionError(detail, detail, { detail }, [
        "event:write",
        "seer:write",
      ]);
      const error = new UserInputError(`API error (403): ${detail}`, {
        cause,
      });

      expect(await formatErrorForUser(error)).toBe(expected);
    });

    it("keeps the input error template for a 403 without a challenge", async () => {
      const result = await formatErrorForUser(createApiError("Forbidden", 403));

      expect(result).toContain("**Input Error**");
      expect(result).toContain("API error (403): Forbidden");
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

  describe("feedback suggestion", () => {
    const session = {
      availableToolNames: new Set(["submit_feedback_to_sentry_team"]),
    };

    it("suggests reporting an unexpected error", async () => {
      const result = await formatErrorForUser(new Error("boom"), { session });

      expect(result).toContain(
        "If this keeps failing, report it to the Sentry MCP team with `submit_feedback_to_sentry_team`.",
      );
    });

    it("suggests reporting a Sentry API server error", async () => {
      const result = await formatErrorForUser(
        createApiError("Internal Error", 500),
        { session },
      );

      expect(result).toContain("`submit_feedback_to_sentry_team`");
    });

    it("suggests reporting an embedded agent failure", async () => {
      const result = await formatErrorForUser(
        new AgentExecutionError("agent failed", { eventId: "evt-1" }),
        { session },
      );

      expect(result).toContain(
        "If rephrasing does not help, report it to the Sentry MCP team with `submit_feedback_to_sentry_team`.",
      );
    });

    it("does not suggest reporting input errors", async () => {
      const result = await formatErrorForUser(new UserInputError("bad input"), {
        session,
      });

      expect(result).not.toContain("submit_feedback_to_sentry_team");
    });

    it("does not suggest reporting without the session tool surface", async () => {
      const result = await formatErrorForUser(new Error("boom"));

      expect(result).not.toContain("submit_feedback_to_sentry_team");
    });
  });
});
