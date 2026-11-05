import type { LanguageModelV3 } from "@ai-sdk/provider";
import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../../errors.js";
import {
  getOpenRouterModel,
  getOpenRouterProviderOptions,
} from "./openrouter-provider.js";

describe("openrouter-provider", () => {
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  const originalModel = process.env.OPENROUTER_MODEL;
  const originalReasoningEffort = process.env.OPENROUTER_REASONING_EFFORT;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    delete process.env.OPENROUTER_MODEL;
    delete process.env.OPENROUTER_REASONING_EFFORT;
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalApiKey;
    }

    if (originalModel === undefined) {
      delete process.env.OPENROUTER_MODEL;
    } else {
      process.env.OPENROUTER_MODEL = originalModel;
    }

    if (originalReasoningEffort === undefined) {
      delete process.env.OPENROUTER_REASONING_EFFORT;
    } else {
      process.env.OPENROUTER_REASONING_EFFORT = originalReasoningEffort;
    }

    vi.unstubAllGlobals();
  });

  it("uses the OpenRouter chat completions endpoint", async () => {
    let requestUrl: string | undefined;
    let authorization: string | null = null;

    const fetchMock = vi.fn(
      async (input: Request | URL | string, init?: RequestInit) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        requestUrl = request.url;
        authorization = request.headers.get("authorization");

        return new Response(
          JSON.stringify({
            error: {
              message: "boom",
              type: "invalid_request_error",
              param: null,
              code: "bad_request",
            },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateText({
        model: getOpenRouterModel(),
        prompt: "hello",
      }),
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(authorization).toBe("Bearer test-openrouter-key");
  });

  it("uses default and configured models", () => {
    expect((getOpenRouterModel() as LanguageModelV3).modelId).toBe(
      "openai/gpt-5.6-luna",
    );

    process.env.OPENROUTER_MODEL = "anthropic/claude-sonnet-4";

    expect((getOpenRouterModel() as LanguageModelV3).modelId).toBe(
      "anthropic/claude-sonnet-4",
    );
    expect(
      (getOpenRouterModel("google/gemini-2.5-pro") as LanguageModelV3).modelId,
    ).toBe("google/gemini-2.5-pro");
  });

  it("defaults reasoning effort to high and allows override", () => {
    expect(getOpenRouterProviderOptions()).toEqual({
      openai: {
        structuredOutputs: false,
        strictJsonSchema: false,
        reasoningEffort: "high",
      },
    });

    process.env.OPENROUTER_REASONING_EFFORT = "low";

    expect(getOpenRouterProviderOptions()).toEqual({
      openai: {
        structuredOutputs: false,
        strictJsonSchema: false,
        reasoningEffort: "low",
      },
    });

    process.env.OPENROUTER_REASONING_EFFORT = "";

    expect(getOpenRouterProviderOptions()).toEqual({
      openai: {
        structuredOutputs: false,
        strictJsonSchema: false,
      },
    });
  });

  it("maps max to xhigh and rejects unknown reasoning effort", () => {
    process.env.OPENROUTER_REASONING_EFFORT = "max";

    expect(getOpenRouterProviderOptions()).toEqual({
      openai: {
        structuredOutputs: false,
        strictJsonSchema: false,
        reasoningEffort: "xhigh",
      },
    });

    process.env.OPENROUTER_REASONING_EFFORT = "ludicrous";

    expect(() => getOpenRouterProviderOptions()).toThrow(ConfigurationError);
    expect(() => getOpenRouterProviderOptions()).toThrow(
      /Invalid OPENROUTER_REASONING_EFFORT/,
    );

    // Prototype keys must not bypass validation via inherited Object props.
    process.env.OPENROUTER_REASONING_EFFORT = "constructor";

    expect(() => getOpenRouterProviderOptions()).toThrow(ConfigurationError);
  });
});
