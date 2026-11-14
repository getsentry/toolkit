import { ConfigurationError } from "../../errors";
import { getAnthropicModel, setAnthropicBaseUrl } from "./anthropic-provider";
import {
  getAzureOpenAIApiSurface,
  getAzureOpenAIModel,
  setAzureOpenAIBaseUrl,
} from "./azure-openai-provider";
import { getOpenAIModel, setOpenAIBaseUrl } from "./openai-provider";
import {
  getOpenRouterModel,
  getOpenRouterProviderOptions,
} from "./openrouter-provider";
import type { AgentProviderType, EmbeddedAgentProvider } from "./types";

// Module-level state for explicit provider selection
let configuredProvider: AgentProviderType | undefined;

/**
 * Configure the embedded agent provider explicitly.
 * Call this from CLI to override auto-detection.
 */
export function setAgentProvider(
  provider: AgentProviderType | undefined,
): void {
  configuredProvider = provider;
}

/**
 * Configure base URLs for providers (called from CLI).
 */
export function setProviderBaseUrls(config: {
  openaiBaseUrl?: string | undefined;
  anthropicBaseUrl?: string | undefined;
}): void {
  setOpenAIBaseUrl(config.openaiBaseUrl);
  setAzureOpenAIBaseUrl(config.openaiBaseUrl);
  setAnthropicBaseUrl(config.anthropicBaseUrl);
}

/**
 * Check if both API keys are present, indicating a conflict.
 */
function detectProviderConflict(): boolean {
  return (
    [
      process.env["ANTHROPIC_API_KEY"],
      process.env["OPENAI_API_KEY"],
      process.env["OPENROUTER_API_KEY"],
    ].filter(Boolean).length > 1
  );
}

/**
 * Check if the API key exists for a given provider type.
 */
function hasApiKeyForProvider(type: AgentProviderType): boolean {
  switch (type) {
    case "anthropic":
      return Boolean(process.env["ANTHROPIC_API_KEY"]);
    case "openai":
    case "azure-openai":
      return Boolean(process.env["OPENAI_API_KEY"]);
    case "openrouter":
      return Boolean(process.env["OPENROUTER_API_KEY"]);
  }
}

/**
 * Get the expected API key name for a provider type.
 */
function getApiKeyName(type: AgentProviderType): string {
  switch (type) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
    case "azure-openai":
      return "OPENAI_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
  }
}

/**
 * Build a provider instance for the given type.
 */
function buildProvider(type: AgentProviderType): EmbeddedAgentProvider {
  switch (type) {
    case "anthropic":
      return {
        type: "anthropic",
        label: "anthropic",
        getModel: getAnthropicModel,
        // Anthropic doesn't need the structuredOutputs workaround
        getProviderOptions: () => ({}),
      };
    case "openai":
      return {
        type: "openai",
        label: "openai responses API",
        getModel: getOpenAIModel,
        // OpenAI requires structuredOutputs: false for optional fields
        // See: https://github.com/getsentry/sentry-mcp/issues/623
        getProviderOptions: () => ({
          openai: {
            structuredOutputs: false,
            strictJsonSchema: false,
          },
        }),
      };
    case "azure-openai": {
      // Validate Azure-only configuration up front so explicit misconfiguration
      // is surfaced before any tool calls.
      const apiSurface = getAzureOpenAIApiSurface();

      return {
        type: "azure-openai",
        label: `azure-openai ${
          apiSurface === "chat-completions" ? "chat completions" : "responses"
        } API`,
        getModel: getAzureOpenAIModel,
        getProviderOptions: () => ({
          openai: {
            structuredOutputs: false,
            strictJsonSchema: false,
          },
        }),
      };
    }
    case "openrouter":
      return {
        type: "openrouter",
        label: "openrouter",
        getModel: getOpenRouterModel,
        getProviderOptions: getOpenRouterProviderOptions,
      };
  }
}

/**
 * Resolve provider type from configuration and environment.
 * Returns undefined if no provider can be resolved or if there's a conflict.
 */
function resolveProviderType(): AgentProviderType | undefined {
  // 1. Explicit configuration
  if (configuredProvider) {
    return configuredProvider;
  }

  // 2. Environment variable
  const envProvider = process.env["EMBEDDED_AGENT_PROVIDER"]?.toLowerCase();
  if (
    envProvider === "openai" ||
    envProvider === "azure-openai" ||
    envProvider === "anthropic" ||
    envProvider === "openrouter"
  ) {
    return envProvider;
  }

  // 3. Check for conflicts
  if (detectProviderConflict()) {
    return undefined; // Conflict - require explicit selection
  }

  // 4. Auto-detect
  if (process.env["ANTHROPIC_API_KEY"]) return "anthropic";
  if (process.env["OPENAI_API_KEY"]) return "openai";
  if (process.env["OPENROUTER_API_KEY"]) return "openrouter";

  return undefined;
}

/**
 * Get the current agent provider based on configuration.
 *
 * Resolution order:
 * 1. Explicit configuration via setAgentProvider()
 * 2. EMBEDDED_AGENT_PROVIDER environment variable
 * 3. Detect conflicts when both API keys are present
 * 4. Auto-detect: check ANTHROPIC_API_KEY, then OPENAI_API_KEY
 * 5. Throw ConfigurationError if no provider available
 */
export function getAgentProvider(): EmbeddedAgentProvider {
  const providerType = resolveProviderType();

  // Validate API key for explicitly configured provider
  if (providerType && !hasApiKeyForProvider(providerType)) {
    throw new ConfigurationError(
      `Provider "${providerType}" is configured but ${getApiKeyName(providerType)} is not set. Please set the API key environment variable.`,
    );
  }

  // Check for conflicts when both API keys are present
  if (!providerType && detectProviderConflict()) {
    throw new ConfigurationError(
      "Multiple LLM API keys are set. " +
        "Please specify which provider to use by setting the EMBEDDED_AGENT_PROVIDER environment variable to 'openai', 'azure-openai', 'anthropic', or 'openrouter'.",
    );
  }

  // No provider available
  if (!providerType) {
    throw new ConfigurationError(
      "No embedded agent provider configured. " +
        "Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY environment variable, " +
        "or use --agent-provider flag to specify a provider.",
    );
  }

  return buildProvider(providerType);
}

/**
 * Check if an embedded agent provider is available.
 * Returns true if getAgentProvider() would succeed.
 */
export function hasAgentProvider(): boolean {
  try {
    getAgentProvider();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the resolved provider type without throwing.
 * Returns undefined if no provider is available, API key is missing, or both API keys are present without explicit selection.
 */
export function getResolvedProviderType(): AgentProviderType | undefined {
  try {
    return getAgentProvider().type;
  } catch {
    return undefined;
  }
}
