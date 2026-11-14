import type { LanguageModelV3 } from "@ai-sdk/provider";
import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOpenAIModel, setOpenAIBaseUrl } from "./openai-provider.js";

describe("openai-provider", () => {
  const originalModel = process.env["OPENAI_MODEL"];
  const originalApiKey = process.env["OPENAI_API_KEY"];
  const originalOpenRouterApiKey = process.env["OPENROUTER_API_KEY"];
  const originalApiVersion = process.env["OPENAI_API_VERSION"];

  beforeEach(() => {
    setOpenAIBaseUrl(undefined);
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

  describe("base URL configuration", () => {
    it("uses default base URL when not configured", () => {
      const model = getOpenAIModel() as LanguageModelV3;

      expect(model).toBeDefined();
      expect(model.modelId).toBe("gpt-5");
    });

    it("uses configured base URL", () => {
      setOpenAIBaseUrl("https://custom-openai.example.com");

      const model = getOpenAIModel() as LanguageModelV3;

      expect(model).toBeDefined();
      expect(model.modelId).toBe("gpt-5");
    });

    it("uses responses API for generic custom base URL requests", async () => {
      process.env["OPENAI_API_KEY"] = "test-key";
      setOpenAIBaseUrl("https://proxy.example.com/v1");
      let requestUrl: string | undefined;

      const fetchMock = vi.fn(
        async (input: Request | URL | string, init?: RequestInit) => {
          const request =
            input instanceof Request
              ? new Request(input, init)
              : new Request(input.toString(), init);
          requestUrl = request.url;

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
          model: getOpenAIModel(),
          prompt: "hello",
        }),
      ).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(requestUrl).toBe("https://proxy.example.com/v1/responses");
    });

    it("keeps responses API for deployment-style URLs in generic openai mode", async () => {
      process.env["OPENAI_API_KEY"] = "test-key";
      setOpenAIBaseUrl(
        "https://proxy.example.com/openai/deployments/test-model",
      );
      let requestUrl: string | undefined;

      const fetchMock = vi.fn(
        async (input: Request | URL | string, init?: RequestInit) => {
          const request =
            input instanceof Request
              ? new Request(input, init)
              : new Request(input.toString(), init);
          requestUrl = request.url;

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
          model: getOpenAIModel("my-company-assistant"),
          prompt: "hello",
        }),
      ).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(requestUrl).toBe(
        "https://proxy.example.com/openai/deployments/test-model/responses",
      );
    });

    it("ignores OPENAI_API_VERSION for generic openai provider requests", async () => {
      process.env["OPENAI_API_KEY"] = "test-key";
      process.env["OPENAI_API_VERSION"] = "2024-02-15-preview";
      setOpenAIBaseUrl("https://proxy.example.com/v1");
      let requestUrl: string | undefined;

      const fetchMock = vi.fn(
        async (input: Request | URL | string, init?: RequestInit) => {
          const request =
            input instanceof Request
              ? new Request(input, init)
              : new Request(input.toString(), init);
          requestUrl = request.url;

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
          model: getOpenAIModel("my-company-assistant"),
          prompt: "hello",
        }),
      ).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(requestUrl).toBe("https://proxy.example.com/v1/responses");
      expect(requestUrl).not.toContain("api-version=");
    });
  });

  describe("model override", () => {
    it("uses default model when not specified", () => {
      const model = getOpenAIModel() as LanguageModelV3;

      expect(model.modelId).toBe("gpt-5");
    });

    it("uses specified model when provided", () => {
      const model = getOpenAIModel("gpt-4") as LanguageModelV3;

      expect(model.modelId).toBe("gpt-4");
    });

    it("uses OPENAI_MODEL env var when set", () => {
      process.env["OPENAI_MODEL"] = "gpt-4-turbo";

      const model = getOpenAIModel() as LanguageModelV3;

      expect(model.modelId).toBe("gpt-4-turbo");
    });
  });
});
