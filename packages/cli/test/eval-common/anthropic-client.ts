/**
 * Shared LLM provider resolution and chat for the eval frameworks.
 *
 * Both the skill-eval and init-eval suites send single-shot chat completions to
 * Claude models. Provider selection is credential-driven:
 * - `OPENROUTER_API_KEY` set  → OpenRouter (OpenAI-shaped `/chat/completions`)
 * - else `ANTHROPIC_API_KEY`  → Anthropic direct (`@anthropic-ai/sdk`)
 * - neither                   → `null` (callers skip the eval)
 *
 * OpenRouter is **not** Anthropic-Messages-API compatible — it only speaks the
 * OpenAI `/api/v1/chat/completions` schema — so that path uses `fetch` directly
 * rather than the Anthropic SDK, and its model IDs are OpenRouter slugs
 * (`anthropic/claude-sonnet-4.6`). The Anthropic-direct fallback keeps using the
 * SDK with bare model IDs.
 */

/** Default OpenRouter base URL (OpenAI-compatible API root). */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** A single system/user turn to send to the model. */
export type ChatMessage = {
  role: "system" | "user";
  content: string;
};

/**
 * Resolved provider for an eval run.
 *
 * `chat` sends one completion and returns the assistant's text. Implementations
 * differ by provider (OpenRouter fetch vs. Anthropic SDK) but the contract is
 * identical, so callers are provider-agnostic.
 */
export type EvalProvider = {
  /** Which provider was selected — for logging/diagnostics. */
  provider: "openrouter" | "anthropic";
  /** Send a single chat completion and return the assistant's text. */
  chat: (
    model: string,
    messages: ChatMessage[],
    maxTokens: number
  ) => Promise<string>;
};

/**
 * Resolve the eval provider from the environment.
 *
 * @returns provider, or `null` when no API key is available so the caller can
 *   skip (matching the historical `!apiKey` skip behavior).
 */
export function resolveEvalProvider(
  env: NodeJS.ProcessEnv = process.env
): EvalProvider | null {
  const openRouterKey = env.OPENROUTER_API_KEY?.trim();
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();

  if (openRouterKey) {
    const baseURL = env.OPENROUTER_BASE_URL?.trim() || OPENROUTER_BASE_URL;
    return {
      provider: "openrouter",
      chat: (model, messages, maxTokens) =>
        openRouterChat({
          baseURL,
          apiKey: openRouterKey,
          model,
          messages,
          maxTokens,
        }),
    };
  }

  if (anthropicKey) {
    const baseURL = env.ANTHROPIC_BASE_URL?.trim() || undefined;
    return {
      provider: "anthropic",
      chat: (model, messages, maxTokens) =>
        anthropicChat({
          baseURL,
          apiKey: anthropicKey,
          model,
          messages,
          maxTokens,
        }),
    };
  }

  return null;
}

/** Arguments for a single provider chat call. */
type ChatArgs = {
  baseURL: string | undefined;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
};

/**
 * Send a completion to OpenRouter's OpenAI-shaped `/chat/completions` endpoint.
 * System and user turns map directly to OpenAI `messages`.
 */
async function openRouterChat({
  baseURL,
  apiKey,
  model,
  messages,
  maxTokens,
}: ChatArgs): Promise<string> {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`OpenRouter ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}

/**
 * Send a completion via the Anthropic SDK. The single system turn becomes the
 * `system` parameter; user turns become `messages`.
 */
async function anthropicChat({
  baseURL,
  apiKey,
  model,
  messages,
  maxTokens,
}: ChatArgs): Promise<string> {
  // Anthropic direct path only supports Anthropic models; strip the
  // OpenRouter-style `anthropic/` prefix and reject anything else.
  let anthropicModel = model;
  if (model.startsWith("anthropic/")) {
    anthropicModel = model.slice("anthropic/".length);
  } else if (model.startsWith("openai/")) {
    throw new Error(
      `Anthropic direct provider cannot serve OpenAI model "${model}"`
    );
  }

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey, baseURL });

  const system = messages.find((m) => m.role === "system")?.content;
  const userMsgs = messages
    .filter((m) => m.role === "user")
    .map((m) => ({ role: "user" as const, content: m.content }));

  const response = await client.messages.create({
    model: anthropicModel,
    max_tokens: maxTokens,
    system,
    messages: userMsgs,
  });

  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock?.text ?? "";
}
