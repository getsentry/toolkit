// Catalog-only agent conversation detail lookup. This owns the MCP-facing
// transcript projection and keeps detail output chronological and debugger
// oriented instead of mirroring every raw span attribute.
import { z } from "zod";
import type { AIConversationSpan, SentryApiService } from "../../api-client";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { ParamOrganizationSlug, ParamRegionUrl } from "../../schema";
import { setTagAndAttribute } from "../../telem/scope";
import type { ServerContext } from "../../types";

type ToolCall = {
  type: "tool_call";
  name: string;
  spanId: string;
  traceId: string;
  timestamp: number;
  durationMs: number;
  status?: string;
  arguments?: string;
  input?: string;
  genAi?: GenAIAttributes;
};

type ConversationMessage = {
  type: "message";
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  spanId: string;
  traceId: string;
  userEmail?: string;
  metadata?: {
    agentName?: string;
    model?: string;
    totalTokens: number;
    status?: string;
    durationMs: number;
  };
  genAi?: GenAIAttributes;
};

type TimelineEvent = ConversationMessage | ToolCall;
type LookupWindow = {
  statsPeriod?: string;
  start?: string;
  end?: string;
};
type GenAIAttributes = {
  operationType?: string;
  agentName?: string;
  requestModel?: string;
  responseModel?: string;
  usageTotalTokens?: number;
  costTotalTokens?: number;
  systemInstructions?: string;
  inputMessages?: string;
  outputMessages?: string;
  requestMessages?: string;
  responseText?: string;
  responseObject?: string;
  toolDefinitions?: string;
  toolName?: string;
  toolCallArguments?: string;
  toolInput?: string;
  truncatedFields?: string[];
};
type ToolCallGenAIAttributes = Omit<
  GenAIAttributes,
  "toolName" | "toolCallArguments" | "toolInput" | "truncatedFields"
>;
type SpanSummary = {
  spanId: string;
  traceId: string;
  parentSpanId?: string | null;
  project: string;
  projectId: string | number;
  timestamp: number;
  durationMs: number;
  spanName?: string;
  spanOp?: string;
  spanDescription?: string;
  spanStatus?: string;
  transaction?: string;
  isTransaction?: boolean;
  genAi?: GenAIAttributes;
};

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

const genAiAttributesSchema = z.object({
  operationType: z.string().optional(),
  agentName: z.string().optional(),
  requestModel: z.string().optional(),
  responseModel: z.string().optional(),
  usageTotalTokens: z.number().optional(),
  costTotalTokens: z.number().optional(),
  systemInstructions: z.string().optional(),
  inputMessages: z.string().optional(),
  outputMessages: z.string().optional(),
  requestMessages: z.string().optional(),
  responseText: z.string().optional(),
  responseObject: z.string().optional(),
  toolDefinitions: z.string().optional(),
  toolName: z.string().optional(),
  toolCallArguments: z.string().optional(),
  toolInput: z.string().optional(),
  truncatedFields: z.array(z.string()).optional(),
});

const toolCallGenAiAttributesSchema = genAiAttributesSchema.omit({
  toolName: true,
  toolCallArguments: true,
  toolInput: true,
  truncatedFields: true,
});

const toolCallSchema = z.object({
  type: z.literal("tool_call"),
  name: z.string(),
  spanId: z.string(),
  traceId: z.string(),
  timestamp: z.number(),
  durationMs: z.number(),
  status: z.string().optional(),
  arguments: z.string().optional(),
  input: z.string().optional(),
  genAi: toolCallGenAiAttributesSchema.optional(),
});

const conversationMessageSchema = z.object({
  type: z.literal("message"),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.number(),
  spanId: z.string(),
  traceId: z.string(),
  userEmail: z.string().optional(),
  metadata: z
    .object({
      agentName: z.string().optional(),
      model: z.string().optional(),
      totalTokens: z.number(),
      status: z.string().optional(),
      durationMs: z.number(),
    })
    .optional(),
  genAi: genAiAttributesSchema.optional(),
});

const timelineEventSchema = z.discriminatedUnion("type", [
  conversationMessageSchema,
  toolCallSchema,
]);

const lookupWindowSchema = z.object({
  statsPeriod: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
});

const spanSummarySchema = z.object({
  spanId: z.string(),
  traceId: z.string(),
  parentSpanId: z.string().nullable().optional(),
  project: z.string(),
  projectId: z.union([z.string(), z.number()]),
  timestamp: z.number(),
  durationMs: z.number(),
  spanName: z.string().optional(),
  spanOp: z.string().optional(),
  spanDescription: z.string().optional(),
  spanStatus: z.string().optional(),
  transaction: z.string().optional(),
  isTransaction: z.boolean().optional(),
  genAi: genAiAttributesSchema.optional(),
});

export const aiConversationDetailsOutputSchema = z.object({
  conversationId: z.string(),
  title: z.string().nullable(),
  organizationSlug: z.string(),
  url: z.string().url(),
  lookupWindow: lookupWindowSchema,
  startTimestamp: z.number().nullable(),
  endTimestamp: z.number().nullable(),
  traceIds: z.array(z.string()),
  projects: z.array(z.string()),
  spanCount: z.number(),
  aiCallCount: z.number(),
  messageCount: z.number(),
  toolCallCount: z.number(),
  totalTokens: z.number(),
  spanSummaries: z.array(spanSummarySchema),
  timeline: z.array(timelineEventSchema),
});

type AIConversationDetailsOutput = z.infer<
  typeof aiConversationDetailsOutputSchema
>;

function numeric(value: string | number | null | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function optionalNumeric(
  value: string | number | null | undefined,
): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function timestampMs(value: number): number {
  return Math.round(value * 1000);
}

function durationMs(span: AIConversationSpan): number {
  return Math.round(
    (span["precise.finish_ts"] - span["precise.start_ts"]) * 1000,
  );
}

const MAX_RAW_GEN_AI_ATTRIBUTE_LENGTH = 4000;

function truncateAttribute(
  field: string,
  value: string | undefined,
  truncatedFields: string[],
): string | undefined {
  if (value === undefined || value.length <= MAX_RAW_GEN_AI_ATTRIBUTE_LENGTH) {
    return value;
  }

  truncatedFields.push(field);
  return `${value.slice(0, MAX_RAW_GEN_AI_ATTRIBUTE_LENGTH)}... [truncated]`;
}

function getOperationType(span: AIConversationSpan): string | undefined {
  const explicit = span["gen_ai.operation.type"];
  if (explicit) {
    return explicit;
  }

  const spanName = span["span.name"];
  if (!spanName?.startsWith("gen_ai.")) {
    return undefined;
  }
  if (spanName === "gen_ai.execute_tool") {
    return "tool";
  }
  if (
    spanName === "gen_ai.invoke_agent" ||
    spanName === "gen_ai.create_agent"
  ) {
    return "agent";
  }
  if (spanName === "gen_ai.handoff") {
    return "handoff";
  }
  return "ai_client";
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stringifyContent(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          if (typeof record.text === "string") {
            return record.text;
          }
          if (typeof record.content === "string") {
            return record.content;
          }
        }
        return null;
      })
      .filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
    if (typeof record.message === "string") {
      return record.message;
    }
  }
  return value == null ? null : JSON.stringify(value);
}

function collectMessages(value: unknown): { role?: string; content: string }[] {
  const source =
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as Record<string, unknown>).messages)
      ? (value as Record<string, unknown>).messages
      : value;

  if (!Array.isArray(source)) {
    const content = stringifyContent(source);
    return content ? [{ content }] : [];
  }

  return source
    .map((message) => {
      if (typeof message === "string") {
        return { content: message };
      }
      if (!message || typeof message !== "object") {
        return null;
      }
      const record = message as Record<string, unknown>;
      const content = stringifyContent(record.content ?? record.text ?? record);
      if (!content) {
        return null;
      }
      return {
        role: typeof record.role === "string" ? record.role : undefined,
        content,
      };
    })
    .filter((message): message is { role?: string; content: string } =>
      Boolean(message),
    );
}

function extractUserContent(span: AIConversationSpan): string | null {
  const raw =
    span["gen_ai.input.messages"] ?? span["gen_ai.request.messages"] ?? null;
  if (!raw) {
    return null;
  }
  if (raw === "[Filtered]") {
    return raw;
  }
  const messages = collectMessages(parseJson(raw));
  const userMessage = messages.findLast((message) => message.role === "user");
  return userMessage?.content ?? messages.at(-1)?.content ?? null;
}

function extractAssistantContent(span: AIConversationSpan): string | null {
  const outputMessages = span["gen_ai.output.messages"];
  if (outputMessages) {
    if (outputMessages === "[Filtered]") {
      return outputMessages;
    }
    const messages = collectMessages(parseJson(outputMessages));
    const assistantMessage = messages.findLast(
      (message) => message.role === "assistant",
    );
    const content = assistantMessage?.content ?? messages.at(-1)?.content;
    if (content) {
      return content;
    }
  }

  return span["gen_ai.response.text"] ?? span["gen_ai.response.object"] ?? null;
}

/** Projects documented GenAI fields into the MCP contract and marks truncated raw payloads. */
function buildGenAIAttributes(
  span: AIConversationSpan,
): GenAIAttributes | undefined {
  const truncatedFields: string[] = [];

  const attributes = withoutUndefined({
    operationType: getOperationType(span),
    agentName: span["gen_ai.agent.name"],
    requestModel: span["gen_ai.request.model"],
    responseModel: span["gen_ai.response.model"],
    usageTotalTokens: optionalNumeric(span["gen_ai.usage.total_tokens"]),
    costTotalTokens: optionalNumeric(span["gen_ai.cost.total_tokens"]),
    systemInstructions: truncateAttribute(
      "systemInstructions",
      span["gen_ai.system_instructions"],
      truncatedFields,
    ),
    inputMessages: truncateAttribute(
      "inputMessages",
      span["gen_ai.input.messages"],
      truncatedFields,
    ),
    outputMessages: truncateAttribute(
      "outputMessages",
      span["gen_ai.output.messages"],
      truncatedFields,
    ),
    requestMessages: truncateAttribute(
      "requestMessages",
      span["gen_ai.request.messages"],
      truncatedFields,
    ),
    responseText: truncateAttribute(
      "responseText",
      span["gen_ai.response.text"],
      truncatedFields,
    ),
    responseObject: truncateAttribute(
      "responseObject",
      span["gen_ai.response.object"],
      truncatedFields,
    ),
    toolDefinitions: truncateAttribute(
      "toolDefinitions",
      span["gen_ai.tool.definitions"],
      truncatedFields,
    ),
    toolName: span["gen_ai.tool.name"],
    toolCallArguments: truncateAttribute(
      "toolCallArguments",
      span["gen_ai.tool.call.arguments"],
      truncatedFields,
    ),
    toolInput: truncateAttribute(
      "toolInput",
      span["gen_ai.tool.input"],
      truncatedFields,
    ),
    truncatedFields:
      truncatedFields.length > 0 ? truncatedFields.sort() : undefined,
  });
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

/** Builds the MCP-facing span summary with IDs for raw span follow-up. */
function buildSpanSummary(span: AIConversationSpan): SpanSummary {
  return withoutUndefined({
    spanId: span.span_id,
    traceId: span.trace,
    parentSpanId: span.parent_span,
    project: span.project,
    projectId: span["project.id"],
    timestamp: timestampMs(span["precise.start_ts"]),
    durationMs: durationMs(span),
    spanName: span["span.name"],
    spanOp: span["span.op"],
    spanDescription: span["span.description"],
    spanStatus: span["span.status"],
    transaction: span.transaction,
    isTransaction: span.is_transaction,
    genAi: buildGenAIAttributes(span),
  });
}

function buildToolCallGenAIAttributes(
  attributes: GenAIAttributes | undefined,
): ToolCallGenAIAttributes | undefined {
  if (!attributes) {
    return undefined;
  }

  const {
    toolName: _toolName,
    toolCallArguments: _toolCallArguments,
    toolInput: _toolInput,
    truncatedFields: _truncatedFields,
    ...timelineAttributes
  } = attributes;
  return Object.keys(timelineAttributes).length > 0
    ? timelineAttributes
    : undefined;
}

function buildToolCall(span: AIConversationSpan): ToolCall | null {
  const name = span["gen_ai.tool.name"];
  if (!name) {
    return null;
  }
  const genAi = buildGenAIAttributes(span);

  return withoutUndefined({
    type: "tool_call" as const,
    name,
    spanId: span.span_id,
    traceId: span.trace,
    timestamp: timestampMs(span["precise.start_ts"]),
    durationMs: durationMs(span),
    status: span["span.status"],
    arguments: genAi?.toolCallArguments,
    input: genAi?.toolInput,
    genAi: buildToolCallGenAIAttributes(genAi),
  });
}

function buildMessageEvents(span: AIConversationSpan): ConversationMessage[] {
  const spanDurationMs = durationMs(span);
  const genAi = buildGenAIAttributes(span);
  const metadata = withoutUndefined({
    agentName: span["gen_ai.agent.name"],
    model: span["gen_ai.response.model"] ?? span["gen_ai.request.model"],
    totalTokens: numeric(span["gen_ai.usage.total_tokens"]),
    status: span["span.status"],
    durationMs: spanDurationMs,
  });
  const events: ConversationMessage[] = [];
  const userContent = extractUserContent(span);
  if (userContent) {
    events.push(
      withoutUndefined({
        type: "message" as const,
        role: "user" as const,
        content: userContent,
        timestamp: timestampMs(span["precise.start_ts"]),
        spanId: span.span_id,
        traceId: span.trace,
        userEmail: span["user.email"],
        metadata: undefined,
        genAi,
      }),
    );
  }

  const assistantContent = extractAssistantContent(span);
  if (assistantContent) {
    events.push({
      type: "message",
      role: "assistant",
      content: assistantContent,
      timestamp: timestampMs(span["precise.finish_ts"]),
      spanId: span.span_id,
      traceId: span.trace,
      metadata,
      genAi,
    });
  } else if (events.length > 0) {
    events[events.length - 1] = {
      ...events[events.length - 1]!,
      metadata,
      genAi,
    };
  }

  return events;
}

function extractTimeline(spans: AIConversationSpan[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const span of spans) {
    const operationType = getOperationType(span);
    if (operationType === "tool") {
      const toolCall = buildToolCall(span);
      if (toolCall) {
        events.push(toolCall);
      }
      continue;
    }
    if (operationType === "ai_client") {
      events.push(...buildMessageEvents(span));
    }
  }

  return events.sort((a, b) => {
    const timestampDiff = a.timestamp - b.timestamp;
    if (timestampDiff !== 0) {
      return timestampDiff;
    }
    if (a.type !== b.type) {
      return a.type === "message" ? -1 : 1;
    }
    return a.spanId.localeCompare(b.spanId);
  });
}

function countAICalls(spans: AIConversationSpan[]): number {
  return spans.filter((span) => getOperationType(span) === "ai_client").length;
}

/** Builds the stable structured artifact returned as conversation details. */
function buildConversationArtifact(
  apiService: SentryApiService,
  organizationSlug: string,
  conversationId: string,
  title: string | null,
  spans: AIConversationSpan[],
  lookupWindow: LookupWindow,
): AIConversationDetailsOutput {
  const timeline = extractTimeline(spans);
  const spanSummaries = spans.map(buildSpanSummary).sort((a, b) => {
    const timestampDiff = a.timestamp - b.timestamp;
    if (timestampDiff !== 0) {
      return timestampDiff;
    }
    return a.spanId.localeCompare(b.spanId);
  });
  const traceIds = [...new Set(spans.map((span) => span.trace))].sort();
  const projects = [...new Set(spans.map((span) => span.project))].sort();
  const startTimestamp =
    spans.length > 0
      ? Math.min(...spans.map((span) => span["precise.start_ts"]))
      : null;
  const endTimestamp =
    spans.length > 0
      ? Math.max(...spans.map((span) => span["precise.finish_ts"]))
      : null;

  return withoutUndefined({
    conversationId,
    title,
    organizationSlug,
    url: apiService.getAIConversationUrl(organizationSlug, conversationId),
    lookupWindow,
    startTimestamp:
      startTimestamp === null ? null : timestampMs(startTimestamp),
    endTimestamp: endTimestamp === null ? null : timestampMs(endTimestamp),
    traceIds,
    projects,
    spanCount: spans.length,
    aiCallCount: countAICalls(spans),
    messageCount: timeline.filter((event) => event.type === "message").length,
    toolCallCount: timeline.filter((event) => event.type === "tool_call")
      .length,
    totalTokens: spans.reduce(
      (sum, span) => sum + numeric(span["gen_ai.usage.total_tokens"]),
      0,
    ),
    spanSummaries,
    timeline,
  });
}

export default defineTool({
  name: "get_agent_conversation_details",
  skills: ["inspect", "triage", "seer"],
  requiredScopes: ["event:read", "project:read"],

  description: [
    "Fetch the chronological transcript and debugging details for one agent conversation, formerly called an AI conversation.",
    "",
    "Returns a timeline of user messages, assistant messages, and tool calls, with trace/span IDs for deeper debugging. To discover or list conversations, use search_agent_conversations.",
  ].join("\n"),

  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    conversationId: z
      .string()
      .trim()
      .describe("The agent conversation ID from gen_ai.conversation.id."),
    project: z
      .string()
      .trim()
      .optional()
      .describe(
        "Numeric project ID to scope the query. Falls back to context constraint or all projects.",
      ),
    start: z
      .string()
      .trim()
      .optional()
      .describe("Explicit start time for the conversation lookup window."),
    end: z
      .string()
      .trim()
      .optional()
      .describe("Explicit end time for the conversation lookup window."),
    regionUrl: ParamRegionUrl.optional(),
  },

  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: aiConversationDetailsOutputSchema,

  async handler(params, context: ServerContext) {
    setTagAndAttribute("organization.slug", params.organizationSlug);
    setTagAndAttribute("ai_conversation.id", params.conversationId);

    if ((params.start && !params.end) || (!params.start && params.end)) {
      throw new UserInputError("`start` and `end` must be provided together.");
    }

    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });

    let projectId: string | undefined;
    if (context.constraints.projectSlug) {
      const constrainedProject = await apiService.getProject({
        organizationSlug: params.organizationSlug,
        projectSlugOrId: context.constraints.projectSlug,
      });
      projectId = String(constrainedProject.id);
    } else if (params.project) {
      projectId = params.project;
    }

    const conversation = await apiService.getAIConversation(
      {
        organizationSlug: params.organizationSlug,
        conversationId: params.conversationId,
        project: projectId ?? "-1",
        start: params.start,
        end: params.end,
      },
      undefined,
    );

    const artifact = buildConversationArtifact(
      apiService,
      params.organizationSlug,
      params.conversationId,
      conversation.title,
      conversation.spans,
      params.start && params.end
        ? { start: params.start, end: params.end }
        : { statsPeriod: "30d" },
    );
    return structuredResult(artifact);
  },
});
