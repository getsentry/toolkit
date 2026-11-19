import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getAgentProvider,
  setAgentProvider,
  getResolvedProviderType,
} from "./provider-factory.js";
import { setAzureOpenAIBaseUrl } from "./azure-openai-provider.js";
import { ConfigurationError } from "../../errors.js";

describe("provider-factory", () => {
  const originalAnthropicKey = process.env["ANTHROPIC_API_KEY"];
  const originalOpenAIKey = process.env["OPENAI_API_KEY"];
  const originalOpenRouterKey = process.env["OPENROUTER_API_KEY"];
  const originalProviderEnv = process.env["EMBEDDED_AGENT_PROVIDER"];

  beforeEach(() => {
    // Reset module state
    setAgentProvider(undefined);
    setAzureOpenAIBaseUrl(undefined);
    // Clear environment variables
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    delete process.env["OPENROUTER_API_KEY"];
    delete process.env["EMBEDDED_AGENT_PROVIDER"];
  });

  afterEach(() => {
    // Restore original environment
    if (originalAnthropicKey === undefined) {
      delete process.env["ANTHROPIC_API_KEY"];
    } else {
      process.env["ANTHROPIC_API_KEY"] = originalAnthropicKey;
    }
    if (originalOpenAIKey === undefined) {
      delete process.env["OPENAI_API_KEY"];
    } else {
      process.env["OPENAI_API_KEY"] = originalOpenAIKey;
    }
    if (originalOpenRouterKey === undefined) {
      delete process.env["OPENROUTER_API_KEY"];
    } else {
      process.env["OPENROUTER_API_KEY"] = originalOpenRouterKey;
    }
    if (originalProviderEnv === undefined) {
      delete process.env["EMBEDDED_AGENT_PROVIDER"];
    } else {
      process.env["EMBEDDED_AGENT_PROVIDER"] = originalProviderEnv;
    }
    setAgentProvider(undefined);
    setAzureOpenAIBaseUrl(undefined);
  });

  describe("single API key auto-detection", () => {
    it("detects anthropic when only ANTHROPIC_API_KEY is set", () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";

      const provider = getAgentProvider();
      expect(provider.type).toBe("anthropic");
    });

    it("detects openai when only OPENAI_API_KEY is set", () => {
      process.env["OPENAI_API_KEY"] = "sk-test";

      const provider = getAgentProvider();
      expect(provider.type).toBe("openai");
    });

    it("detects openrouter when only OPENROUTER_API_KEY is set", () => {
      process.env["OPENROUTER_API_KEY"] = "sk-or-test";

      const provider = getAgentProvider();
      expect(provider.type).toBe("openrouter");
    });

    it("returns undefined from getResolvedProviderType when no API keys", () => {
      const providerType = getResolvedProviderType();
      expect(providerType).toBeUndefined();
    });

    it("throws ConfigurationError when no API keys", () => {
      expect(() => getAgentProvider()).toThrow(ConfigurationError);
      expect(() => getAgentProvider()).toThrow(
        /No embedded agent provider configured/,
      );
    });
  });

  describe("multiple API keys with explicit provider", () => {
    it("uses openai when both keys present and EMBEDDED_AGENT_PROVIDER=openai", () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
      process.env["OPENAI_API_KEY"] = "sk-test";
      process.env["EMBEDDED_AGENT_PROVIDER"] = "openai";

      const provider = getAgentProvider();
      expect(provider.type).toBe("openai");
    });

    it("uses anthropic when both keys present and EMBEDDED_AGENT_PROVIDER=anthropic", () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
      process.env["OPENAI_API_KEY"] = "sk-test";
      process.env["EMBEDDED_AGENT_PROVIDER"] = "anthropic";

      const provider = getAgentProvider();
      expect(provider.type).toBe("anthropic");
    });

    it("uses azure-openai when both keys present and EMBEDDED_AGENT_PROVIDER=azure-openai", () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
      process.env["OPENAI_API_KEY"] = "sk-test";
      process.env["EMBEDDED_AGENT_PROVIDER"] = "azure-openai";
      setAzureOpenAIBaseUrl("https://example.openai.azure.com/openai/v1/");

      const provider = getAgentProvider();
      expect(provider.type).toBe("azure-openai");
    });

    it("uses openrouter when multiple keys are present and EMBEDDED_AGENT_PROVIDER=openrouter", () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
      process.env["OPENAI_API_KEY"] = "sk-test";
      process.env["OPENROUTER_API_KEY"] = "sk-or-test";
      process.env["EMBEDDED_AGENT_PROVIDER"] = "openrouter";

      const provider = getAgentProvider();
      expect(provider.type).toBe("openrouter");
    });

    it("uses openai when both keys present and setAgentProvider called", () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
      process.env["OPENAI_API_KEY"] = "sk-test";
      setAgentProvider("openai");

      const provider = getAgentProvider();
      expect(provider.type).toBe("openai");
    });

    it("returns correct provider from getResolvedProviderType with explicit config", () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
      process.env["OPENAI_API_KEY"] = "sk-test";
      process.env["EMBEDDED_AGENT_PROVIDER"] = "openai";

      const providerType = getResolvedProviderType();
      expect(providerType).toBe("openai");
    });
  });

  describe("multiple API keys without explicit provider", () => {
    it("throws ConfigurationError when both keys present", () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
      process.env["OPENAI_API_KEY"] = "sk-test";

      expect(() => getAgentProvider()).toThrow(ConfigurationError);
    });

    it("provides helpful error message about setting EMBEDDED_AGENT_PROVIDER", () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
      process.env["OPENAI_API_KEY"] = "sk-test";

      expect(() => getAgentProvider()).toThrow(/Multiple LLM API keys are set/);
      expect(() => getAgentProvider()).toThrow(
        /EMBEDDED_AGENT_PROVIDER environment variable/,
      );
      expect(() => getAgentProvider()).toThrow(
        /'openai', 'azure-openai', 'anthropic', or 'openrouter'/,
      );
    });

    it("returns undefined from getResolvedProviderType when both keys present", () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
      process.env["OPENAI_API_KEY"] = "sk-test";

      const providerType = getResolvedProviderType();
      expect(providerType).toBeUndefined();
    });
  });

  describe("explicit provider validation", () => {
    it("throws ConfigurationError when explicit provider lacks API key", () => {
      process.env["EMBEDDED_AGENT_PROVIDER"] = "openai";
      // No OPENAI_API_KEY set

      expect(() => getAgentProvider()).toThrow(ConfigurationError);
      expect(() => getAgentProvider()).toThrow(/OPENAI_API_KEY is not set/);
    });

    it("returns undefined from getResolvedProviderType when explicit provider lacks API key", () => {
      process.env["EMBEDDED_AGENT_PROVIDER"] = "openai";
      // No OPENAI_API_KEY set

      const providerType = getResolvedProviderType();
      expect(providerType).toBeUndefined();
    });

    it("throws ConfigurationError when explicit openrouter lacks API key", () => {
      process.env["EMBEDDED_AGENT_PROVIDER"] = "openrouter";

      expect(() => getAgentProvider()).toThrow(ConfigurationError);
      expect(() => getAgentProvider()).toThrow(/OPENROUTER_API_KEY is not set/);
    });

    it("throws ConfigurationError when azure-openai lacks a supported base URL", () => {
      process.env["OPENAI_API_KEY"] = "sk-test";
      process.env["EMBEDDED_AGENT_PROVIDER"] = "azure-openai";

      expect(() => getAgentProvider()).toThrow(ConfigurationError);
      expect(() => getAgentProvider()).toThrow(/requires --openai-base-url/);
    });

    it("returns undefined from getResolvedProviderType when azure-openai lacks a supported base URL", () => {
      process.env["OPENAI_API_KEY"] = "sk-test";
      process.env["EMBEDDED_AGENT_PROVIDER"] = "azure-openai";

      const providerType = getResolvedProviderType();
      expect(providerType).toBeUndefined();
    });
  });

  describe("provider precedence", () => {
    it("prefers setAgentProvider over EMBEDDED_AGENT_PROVIDER", () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
      process.env["OPENAI_API_KEY"] = "sk-test";
      process.env["EMBEDDED_AGENT_PROVIDER"] = "anthropic";
      setAgentProvider("openai");

      const provider = getAgentProvider();
      expect(provider.type).toBe("openai");
    });

    it("prefers EMBEDDED_AGENT_PROVIDER over auto-detection", () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
      process.env["OPENAI_API_KEY"] = "sk-test";
      process.env["EMBEDDED_AGENT_PROVIDER"] = "openai";

      const provider = getAgentProvider();
      expect(provider.type).toBe("openai");
    });
  });

  describe("provider labels", () => {
    it("labels openai as responses", () => {
      process.env["OPENAI_API_KEY"] = "sk-test";

      const provider = getAgentProvider();
      expect(provider.label).toBe("openai responses API");
    });

    it("labels anthropic without an API surface suffix", () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";

      const provider = getAgentProvider();
      expect(provider.label).toBe("anthropic");
    });

    it("labels azure-openai v1 endpoints as responses", () => {
      process.env["OPENAI_API_KEY"] = "sk-test";
      process.env["EMBEDDED_AGENT_PROVIDER"] = "azure-openai";
      setAzureOpenAIBaseUrl("https://example.openai.azure.com/openai/v1/");

      const provider = getAgentProvider();
      expect(provider.label).toBe("azure-openai responses API");
    });

    it("labels azure-openai deployment endpoints as chat completions", () => {
      process.env["OPENAI_API_KEY"] = "sk-test";
      process.env["EMBEDDED_AGENT_PROVIDER"] = "azure-openai";
      setAzureOpenAIBaseUrl(
        "https://example.openai.azure.com/openai/deployments/my-assistant",
      );

      const provider = getAgentProvider();
      expect(provider.label).toBe("azure-openai chat completions API");
    });

    it("labels openrouter", () => {
      process.env["OPENROUTER_API_KEY"] = "sk-or-test";

      const provider = getAgentProvider();
      expect(provider.label).toBe("openrouter");
    });
  });
});
