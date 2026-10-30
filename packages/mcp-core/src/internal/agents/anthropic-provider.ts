import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { USER_AGENT } from "../../version";

// Default configuration constants
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

// Module-level state for baseURL (set only via explicit configuration, not env vars)
let configuredBaseUrl: string | undefined;

/**
 * Configure the Anthropic base URL (CLI flag only, not environment variable).
 * This must be called explicitly - it cannot be set via environment variables for security.
 */
export function setAnthropicBaseUrl(baseUrl: string | undefined): void {
  configuredBaseUrl = baseUrl;
}

/**
 * Retrieve an Anthropic language model configured from environment variables and explicit config.
 *
 * Configuration:
 * - ANTHROPIC_API_KEY: API key for authentication (required)
 * - ANTHROPIC_MODEL: Model to use (default: "claude-sonnet-4-6") - env var OK
 * - Base URL: Must be set via setAnthropicBaseUrl() - NOT from env vars (security risk)
 */
export function getAnthropicModel(model?: string): LanguageModel {
  const defaultModel = process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;

  const factory = createAnthropic({
    ...(configuredBaseUrl && { baseURL: configuredBaseUrl }),
    headers: {
      "User-Agent": USER_AGENT,
    },
  });

  return factory(model ?? defaultModel);
}
