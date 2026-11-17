import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { ConfigurationError } from "../../errors";
import { getUserAgent } from "../../version";
import type { ProviderOptions } from "./types";

const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.6-luna";
const DEFAULT_OPENROUTER_REASONING_EFFORT = "high";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// Matches @ai-sdk/openai chat providerOptions.openai.reasoningEffort.
const OPENROUTER_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

type OpenRouterReasoningEffort = (typeof OPENROUTER_REASONING_EFFORTS)[number];

// Null prototype so Object.prototype keys like "constructor" cannot slip through.
const OPENROUTER_REASONING_EFFORT_ALIASES: Record<
  string,
  OpenRouterReasoningEffort
> = Object.assign(Object.create(null), {
  // OpenRouter sometimes documents "max"; AI SDK accepts "xhigh".
  max: "xhigh",
});

function resolveOpenRouterReasoningEffort(
  value: string | undefined,
): OpenRouterReasoningEffort | undefined {
  if (value === undefined) {
    return DEFAULT_OPENROUTER_REASONING_EFFORT;
  }

  // Empty string omits the provider option so the model default applies.
  if (value === "") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (Object.hasOwn(OPENROUTER_REASONING_EFFORT_ALIASES, normalized)) {
    return OPENROUTER_REASONING_EFFORT_ALIASES[normalized];
  }

  if (
    (OPENROUTER_REASONING_EFFORTS as readonly string[]).includes(normalized)
  ) {
    return normalized as OpenRouterReasoningEffort;
  }

  throw new ConfigurationError(
    `Invalid OPENROUTER_REASONING_EFFORT "${value}". Expected one of: ${OPENROUTER_REASONING_EFFORTS.join(
      ", ",
    )}, max (alias for xhigh), or "" to omit.`,
  );
}

/**
 * Builds an OpenRouter chat-completions model for embedded agent calls.
 */
export function getOpenRouterModel(model?: string): LanguageModel {
  const factory = createOpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: OPENROUTER_BASE_URL,
    headers: {
      "User-Agent": getUserAgent(),
      "HTTP-Referer": "https://github.com/getsentry/sentry-mcp",
      "X-OpenRouter-Title": "Sentry MCP",
    },
  });

  return factory.chat(
    model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL,
  );
}

/**
 * Provider options for OpenRouter chat-completions calls.
 *
 * Uses the OpenAI chat provider options shape because OpenRouter is accessed
 * through `@ai-sdk/openai` with an OpenRouter base URL.
 */
export function getOpenRouterProviderOptions(): ProviderOptions {
  const reasoningEffort = resolveOpenRouterReasoningEffort(
    process.env.OPENROUTER_REASONING_EFFORT,
  );

  return {
    openai: {
      // Required for optional structured-output fields.
      // See: https://github.com/getsentry/sentry-mcp/issues/623
      structuredOutputs: false,
      strictJsonSchema: false,
      ...(reasoningEffort
        ? {
            reasoningEffort,
          }
        : {}),
    },
  };
}
