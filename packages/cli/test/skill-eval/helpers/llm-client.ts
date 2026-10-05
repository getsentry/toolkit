/**
 * LLM client for the skill eval framework.
 *
 * Wraps the resolved {@link EvalProvider} (OpenRouter or Anthropic direct) and
 * carries the agent/judge model IDs for a run. Model defaults are OpenRouter
 * slugs; override via `EVAL_AGENT_MODELS` / `EVAL_JUDGE_MODEL`.
 */

import type {
  ChatMessage,
  EvalProvider,
} from "../../eval-common/anthropic-client.js";

/** Default agent models — the target models for the skill (OpenRouter slugs). */
export const DEFAULT_AGENT_MODELS = [
  "anthropic/claude-sonnet-5",
  "openai/gpt-5.6-luna",
];

/** Default judge model — cheap and fast, just needs to grade command plans. */
export const DEFAULT_JUDGE_MODEL = "anthropic/claude-haiku-4.5";

export type LLMClient = {
  provider: EvalProvider;
  agentModels: string[];
  judgeModel: string;
};

/**
 * Create an LLM client for the eval framework.
 *
 * Agent models and judge model can be overridden via env vars:
 * - EVAL_AGENT_MODELS: comma-separated list of model IDs
 * - EVAL_JUDGE_MODEL: single model ID
 *
 * @param provider - Resolved provider (OpenRouter or Anthropic direct)
 */
export function createClient(provider: EvalProvider): LLMClient {
  const agentModels = process.env.EVAL_AGENT_MODELS
    ? process.env.EVAL_AGENT_MODELS.split(",").map((m) => m.trim())
    : DEFAULT_AGENT_MODELS;

  const judgeModel = process.env.EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;

  return { provider, agentModels, judgeModel };
}

/** Send a message and return the text response. */
export function chatCompletion(
  llm: LLMClient,
  model: string,
  messages: ChatMessage[],
  maxTokens = 2048
): Promise<string> {
  return llm.provider.chat(model, messages, maxTokens);
}
