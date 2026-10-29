import { stringifyValue } from "../utils/stringifyValue.ts";
import { finiteNumber } from "../utils/finiteNumber.ts";
import { getAllSpansInTree } from "../store/helpers.ts";
import type { AILibraryHandler, AIToolCall, AITrace, Span } from "../types.ts";
import { extractFinishReason } from "./finishReason.ts";

// https://ai-sdk.dev/docs/ai-sdk-core/telemetry
const AI_SPAN_OP_PREFIX = "gen_ai.";
const AI_OPERATION_ID_FIELD = "vercel.ai.operationId";
const AI_OPERATION_NAME_FIELD = "operation.name";

// Tool call related constants (OpenTelemetry semantic conventions)
const AI_TOOL_CALL_OPERATION = "ai.toolCall";
const AI_EXECUTE_TOOL_OPERATION = "gen_ai.execute_tool";
const GEN_AI_TOOL_NAME_FIELD = "gen_ai.tool.name";
const GEN_AI_TOOL_CALL_ID_FIELD = "gen_ai.tool.call.id";
const GEN_AI_TOOL_INPUT_FIELD = "gen_ai.tool.input";
const GEN_AI_TOOL_OUTPUT_FIELD = "gen_ai.tool.output";

const AI_MODEL_ID_FIELD = "vercel.ai.model.id";
const AI_MODEL_PROVIDER_FIELD = "vercel.ai.model.provider";
const AI_SETTINGS_MAX_RETRIES_FIELD = "vercel.ai.settings.maxRetries";
const AI_SETTINGS_MAX_STEPS_FIELD = "vercel.ai.settings.maxSteps";
const AI_TELEMETRY_FUNCTION_ID_FIELD = "vercel.ai.telemetry.functionId";
const AI_TELEMETRY_METADATA_PREFIX = "vercel.ai.telemetry.metadata.";
const AI_PROMPT_FIELD = "vercel.ai.prompt";
const AI_PROMPT_MESSAGES_FIELD = "gen_ai.request.messages";
const AI_RESPONSE_FINISH_REASON_FIELD = "vercel.ai.response.finishReason";
const GEN_AI_RESPONSE_FINISH_REASONS_FIELD = "gen_ai.response.finish_reasons";
const AI_RESPONSE_TEXT_FIELD = "gen_ai.response.text";
const AI_RESPONSE_TOOL_CALLS_FIELD = "vercel.ai.response.toolCalls";

// v1 operation names
const AI_STREAM_TEXT_OPERATION = "ai.streamText";
const AI_GENERATE_TEXT_OPERATION = "ai.generateText";

// v2 operation names (OpenTelemetry semantic conventions)
const AI_INVOKE_AGENT_OPERATION = "gen_ai.invoke_agent";
const AI_STREAM_TEXT_V2_OPERATION = "gen_ai.stream_text";

// v2 field names
const GEN_AI_PROMPT_FIELD = "gen_ai.prompt";
const GEN_AI_FUNCTION_ID_FIELD = "gen_ai.function_id";
const GEN_AI_REQUEST_MODEL_FIELD = "gen_ai.request.model";
const GEN_AI_RESPONSE_MODEL_FIELD = "gen_ai.response.model";
const GEN_AI_SYSTEM_FIELD = "gen_ai.system";
const GEN_AI_OPERATION_NAME_FIELD = "gen_ai.operation.name";

const AI_USAGE_PROMPT_TOKENS_FIELD = "vercel.ai.usage.promptTokens";
const AI_USAGE_COMPLETION_TOKENS_FIELD = "vercel.ai.usage.completionTokens";
const GEN_AI_USAGE_INPUT_TOKENS_FIELD = "gen_ai.usage.input_tokens";
const GEN_AI_USAGE_OUTPUT_TOKENS_FIELD = "gen_ai.usage.output_tokens";

const TOKEN_FIELDS = {
  PROMPT: [AI_USAGE_PROMPT_TOKENS_FIELD, GEN_AI_USAGE_INPUT_TOKENS_FIELD],
  COMPLETION: [
    AI_USAGE_COMPLETION_TOKENS_FIELD,
    GEN_AI_USAGE_OUTPUT_TOKENS_FIELD,
  ],
} as const;

// Other constants
const DEFAULT_TRACE_NAME = "AI Interaction";
const UNKNOWN_OPERATION = "N/A";

// Operation to badge mapping
const OPERATION_BADGE_MAP = new Map<string, string>([
  [AI_STREAM_TEXT_OPERATION, "Stream Text"],
  [AI_GENERATE_TEXT_OPERATION, "Generate Text"],
  [AI_INVOKE_AGENT_OPERATION, "Invoke Agent"],
  [AI_STREAM_TEXT_V2_OPERATION, "Stream Text"],
]);

// Field mappings: first element is v2, subsequent are v1 alternatives
const AI_FIELD_MAPPINGS = {
  MODEL_ID: [
    AI_MODEL_ID_FIELD,
    GEN_AI_REQUEST_MODEL_FIELD,
    GEN_AI_RESPONSE_MODEL_FIELD,
  ],
  MODEL_PROVIDER: [AI_MODEL_PROVIDER_FIELD, GEN_AI_SYSTEM_FIELD],
  FUNCTION_ID: [AI_TELEMETRY_FUNCTION_ID_FIELD, GEN_AI_FUNCTION_ID_FIELD],
  PROMPT: [GEN_AI_PROMPT_FIELD, AI_PROMPT_FIELD],
  OPERATION_ID: [
    AI_OPERATION_ID_FIELD,
    AI_OPERATION_NAME_FIELD,
    GEN_AI_OPERATION_NAME_FIELD,
  ],
} as const;

/**
 * Extracts a field value from span data, checking v1 fields first then v2 alternatives.
 */
function extractFieldFromSpan(
  data: Record<string, unknown>,
  fieldKey: keyof typeof AI_FIELD_MAPPINGS,
): unknown {
  const fields = AI_FIELD_MAPPINGS[fieldKey];
  for (const field of fields) {
    if (data[field] !== undefined) {
      return data[field];
    }
  }
  return undefined;
}

export const vercelAISDKHandler: AILibraryHandler = {
  id: "vercel-ai-sdk",
  name: "Vercel AI SDK",

  canHandleSpan: (span: Span): boolean => {
    return !!span.op?.toLowerCase().startsWith(AI_SPAN_OP_PREFIX);
  },

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
      if (currentSpan.op?.toLowerCase().startsWith(AI_SPAN_OP_PREFIX)) {
        resultRoots.push(currentSpan);
      } else {
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
    const operationInfo = determineOperation(allSpans, rootSpan);
    const traceName = determineTraceName(rootSpan, operationInfo);

    const durationMs = rootSpan.timestamp - rootSpan.start_timestamp;

    // Initialize the trace with basic properties
    const trace: AITrace = {
      id: rootSpan.span_id,
      name: traceName,
      operation: operationInfo.operation,
      timestamp: rootSpan.start_timestamp,
      durationMs,
      tokensDisplay: formatTokensDisplay(
        tokenUsage.promptTokens,
        tokenUsage.completionTokens,
      ),
      promptTokens: tokenUsage.promptTokens,
      completionTokens: tokenUsage.completionTokens,
      hasToolCall: operationInfo.hasToolCall,
      rawSpan: rootSpan,
      metadata: {
        metadata: {},
        promptTokens: tokenUsage.promptTokens,
        completionTokens: tokenUsage.completionTokens,
      },
      toolCalls: [],
    };

    // Parse detailed span data
    parseSpanData(allSpans, trace);

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
      trace.operation.replace(/^(ai\.|gen_ai\.)/, "")
    );
  },

  getTokensDisplay: (trace: AITrace): string => {
    return trace.tokensDisplay;
  },
};

function extractTokenUsage(spans: Span[]): {
  promptTokens?: number;
  completionTokens?: number;
} {
  const totals = new Map<
    Span,
    { promptTokens?: number; completionTokens?: number }
  >();
  for (let index = spans.length - 1; index >= 0; index--) {
    const span = spans[index];
    const usage: { promptTokens?: number; completionTokens?: number } = {};
    for (const [key, fields] of [
      ["promptTokens", TOKEN_FIELDS.PROMPT],
      ["completionTokens", TOKEN_FIELDS.COMPLETION],
    ] as const) {
      let reported: number | undefined;
      for (const field of fields) {
        const value = finiteNumber(span.data?.[field]);
        if (value !== undefined && value >= 0) {
          reported = value;
          break;
        }
      }
      let observed: number | undefined;
      for (const child of new Set(span.children)) {
        const value = totals.get(child)?.[key];
        if (value !== undefined) observed = (observed ?? 0) + value;
      }
      // SDK versions report either last-step usage or an aggregate on agent
      // parents, and Sentry normalizes both to the same keys. Reconcile each
      // reported subtotal with its non-overlapping children instead of adding
      // parent totals again or replacing a larger total with partial coverage.
      usage[key] =
        observed === undefined || !Number.isFinite(observed)
          ? (reported ?? observed)
          : reported === undefined
            ? observed
            : Math.max(reported, observed);
    }
    totals.set(span, usage);
  }
  const usage = totals.get(spans[0]);
  // An unrepresentable child sum cannot become a public Infinity total.
  return {
    promptTokens: finiteNumber(usage?.promptTokens),
    completionTokens: finiteNumber(usage?.completionTokens),
  };
}

function determineOperation(
  spans: Span[],
  rootSpan: Span,
): { operation: string; hasToolCall: boolean; toolCallName?: string } {
  const operationId =
    rootSpan.data && extractFieldFromSpan(rootSpan.data, "OPERATION_ID");
  const operation =
    typeof operationId === "string" && operationId
      ? operationId
      : rootSpan.op || rootSpan.description || UNKNOWN_OPERATION;
  const isTool = (span: Span) => {
    const id = span.data && extractFieldFromSpan(span.data, "OPERATION_ID");
    return (
      span.op === AI_TOOL_CALL_OPERATION ||
      span.op === AI_EXECUTE_TOOL_OPERATION ||
      id === AI_TOOL_CALL_OPERATION ||
      id === AI_EXECUTE_TOOL_OPERATION ||
      id === "execute_tool"
    );
  };
  const name = rootSpan.data?.[GEN_AI_TOOL_NAME_FIELD];
  return {
    operation,
    hasToolCall: spans.some(isTool),
    toolCallName: isTool(rootSpan) && name ? stringifyValue(name) : undefined,
  };
}

function determineTraceName(
  rootSpan: Span,
  operationInfo: { toolCallName?: string },
): string {
  if (operationInfo.toolCallName) {
    return operationInfo.toolCallName;
  }

  return rootSpan.description || rootSpan.op || DEFAULT_TRACE_NAME;
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

/**
 * Normalizes message content from v1 (string) or v2 (array of content blocks) format to a string.
 * v1: content = "text string"
 * v2: content = [{ type: "text", text: "text string" }]
 *
 * Only extracts text content blocks. Other block types (image, file, tool-call)
 * would require UI changes to display properly and are filtered out for now.
 */
function normalizeMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // Only extract text content - images/files would need UI changes to display
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("");
  }
  return "";
}

function parseSpanData(spans: Span[], trace: AITrace) {
  const responseState = { finishReasonFromText: false };
  for (const span of spans) {
    if (!span.data) continue;

    extractAIMetadata(span, trace);
    extractTelemetryMetadata(span, trace);
    extractPromptData(span, trace);
    extractResponseData(span, trace, responseState);
    extractToolCallData(span, trace);
  }
}

function extractAIMetadata(span: Span, trace: AITrace) {
  if (!span.data) return;

  // Model ID
  if (trace.metadata.modelId === undefined) {
    const modelId = extractFieldFromSpan(span.data, "MODEL_ID");
    if (modelId !== undefined) {
      trace.metadata.modelId = stringifyValue(modelId);
    }
  }

  // Model Provider
  if (trace.metadata.modelProvider === undefined) {
    const provider = extractFieldFromSpan(span.data, "MODEL_PROVIDER");
    if (provider !== undefined) {
      trace.metadata.modelProvider = stringifyValue(provider);
    }
  }

  // Function ID
  if (trace.metadata.functionId === undefined) {
    const functionId = extractFieldFromSpan(span.data, "FUNCTION_ID");
    if (functionId !== undefined) {
      trace.metadata.functionId = stringifyValue(functionId);
    }
  }

  const maxRetries = finiteNumber(span.data[AI_SETTINGS_MAX_RETRIES_FIELD]);
  if (maxRetries !== undefined) {
    trace.metadata.maxRetries = maxRetries;
  }

  const maxSteps = finiteNumber(span.data[AI_SETTINGS_MAX_STEPS_FIELD]);
  if (maxSteps !== undefined) {
    trace.metadata.maxSteps = maxSteps;
  }
}

function extractTelemetryMetadata(span: Span, trace: AITrace) {
  if (!span.data) return;

  for (const [key, value] of Object.entries(span.data)) {
    if (key.startsWith(AI_TELEMETRY_METADATA_PREFIX)) {
      const metadataKey = key.replace(AI_TELEMETRY_METADATA_PREFIX, "");
      trace.metadata.metadata[metadataKey] = value;
    }
  }
}

function extractPromptData(span: Span, trace: AITrace) {
  if (!span.data) return;

  const promptField = extractFieldFromSpan(span.data, "PROMPT");
  if (promptField && !trace.prompt) {
    try {
      const parsed = JSON.parse(stringifyValue(promptField));
      // Normalize message content from v2 array format to string
      if (parsed.messages && Array.isArray(parsed.messages)) {
        parsed.messages = parsed.messages.map(
          (msg: { role: string; content: unknown }) => ({
            ...msg,
            content: normalizeMessageContent(msg.content),
          }),
        );
      }
      trace.prompt = parsed;
    } catch {
      trace.prompt = {
        messages: [{ role: "unknown", content: stringifyValue(promptField) }],
      };
    }
  }

  const promptMessages = span.data[AI_PROMPT_MESSAGES_FIELD];
  if (promptMessages && !trace.prompt) {
    try {
      const messages = JSON.parse(stringifyValue(promptMessages));
      // Normalize message content from v2 array format to string
      const normalizedMessages = messages.map(
        (msg: { role: string; content: unknown }) => ({
          ...msg,
          content: normalizeMessageContent(msg.content),
        }),
      );
      trace.prompt = { messages: normalizedMessages };
    } catch {
      trace.prompt = {
        messages: [
          { role: "unknown", content: stringifyValue(promptMessages) },
        ],
      };
    }
  }
}

function extractResponseData(
  span: Span,
  trace: AITrace,
  state: { finishReasonFromText: boolean },
) {
  if (!span.data) return;

  trace.response = trace.response || {};

  const finishReason =
    extractFinishReason(span.data[AI_RESPONSE_FINISH_REASON_FIELD]) ??
    extractFinishReason(span.data[GEN_AI_RESPONSE_FINISH_REASONS_FIELD]);

  const responseText = span.data[AI_RESPONSE_TEXT_FIELD];
  if (responseText) {
    trace.response.text = stringifyValue(responseText);
    trace.response.finishReason = finishReason;
    state.finishReasonFromText = true;
  } else if (finishReason !== undefined && !state.finishReasonFromText) {
    trace.response.finishReason = finishReason;
  }

  const toolCalls = span.data[AI_RESPONSE_TOOL_CALLS_FIELD];
  if (toolCalls) {
    try {
      const parsed: unknown =
        typeof toolCalls === "string" ? JSON.parse(toolCalls) : toolCalls;
      if (Array.isArray(parsed)) {
        trace.response.toolCalls = parsed;
      }
    } catch {
      // Truncated tool-call JSON must not discard the rest of the AI trace.
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
