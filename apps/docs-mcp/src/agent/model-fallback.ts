import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import * as Sentry from "@sentry/cloudflare";
import { APICallError, type LanguageModel } from "ai";

// Default OpenRouter model slugs. Change these to swap models across all
// agents in one place. PRIMARY_MODEL is used by lighter synthesis agents,
// PRIMARY_MODEL_HEAVY by reasoning-heavy agents, and FALLBACK_MODEL is the
// shared fallback model.
export const PRIMARY_MODEL = "anthropic/claude-sonnet-4.6";
export const PRIMARY_MODEL_HEAVY = "anthropic/claude-opus-4.6";
export const FALLBACK_MODEL = "openai/gpt-5.4";
export const KIMI_FALLBACK_MODEL = "moonshotai/kimi-k2.5";

type ChatModel = Exclude<LanguageModel, string>;
type CallOptions = Parameters<ChatModel["doGenerate"]>[0];

// Mastra 1.83's provider registry lists FALLBACK_MODEL as not supporting
// temperature, so Mastra dropped temperature, topP, and topK for it.
function callOptionsFor(model: ChatModel, options: CallOptions): CallOptions {
  if (model.modelId !== FALLBACK_MODEL) {
    return options;
  }
  const {
    temperature: _temperature,
    topK: _topK,
    topP: _topP,
    ...rest
  } = options;
  return rest;
}

interface NativeModelFallbackOptions {
  fallbackModelId?: string;
  parallelToolCalls?: boolean;
}

export function createNativeModelFallbacks(
  primaryModelId: string,
  apiKey?: string,
  fallbackOrOptions: string | NativeModelFallbackOptions = {},
): ChatModel {
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
  // keys (`id?: string | null | undefined`), which is not a JSONValue under
  // exactOptionalPropertyTypes, so its models do not match the LanguageModelV2
  // interface they implement. The runtime values are JSON, so assert the
  // interface here.
  const chatModel = (modelId: string) =>
    (options.parallelToolCalls === undefined
      ? openrouter(modelId)
      : openrouter.chat(modelId, {
          parallelToolCalls: options.parallelToolCalls,
        })) as ChatModel;

  return createFallbackModel([
    chatModel(primaryModelId),
    chatModel(options.fallbackModelId ?? FALLBACK_MODEL),
    chatModel(KIMI_FALLBACK_MODEL),
  ]);
}

// Mastra's default model retry: a step may retry a failing model, other than
// the last one, up to twice in total. See createFallbackModel.
const MAX_STEP_RETRIES = 2;
const RETRY_DELAY_MS = 3000;
const MAX_RETRY_AFTER_MS = 30_000;
const CONNECTION_RESET_INITIAL_DELAY_MS = 1000;
const CONNECTION_RESET_RE = /econnreset|socket hang up/i;

function isConnectionReset(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (
      (typeof code === "string" && code.toUpperCase() === "ECONNRESET") ||
      CONNECTION_RESET_RE.test(current.message)
    ) {
      return true;
    }
  }
  return false;
}

/** The delay a provider asked for with `Retry-After-Ms` or `Retry-After`. */
function retryAfterMs(error: unknown): number | undefined {
  if (!APICallError.isInstance(error)) {
    return undefined;
  }
  const headers = new Headers(error.responseHeaders);
  const ms = headers.get("retry-after-ms")?.trim();
  if (ms && /^\d+$/.test(ms)) {
    return Number(ms);
  }
  const retryAfter = headers.get("retry-after")?.trim();
  if (!retryAfter) {
    return undefined;
  }
  if (/^\d+$/.test(retryAfter)) {
    return Number(retryAfter) * 1000;
  }
  const retryAt = Date.parse(retryAfter);
  return retryAt > Date.now() ? retryAt - Date.now() : undefined;
}

/**
 * How long to wait before retrying the same model after `error`, or
 * `undefined` when Mastra would not retry it: it retries connection resets
 * and provider errors marked retryable (408, 409, 429, and 5xx), and waits at
 * least as long as the provider's Retry-After, up to 30 seconds.
 */
function retryDelayMs(error: unknown, retryCount: number): number | undefined {
  let delay: number;
  if (isConnectionReset(error)) {
    delay = Math.min(
      CONNECTION_RESET_INITIAL_DELAY_MS * 2 ** retryCount,
      MAX_RETRY_AFTER_MS,
    );
  } else if (APICallError.isInstance(error) && error.isRetryable) {
    delay = RETRY_DELAY_MS;
  } else {
    return undefined;
  }
  return Math.max(
    delay,
    Math.min(retryAfterMs(error) ?? 0, MAX_RETRY_AFTER_MS),
  );
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the platform rejects with the signal's own abort reason, often a DOMException or a caller-chosen value, and callers check it verbatim
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the platform rejects with the signal's own abort reason, often a DOMException or a caller-chosen value, and callers check it verbatim
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Combine models into one model that tries each of them in order, the way the
 * Mastra 1.83 model fallback list did.
 *
 * Fallback happens per model call, so every agent step starts again with the
 * first model. A model that fails with a retryable error is retried after a
 * delay, at most MAX_STEP_RETRIES times per call across all models, before
 * the next model is tried; the last model is never retried. Callers pass
 * `maxRetries: 0` so the AI SDK does not also retry the whole chain. When
 * every model fails, the last model's error is thrown.
 *
 * Like Mastra, it drops the sampling settings that a model does not support.
 * The response names the model that answered, so a step's
 * `response.modelId` reports the fallback model when one was used.
 */
function createFallbackModel(
  models: readonly [ChatModel, ...ChatModel[]],
): ChatModel {
  async function firstSuccess<T>(
    call: (model: ChatModel) => PromiseLike<T>,
    signal?: AbortSignal,
  ): Promise<{ model: ChatModel; result: T }> {
    let lastError: unknown;
    let retryCount = 0;
    for (const [index, model] of models.entries()) {
      for (;;) {
        try {
          return { model, result: await call(model) };
        } catch (error) {
          lastError = error;
          console.error(
            `[model-fallback] Error executing model ${model.modelId}`,
            error,
          );
          const delay =
            index < models.length - 1 && retryCount < MAX_STEP_RETRIES
              ? retryDelayMs(error, retryCount)
              : undefined;
          if (delay === undefined) {
            break;
          }
          retryCount++;
          await wait(delay, signal);
        }
      }
    }
    throw lastError;
  }

  const [primary] = models;
  return {
    specificationVersion: "v2",
    provider: primary.provider,
    modelId: primary.modelId,
    supportedUrls: primary.supportedUrls,
    async doGenerate(options) {
      const { model, result } = await firstSuccess(
        (candidate) => candidate.doGenerate(callOptionsFor(candidate, options)),
        options.abortSignal,
      );
      return {
        ...result,
        response: {
          ...result.response,
          modelId: result.response?.modelId ?? model.modelId,
        },
      };
    },
    async doStream(options) {
      const { result } = await firstSuccess(
        (candidate) => candidate.doStream(callOptionsFor(candidate, options)),
        options.abortSignal,
      );
      return result;
    },
  };
}
