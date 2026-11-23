import type { LanguageModelV3 } from "@ai-sdk/provider";
import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../../errors";
import {
  getAzureOpenAIApiSurface,
  getAzureOpenAIModel,
  setAzureOpenAIBaseUrl,
} from "./azure-openai-provider.js";

describe("azure-openai-provider", () => {
  const originalModel = process.env["OPENAI_MODEL"];
  const originalApiKey = process.env["OPENAI_API_KEY"];
  const originalOpenRouterApiKey = process.env["OPENROUTER_API_KEY"];
  const originalApiVersion = process.env["OPENAI_API_VERSION"];

  beforeEach(() => {
    setAzureOpenAIBaseUrl(undefined);
    delete process.env["OPENAI_MODEL"];
    delete process.env["OPENROUTER_API_KEY"];
    delete process.env["OPENAI_API_VERSION"];
  });

  afterEach(() => {
    if (originalModel === undefined) {
      delete process.env["OPENAI_MODEL"];
    } else {
      process.env["OPENAI_MODEL"] = originalModel;
    }

    if (originalApiKey === undefined) {
      delete process.env["OPENAI_API_KEY"];
    } else {
      process.env["OPENAI_API_KEY"] = originalApiKey;
    }

    if (originalOpenRouterApiKey === undefined) {
      delete process.env["OPENROUTER_API_KEY"];
    } else {
      process.env["OPENROUTER_API_KEY"] = originalOpenRouterApiKey;
    }

    if (originalApiVersion === undefined) {
      delete process.env["OPENAI_API_VERSION"];
    } else {
      process.env["OPENAI_API_VERSION"] = originalApiVersion;
    }

    vi.unstubAllGlobals();
  });

  it("requires an explicit Azure base URL", () => {
    expect(() => getAzureOpenAIModel()).toThrow(ConfigurationError);
    expect(() => getAzureOpenAIModel()).toThrow(/requires --openai-base-url/);
  });

  it("rejects unsupported Azure base URL shapes", () => {
    setAzureOpenAIBaseUrl("https://proxy.example.com/v1");

    expect(() => getAzureOpenAIApiSurface()).toThrow(ConfigurationError);
    expect(() => getAzureOpenAIApiSurface()).toThrow(
      /requires an Azure v1 base URL ending in \/openai\/v1 or a deployment URL/,
    );
  });

  it("uses responses API for Azure v1 endpoints", async () => {
    process.env["OPENAI_API_KEY"] = "test-key";
    process.env["OPENAI_API_VERSION"] = "2024-02-15-preview";
    setAzureOpenAIBaseUrl("https://proxy.example.com/openai/v1/");
    let requestUrl: string | undefined;
    let apiKeyHeader: string | null | undefined;

    const fetchMock = vi.fn(
      async (input: Request | URL | string, init?: RequestInit) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        requestUrl = request.url;
        apiKeyHeader = request.headers.get("api-key");

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
        model: getAzureOpenAIModel("my-assistant"),
        prompt: "hello",
      }),
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestUrl).toBe("https://proxy.example.com/openai/v1/responses");
    expect(requestUrl).not.toContain("api-version=");
    expect(apiKeyHeader).toBe("test-key");
  });

  it("uses chat completions for deployment-style Azure endpoints", async () => {
    process.env["OPENAI_API_KEY"] = "test-key";
    process.env["OPENAI_API_VERSION"] = "2024-02-15-preview";
    setAzureOpenAIBaseUrl(
      "https://proxy.example.com/openai/deployments/test-model",
    );
    let requestUrl: string | undefined;
    let apiKeyHeader: string | null | undefined;

    const fetchMock = vi.fn(
      async (input: Request | URL | string, init?: RequestInit) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        requestUrl = request.url;
        apiKeyHeader = request.headers.get("api-key");

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
        model: getAzureOpenAIModel("my-company-assistant"),
        prompt: "hello",
      }),
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestUrl).toBe(
      "https://proxy.example.com/openai/deployments/test-model/chat/completions?api-version=2024-02-15-preview",
    );
    expect(apiKeyHeader).toBe("test-key");
  });

  it("treats deployment aliases as opaque model identifiers", () => {
    setAzureOpenAIBaseUrl("https://proxy.example.com/openai/v1/");

    const model = getAzureOpenAIModel(
      "my-company-assistant",
    ) as LanguageModelV3;

    expect(model.modelId).toBe("my-company-assistant");
  });
});
