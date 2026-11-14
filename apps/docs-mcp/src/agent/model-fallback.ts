import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { MastraModelConfig } from "@mastra/core/llm";
import * as Sentry from "@sentry/cloudflare";

// Default OpenRouter model slugs. Change these to swap models across all
// agents in one place. PRIMARY_MODEL is used by lighter synthesis agents,
// PRIMARY_MODEL_HEAVY by reasoning-heavy agents, and FALLBACK_MODEL is the
// shared fallback model.
export const PRIMARY_MODEL = "anthropic/claude-sonnet-4.6";
export const PRIMARY_MODEL_HEAVY = "anthropic/claude-opus-4.6";
export const FALLBACK_MODEL = "openai/gpt-5.4";
export const KIMI_FALLBACK_MODEL = "moonshotai/kimi-k2.5";

/** The AI SDK v5 model interface (LanguageModelV2) as Mastra types it. */
type LanguageModelV2 = Extract<
  MastraModelConfig,
  { specificationVersion: "v2" }
>;

interface NativeModelFallbackOptions {
  fallbackModelId?: string;
  parallelToolCalls?: boolean;
}

export function createNativeModelFallbacks(
  primaryModelId: string,
  apiKey?: string,
  fallbackOrOptions: string | NativeModelFallbackOptions = {},
) {
  if (!apiKey) {
    console.warn(
      "[model-fallback] OPENROUTER_API_KEY missing — models disabled",
    );
    Sentry.addBreadcrumb({
      category: "model-fallback",
      level: "warning",
      message: "OPENROUTER_API_KEY missing — models disabled",
    });
  }

  const openrouter = createOpenRouter(apiKey ? { apiKey } : {});
  const options =
    typeof fallbackOrOptions === "string"
      ? { fallbackModelId: fallbackOrOptions }
      : fallbackOrOptions;
  // @openrouter/ai-sdk-provider 1.5.4 types `providerMetadata` with optional
  // keys (`id?: string | null | undefined`). Under exactOptionalPropertyTypes
  // that is not a `JSONValue`, so the provider's models no longer match the
  // LanguageModelV2 interface they implement (its own declarations fail with
  // TS2416). The runtime values are JSON, so assert the interface here.
  const chatModel = (modelId: string) =>
    (options.parallelToolCalls === undefined
      ? openrouter(modelId)
      : openrouter.chat(modelId, {
          parallelToolCalls: options.parallelToolCalls,
        })) as LanguageModelV2;

  // maxRetries controls the outer fallback loop in Mastra's
  // executeStreamWithFallbackModels. p-retry inside Mastra's execute()
  // already provides inner retries (default 2 = 3 total attempts).
  // Setting outer maxRetries to 0 moves to the next model after those
  // inner retries instead of retrying the same model chain again.
  return [
    {
      id: "openrouter-primary",
      maxRetries: 0,
      model: chatModel(primaryModelId),
    },
    {
      id: "openrouter-fallback",
      maxRetries: 0,
      model: chatModel(options.fallbackModelId ?? FALLBACK_MODEL),
    },
    {
      id: "openrouter-kimi-fallback",
      maxRetries: 0,
      model: chatModel(KIMI_FALLBACK_MODEL),
    },
  ];
}
