import { APICallError, RetryError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeProviderError, runAgent } from "./agent.js";
import type { MCPConnection } from "./types.js";

// Capture the status the Sentry span is given so tests can assert a provider
// failure is reported as an error (code 2) rather than silently swallowed.
const { spanStatuses } = vi.hoisted(() => ({
  spanStatuses: [] as Array<{ code: number }>,
}));

vi.mock("@sentry/core", () => ({
  startNewTrace: (cb: () => unknown) => cb(),
  startSpan: (_opts: unknown, cb: (span: unknown) => unknown) =>
    cb({
      setStatus: (status: { code: number }) => {
        spanStatuses.push(status);
      },
    }),
}));

function createStreamingResponse() {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"openai/gpt-5.6-luna","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"openai/gpt-5.6-luna","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

// A provider error response (invalid key -> 401, rate limit -> 429, 5xx). The
// AI SDK does not throw for these while streaming, it ends textStream empty.
function createErrorResponse(status: number, code: string) {
  return new Response(
    JSON.stringify({
      error: {
        message: `Simulated provider error (${status})`,
        type: "invalid_request_error",
        code,
      },
    }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

// A successful stream that carries no text content, the legitimate empty case.
function createEmptyStreamingResponse() {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"openai/gpt-5.6-luna","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

const testConnection: MCPConnection = {
  client: {
    tools: async () => ({}),
  },
  tools: new Map(),
  disconnect: async () => {},
  sessionId: "test-session",
  transport: "stdio",
};

function captureStdout() {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return chunks;
}

describe("runAgent", () => {
  const originalOpenRouterApiKey = process.env["OPENROUTER_API_KEY"];
  const originalOpenRouterModel = process.env["OPENROUTER_MODEL"];
  const originalMcpModel = process.env["MCP_MODEL"];

  beforeEach(() => {
    spanStatuses.length = 0;
    process.env["OPENROUTER_API_KEY"] = "sk-or-test";
    delete process.env["OPENROUTER_MODEL"];
    delete process.env["MCP_MODEL"];
  });

  afterEach(() => {
    if (originalOpenRouterApiKey === undefined) {
      delete process.env["OPENROUTER_API_KEY"];
    } else {
      process.env["OPENROUTER_API_KEY"] = originalOpenRouterApiKey;
    }

    if (originalOpenRouterModel === undefined) {
      delete process.env["OPENROUTER_MODEL"];
    } else {
      process.env["OPENROUTER_MODEL"] = originalOpenRouterModel;
    }

    if (originalMcpModel === undefined) {
      delete process.env["MCP_MODEL"];
    } else {
      process.env["MCP_MODEL"] = originalMcpModel;
    }

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses OpenRouter chat completions when configured", async () => {
    let requestUrl: string | undefined;
    let authorization: string | null = null;
    let requestBody: unknown;

    vi.spyOn(console, "log").mockImplementation(() => {});

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        requestUrl = request.url;
        authorization = request.headers.get("authorization");
        requestBody = await request.json();

        return createStreamingResponse();
      }),
    );

    const connection: MCPConnection = {
      client: {
        tools: async () => ({}),
      },
      tools: new Map(),
      disconnect: async () => {},
      sessionId: "test-session",
      transport: "stdio",
    };

    await runAgent(connection, "hello", {
      provider: "openrouter",
      maxSteps: 1,
    });

    expect(requestUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(authorization).toBe("Bearer sk-or-test");
    expect(requestBody).toMatchObject({
      model: "openai/gpt-5.6-luna",
      stream: true,
    });
  });

  it("surfaces an authentication error instead of a silent empty response", async () => {
    const output = captureStdout();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => createErrorResponse(401, "invalid_api_key")),
    );

    await expect(
      runAgent(testConnection, "hello", {
        provider: "openrouter",
        maxSteps: 1,
      }),
    ).rejects.toThrow(/authentication failed/i);

    const printed = output.join("");
    // The user must see a real error, not the misleading fallback.
    expect(printed).not.toContain("No response generated");
    expect(printed).toContain("Agent execution failed");
    // The error must reach Sentry: the span is marked errored (code 2).
    expect(spanStatuses).toContainEqual({ code: 2 });
    expect(spanStatuses).not.toContainEqual({ code: 1 });
  });

  it("maps a rate limit error to a clear message", async () => {
    captureStdout();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => createErrorResponse(429, "rate_limit_exceeded")),
    );

    await expect(
      runAgent(testConnection, "hello", {
        provider: "openrouter",
        maxSteps: 1,
      }),
    ).rejects.toThrow(/rate limit exceeded/i);
    expect(spanStatuses).toContainEqual({ code: 2 });
  }, 15000);

  it("still reports a legitimate empty response without throwing", async () => {
    const output = captureStdout();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => createEmptyStreamingResponse()),
    );

    await expect(
      runAgent(testConnection, "hello", {
        provider: "openrouter",
        maxSteps: 1,
      }),
    ).resolves.toBeUndefined();

    expect(output.join("")).toContain("(No response generated)");
    expect(spanStatuses).toContainEqual({ code: 1 });
    expect(spanStatuses).not.toContainEqual({ code: 2 });
  });
});

describe("describeProviderError", () => {
  function apiError(statusCode: number, message = "provider said no") {
    return new APICallError({
      message,
      url: "https://api.example.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode,
    });
  }

  it("maps 401 and 403 to an authentication message with the provider env var", () => {
    expect(describeProviderError(apiError(401), "openai")).toBe(
      "OpenAI API authentication failed. Please check your OPENAI_API_KEY environment variable.",
    );
    expect(describeProviderError(apiError(403), "openrouter")).toBe(
      "OpenRouter API authentication failed. Please check your OPENROUTER_API_KEY environment variable.",
    );
  });

  it("maps 429 to a rate limit message", () => {
    expect(describeProviderError(apiError(429), "openai")).toBe(
      "OpenAI API rate limit exceeded. Please wait and try again.",
    );
  });

  it("maps 5xx to a service error message", () => {
    expect(describeProviderError(apiError(500), "openai")).toBe(
      "OpenAI API service error. The service may be temporarily unavailable.",
    );
    expect(describeProviderError(apiError(503), "openrouter")).toBe(
      "OpenRouter API service error. The service may be temporarily unavailable.",
    );
  });

  it("unwraps a RetryError to classify the underlying provider status", () => {
    const retry = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [apiError(429)],
    });
    expect(describeProviderError(retry, "openrouter")).toBe(
      "OpenRouter API rate limit exceeded. Please wait and try again.",
    );
  });

  it("falls back to the raw message for other API errors", () => {
    expect(describeProviderError(apiError(400, "bad request"), "openai")).toBe(
      "OpenAI API request failed (HTTP 400): bad request",
    );
  });

  it("handles non-API errors", () => {
    expect(describeProviderError(new Error("socket hang up"), "openai")).toBe(
      "OpenAI API request failed: socket hang up",
    );
  });
});
