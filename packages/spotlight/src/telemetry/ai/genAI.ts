import { normalizePromptMessages } from "./messages.ts";
import { stringifyValue } from "../utils/stringifyValue.ts";
import { finiteNumber } from "../utils/finiteNumber.ts";
import { getAllSpansInTree } from "../store/helpers.ts";
import type { AILibraryHandler, AIToolCall, AITrace, Span } from "../types.ts";
import { extractFinishReason } from "./finishReason.ts";

// Generic handler for the standardized `gen_ai.*` span conventions. Any SDK
// that follows sentry-conventions (sentry-python's PydanticAI/OpenAI/Anthropic
// integrations, the OTel GenAI conventions, ...) maps through here regardless
// of provider — the provider is just the `gen_ai.system` attribute, not a
// reason to fork the handler. The Vercel AI SDK keeps its own handler only
// because it emits proprietary `vercel.ai.*` fields on top of `gen_ai.*`.
// https://github.com/getsentry/sentry-conventions/tree/main/model/attributes/gen_ai
const GEN_AI_OP_PREFIX = "gen_ai.";
const VERCEL_FIELD_PREFIX = "vercel.ai.";

// Span ops
const GEN_AI_CHAT_OP = "gen_ai.chat";
const GEN_AI_INVOKE_AGENT_OP = "gen_ai.invoke_agent";
const GEN_AI_EXECUTE_TOOL_OP = "gen_ai.execute_tool";

// Span data fields (sentry-conventions gen_ai.*)
const GEN_AI_OPERATION_NAME_FIELD = "gen_ai.operation.name";
const GEN_AI_AGENT_NAME_FIELD = "gen_ai.agent.name";
const GEN_AI_SYSTEM_FIELD = "gen_ai.system";
const GEN_AI_REQUEST_MODEL_FIELD = "gen_ai.request.model";
const GEN_AI_RESPONSE_MODEL_FIELD = "gen_ai.response.model";
const GEN_AI_USAGE_INPUT_TOKENS_FIELD = "gen_ai.usage.input_tokens";
const GEN_AI_USAGE_OUTPUT_TOKENS_FIELD = "gen_ai.usage.output_tokens";
const GEN_AI_REQUEST_MESSAGES_FIELD = "gen_ai.request.messages";
const GEN_AI_SYSTEM_INSTRUCTIONS_FIELD = "gen_ai.system_instructions";
const GEN_AI_RESPONSE_TEXT_FIELD = "gen_ai.response.text";
const GEN_AI_RESPONSE_TOOL_CALLS_FIELD = "gen_ai.response.tool_calls";
const GEN_AI_RESPONSE_FINISH_REASONS_FIELD = "gen_ai.response.finish_reasons";
const GEN_AI_TOOL_NAME_FIELD = "gen_ai.tool.name";
const GEN_AI_TOOL_CALL_ID_FIELD = "gen_ai.tool.call.id";
const GEN_AI_TOOL_INPUT_FIELD = "gen_ai.tool.input";
const GEN_AI_TOOL_OUTPUT_FIELD = "gen_ai.tool.output";

const DEFAULT_TRACE_NAME = "AI Interaction";
const UNKNOWN_OPERATION = "N/A";

const OPERATION_BADGE_MAP = new Map<string, string>([
  ["chat", "Chat"],
  ["invoke_agent", "Invoke Agent"],
  ["execute_tool", "Execute Tool"],
  [GEN_AI_CHAT_OP, "Chat"],
  [GEN_AI_INVOKE_AGENT_OP, "Invoke Agent"],
  [GEN_AI_EXECUTE_TOOL_OP, "Execute Tool"],
]);

function isGenAISpan(span: Span): boolean {
  return !!span.op?.toLowerCase().startsWith(GEN_AI_OP_PREFIX);
}

/**
 * Claims any standard `gen_ai.*` span that isn't a Vercel AI SDK span. Both
 * carry the `gen_ai.` op prefix, but only the Vercel SDK sets `vercel.ai.*`
 * data fields, so we defer those to the Vercel handler. A generic gen_ai span
 * has at least one `gen_ai.*` data key and no `vercel.ai.*` key.
 */
function isGenAIConventionSpan(span: Span): boolean {
  if (!isGenAISpan(span) || !span.data) {
    return false;
  }

  let hasGenAIField = false;
  for (const key of Object.keys(span.data)) {
    if (key.startsWith(VERCEL_FIELD_PREFIX)) {
      return false;
    }
    if (key.startsWith(GEN_AI_OP_PREFIX)) {
      hasGenAIField = true;
    }
  }

  return hasGenAIField;
}

export const genAIHandler: AILibraryHandler = {
  id: "gen-ai",
  name: "Gen AI",

  canHandleSpan: isGenAIConventionSpan,

  extractRootSpans: (spans: Span[]): Span[] => {
    const resultRoots: Span[] = [];
    const pending = [...spans].reverse();
    const visited = new Set<Span>();
    for (
      let currentSpan = pending.pop();
      currentSpan;
      currentSpan = pending.pop()
    ) {
      if (visited.has(currentSpan)) continue;
      visited.add(currentSpan);
      if (isGenAIConventionSpan(currentSpan)) {
        resultRoots.push(currentSpan);
      } else if (!isGenAISpan(currentSpan)) {
        // Stop at any gen_ai.* span: it's the shallowest AI root for its
        // tree (claimed by this handler or the Vercel one), so its nested
        // gen_ai.* children must not be surfaced as separate roots.
        for (
          let index = (currentSpan.children?.length ?? 0) - 1;
          index >= 0;
          index--
        ) {
          pending.push(currentSpan.children![index]);
        }
      }
    }
    return resultRoots;
  },

  processTrace: (rootSpan: Span): AITrace => {
    const allSpans = getAllSpansInTree(rootSpan);
    const tokenUsage = extractTokenUsage(allSpans);
    const operation = determineOperation(rootSpan);
    const hasToolCall = allSpans.some(
      (span) =>
        span.op === GEN_AI_EXECUTE_TOOL_OP ||
        !!span.data?.[GEN_AI_TOOL_NAME_FIELD],
    );

    const durationMs = rootSpan.timestamp - rootSpan.start_timestamp;

    const trace: AITrace = {
      id: rootSpan.span_id,
      name: determineTraceName(rootSpan),
      operation,
      timestamp: rootSpan.start_timestamp,
      durationMs,
      tokensDisplay: formatTokensDisplay(
        tokenUsage.promptTokens,
        tokenUsage.completionTokens,
      ),
      promptTokens: tokenUsage.promptTokens,
      completionTokens: tokenUsage.completionTokens,
      hasToolCall,
      rawSpan: rootSpan,
      metadata: {
        metadata: {},
        promptTokens: tokenUsage.promptTokens,
        completionTokens: tokenUsage.completionTokens,
      },
      toolCalls: [],
    };

    const responseState = { finishReasonFromText: false };
    const promptState = { hasRequestMessages: false };
    for (const span of allSpans) {
      if (!span.data) continue;
      extractMetadata(span, trace);
      extractPromptData(span, trace, promptState);
      extractResponseData(span, trace, responseState);
      extractToolCallData(span, trace);
    }

    return trace;
  },

  getDisplayTitle: (trace: AITrace): string => {
    return (
      trace.name || trace.operation || `AI Trace ${trace.id.substring(0, 8)}`
    );
  },

  getTypeBadge: (trace: AITrace): string => {
    if (trace.hasToolCall) {
      return "Tool-Call";
    }

    return (
      OPERATION_BADGE_MAP.get(trace.operation) ??
      trace.operation.replace(/^gen_ai\./, "")
    );
  },

  getTokensDisplay: (trace: AITrace): string => {
    return trace.tokensDisplay;
  },
};

function determineOperation(rootSpan: Span): string {
  const operationName = rootSpan.data?.[GEN_AI_OPERATION_NAME_FIELD];
  if (operationName) {
    return stringifyValue(operationName);
  }
  if (rootSpan.op) {
    return rootSpan.op;
  }
  return UNKNOWN_OPERATION;
}

function determineTraceName(rootSpan: Span): string {
  const agentName = rootSpan.data?.[GEN_AI_AGENT_NAME_FIELD];
  if (agentName) {
    return stringifyValue(agentName);
  }
  return rootSpan.description || rootSpan.op || DEFAULT_TRACE_NAME;
}

/**
 * Sums token usage across every span in the tree so an agent root with multiple
 * chat turns reports the total, not just the first turn's usage.
 */
function extractTokenUsage(spans: Span[]): {
  promptTokens?: number;
  completionTokens?: number;
} {
  function sum(field: string): number | undefined {
    let total: number | undefined;
    for (const span of spans) {
      const value = finiteNumber(span.data?.[field]);
      if (value === undefined || value < 0) continue;
      const next = (total ?? 0) + value;
      if (!Number.isFinite(next)) return undefined;
      total = next;
    }
    return total;
  }
  return {
    promptTokens: sum(GEN_AI_USAGE_INPUT_TOKENS_FIELD),
    completionTokens: sum(GEN_AI_USAGE_OUTPUT_TOKENS_FIELD),
  };
}

function formatTokensDisplay(
  promptTokens?: number,
  completionTokens?: number,
): string {
  if (promptTokens !== undefined && completionTokens !== undefined) {
    return `${promptTokens} / ${completionTokens}`;
  }
  if (promptTokens !== undefined) {
    return `${promptTokens} / ?`;
  }
  if (completionTokens !== undefined) {
    return `? / ${completionTokens}`;
  }
  return UNKNOWN_OPERATION;
}

function extractMetadata(span: Span, trace: AITrace) {
  if (!span.data) return;

  if (trace.metadata.modelId === undefined) {
    const modelId =
      span.data[GEN_AI_REQUEST_MODEL_FIELD] ??
      span.data[GEN_AI_RESPONSE_MODEL_FIELD];
    if (modelId !== undefined && modelId !== null) {
      trace.metadata.modelId = stringifyValue(modelId);
    }
  }

  if (
    trace.metadata.modelProvider === undefined &&
    span.data[GEN_AI_SYSTEM_FIELD] !== undefined &&
    span.data[GEN_AI_SYSTEM_FIELD] !== null
  ) {
    trace.metadata.modelProvider = stringifyValue(
      span.data[GEN_AI_SYSTEM_FIELD],
    );
  }
}

function extractPromptData(
  span: Span,
  trace: AITrace,
  state: { hasRequestMessages: boolean },
) {
  if (!span.data || state.hasRequestMessages) return;

  const promptMessages = span.data[GEN_AI_REQUEST_MESSAGES_FIELD];
  const system = span.data[GEN_AI_SYSTEM_INSTRUCTIONS_FIELD];
  const systemText =
    system !== undefined && system !== null
      ? stringifyValue(system)
      : trace.prompt?.system;
  const structured = normalizePromptMessages(promptMessages);
  if (structured !== undefined) {
    trace.prompt = { messages: structured, system: systemText };
    state.hasRequestMessages = true;
    return;
  }
  if (trace.prompt) return;

  if (promptMessages !== undefined && promptMessages !== null) {
    trace.prompt = {
      messages: [{ role: "unknown", content: stringifyValue(promptMessages) }],
      system: systemText,
    };
  } else if (systemText !== undefined) {
    trace.prompt = { system: systemText };
  }
}

function extractResponseData(
  span: Span,
  trace: AITrace,
  state: { finishReasonFromText: boolean },
) {
  if (!span.data) return;

  trace.response = trace.response || {};

  // Spans arrive in tree pre-order, so for an agent root with several chat
  // children the last span carrying a response wins — surfacing the latest
  // model turn rather than the first.
  const responseText = span.data[GEN_AI_RESPONSE_TEXT_FIELD];
  const text = Array.isArray(responseText)
    ? responseText.map(stringifyValue).join("")
    : responseText
      ? stringifyValue(responseText)
      : "";

  const finishReason = extractFinishReason(
    span.data[GEN_AI_RESPONSE_FINISH_REASONS_FIELD],
  );

  if (text) {
    trace.response.text = text;
    // Re-pair the finish reason with the turn that produced the surfaced text,
    // even overwriting one an earlier text-less turn contributed, so the text
    // and its reason always come from the same turn.
    trace.response.finishReason = finishReason;
    state.finishReasonFromText = true;
  } else if (finishReason !== undefined && !state.finishReasonFromText) {
    // SDKs omit gen_ai.response.text when PII recording is off, and tool-call
    // turns carry a reason with no text — still surface the reason, but never
    // let it override one already paired with a text turn.
    trace.response.finishReason = finishReason;
  }

  const toolCalls = span.data[GEN_AI_RESPONSE_TOOL_CALLS_FIELD];
  if (toolCalls) {
    try {
      const parsed: unknown =
        typeof toolCalls === "string" ? JSON.parse(toolCalls) : toolCalls;
      if (Array.isArray(parsed)) {
        trace.response.toolCalls = parsed;
      }
    } catch {
      // ignore unparseable tool call payloads
    }
  }
}

function extractToolCallData(span: Span, trace: AITrace) {
  if (!span.data) return;

  const toolName = span.data[GEN_AI_TOOL_NAME_FIELD];
  if (!toolName) return;

  const toolCallId = span.data[GEN_AI_TOOL_CALL_ID_FIELD];
  const toolCall: Partial<AIToolCall> = {
    toolCallId: toolCallId ? stringifyValue(toolCallId) : span.span_id,
    toolName: stringifyValue(toolName),
    args: {} as Record<string, unknown>,
  };

  const toolInput = span.data[GEN_AI_TOOL_INPUT_FIELD];
  if (toolInput) {
    try {
      toolCall.args =
        typeof toolInput === "string"
          ? JSON.parse(toolInput)
          : (toolInput as Record<string, unknown>);
    } catch {
      toolCall.args = { input: toolInput };
    }
  }

  const toolOutput = span.data[GEN_AI_TOOL_OUTPUT_FIELD];
  if (toolOutput) {
    try {
      toolCall.result =
        typeof toolOutput === "string" ? JSON.parse(toolOutput) : toolOutput;
    } catch {
      toolCall.result = stringifyValue(toolOutput);
    }
  }

  trace.toolCalls.push(toolCall as AIToolCall);
}
