import { getEventMetadata, type LocalFeedItem } from "./spotlight.ts";
import { getEventExceptions, formatExceptionTitle } from "./exceptions.ts";

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
export function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
export function display(value: unknown): string {
  return typeof value === "string"
    ? value
    : (JSON.stringify(value, null, 2) ?? String(value));
}
export function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
/** Merge legacy span data and typed span-v2 attributes without losing unknown fields. */
export function spanData(payload: unknown): Record<string, unknown> {
  const p = record(payload);
  const attributes = Object.fromEntries(
    Object.entries(record(p.attributes)).map(([key, value]) => [
      key,
      "value" in record(value) ? record(value).value : value,
    ]),
  );
  return {
    ...record(record(record(p.contexts).trace).data),
    ...record(p.data),
    ...attributes,
  };
}
export function isAiPayload(payload: unknown): boolean {
  const p = record(payload),
    data = spanData(p);
  return (
    [
      p.type,
      p.op,
      record(record(p.contexts).trace).op,
      data["sentry.op"],
      data["sentry.origin"],
    ].some(
      (value) =>
        typeof value === "string" &&
        /(?:^|[.\s:_-])(?:ai|gen_ai|llm)(?:$|[.\s:_-])/i.test(value),
    ) ||
    Object.keys(data).some((key) => /^(?:gen_ai|vercel\.ai|ai|llm)\./.test(key))
  );
}
/** Include AI spans embedded in transactions, deduplicated against standalone copies. */
export function aiItems(items: readonly LocalFeedItem[]): LocalFeedItem[] {
  const found = new Map<string, LocalFeedItem>();
  for (const item of items) {
    const payload = record(item.payload);
    const candidates = [
      item,
      ...(Array.isArray(payload.spans) ? payload.spans : [])
        .filter(isAiPayload)
        .map((span, index): LocalFeedItem => {
          const data = record(span);
          const traceId = item.metadata?.traceId;
          const enriched = { ...data, trace_id: data.trace_id ?? traceId };
          return {
            ...item,
            id: `${item.id}:span:${text(data.span_id) ?? index}`,
            type: "span",
            payload: enriched,
            text: display(enriched),
            metadata: getEventMetadata(enriched, "span"),
          };
        }),
    ];
    for (const candidate of candidates)
      if (isAiPayload(candidate.payload)) {
        const metadata = candidate.metadata;
        const key = metadata?.spanId
          ? `${metadata.traceId ?? ""}:${metadata.spanId}`
          : candidate.id;
        found.set(key, candidate);
      }
  }
  return [...found.values()];
}
export type AiInspection = {
  fields: { label: string; value: string }[];
  system?: unknown;
  messages?: unknown;
  response?: unknown;
  tools: unknown[];
};
export function inspectAi(payload: unknown): AiInspection | undefined {
  if (!isAiPayload(payload)) return;
  const data = spanData(payload);
  const pick = (...keys: string[]) =>
    keys
      .map((key) => data[key])
      .find(
        (value) =>
          value !== undefined &&
          value !== null &&
          (typeof value !== "string" || value.trim().length > 0),
      );
  const meaningful = (value: unknown): boolean => {
    if (value === undefined || value === null) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return typeof value !== "object" || Object.keys(value).length > 0;
  };
  const definitions: [string, string[]][] = [
    [
      "Model",
      ["gen_ai.request.model", "gen_ai.response.model", "vercel.ai.model.id"],
    ],
    [
      "Provider",
      ["gen_ai.system", "gen_ai.provider.name", "vercel.ai.model.provider"],
    ],
    [
      "Input tokens",
      [
        "gen_ai.usage.input_tokens",
        "vercel.ai.usage.promptTokens",
        "ai.usage.promptTokens",
      ],
    ],
    [
      "Output tokens",
      [
        "gen_ai.usage.output_tokens",
        "vercel.ai.usage.completionTokens",
        "ai.usage.completionTokens",
      ],
    ],
    [
      "Finish reason",
      ["gen_ai.response.finish_reasons", "vercel.ai.response.finishReason"],
    ],
    ["Function", ["gen_ai.function_id", "vercel.ai.telemetry.functionId"]],
    ["Max retries", ["vercel.ai.settings.maxRetries"]],
    ["Max steps", ["vercel.ai.settings.maxSteps"]],
  ];
  const callKeys = [
    "gen_ai.response.tool_calls",
    "vercel.ai.response.toolCalls",
    "ai.response.toolCalls",
  ];
  const calls =
    callKeys
      .map((key) => parsed(data[key]))
      .find(
        (value) =>
          Array.isArray(value) &&
          value.length > 0 &&
          value.every(
            (call) =>
              call !== null && typeof call === "object" && !Array.isArray(call),
          ),
      ) ?? parsed(pick(...callKeys));
  const tools = Array.isArray(calls)
    ? [...calls]
    : calls === undefined
      ? []
      : [calls];
  const toolName = pick("gen_ai.tool.name", "ai.toolCall.name");
  if (toolName !== undefined)
    tools.push({
      name: toolName,
      id: pick("gen_ai.tool.call.id", "ai.toolCall.id"),
      arguments: parsed(pick("gen_ai.tool.input", "ai.toolCall.args")),
      result: parsed(pick("gen_ai.tool.output", "ai.toolCall.result")),
    });
  const messageKeys = [
    "gen_ai.request.messages",
    "gen_ai.input.messages",
    "vercel.ai.prompt.messages",
    "vercel.ai.prompt",
    "gen_ai.prompt",
    "ai.prompt.messages",
    "ai.prompt",
  ];
  const prompts = messageKeys.map((key) => parsed(data[key]));
  const hasMessages = (value: unknown) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((message) => typeof record(message).role === "string");
  // Pick usable content before raw fallback without stripping multimodal blocks
  // or unknown captured fields from the conversation.
  const messages =
    prompts.find(
      (value) => hasMessages(value) || hasMessages(record(value).messages),
    ) ??
    prompts.find(meaningful) ??
    parsed(pick(...messageKeys));
  const wrappedSystem = prompts
    .map((value) => record(value).system)
    .find(meaningful);
  const responseKeys = [
    "gen_ai.response.text",
    "gen_ai.output.messages",
    "vercel.ai.response.text",
    "ai.response.text",
  ];
  return {
    fields: definitions.flatMap(([label, keys]) => {
      const value = pick(...keys);
      return value === undefined ? [] : [{ label, value: display(value) }];
    }),
    system: parsed(
      pick(
        "gen_ai.system_instructions",
        "gen_ai.prompt.system",
        "ai.prompt.system",
      ) ?? wrappedSystem,
    ),
    messages,
    response:
      responseKeys.map((key) => parsed(data[key])).find(meaningful) ??
      parsed(pick(...responseKeys)),
    tools,
  };
}
export function feedbackData(payload: unknown): Record<string, unknown> {
  const p = record(payload);
  return { ...p, ...record(record(p.contexts).feedback) };
}
export type SdkEntry = {
  name: string;
  version: string;
  platform: string;
  lastSeen?: number | string;
  count: number;
};
export function sdkInventory(items: readonly LocalFeedItem[]): SdkEntry[] {
  const entries = new Map<string, SdkEntry>();
  for (const item of items) {
    const p = record(item.payload),
      sdk = { ...record(item.envelopeHeader?.sdk), ...record(p.sdk) };
    const name = text(sdk.name);
    if (!name) continue;
    const version = text(sdk.version) ?? "Unknown",
      key = `${name}@${version}`;
    const previous = entries.get(key);
    const timestamp = item.timestamp ?? text(item.envelopeHeader?.sent_at);
    entries.set(key, {
      name,
      version,
      platform: text(p.platform) ?? previous?.platform ?? "Unknown",
      lastSeen: timestamp ?? previous?.lastSeen,
      count: (previous?.count ?? 0) + 1,
    });
  }
  return [...entries.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}
export function errorMarkdown(item: LocalFeedItem): string {
  const p = record(item.payload);
  const exceptions = getEventExceptions(p)
    .map(
      (exception) =>
        `### ${formatExceptionTitle(exception)}\n${exception.frames.map((frame) => `- ${frame.function} (${frame.filename}${frame.line === undefined ? "" : `:${frame.line}`})${frame.source ? `\n    ${frame.source}` : ""}`).join("\n")}`,
    )
    .join("\n\n");
  return [
    `# ${item.metadata?.title ?? item.type}`,
    exceptions,
    `## Captured context\n\n${display({ request: p.request, contexts: p.contexts, tags: p.tags, extra: p.extra, breadcrumbs: p.breadcrumbs })}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Name an event by what it carries; severity alone does not make it an exception. */
export function eventKind(payload: unknown): "Exception" | "Message" | "Event" {
  const p = record(payload);
  const exceptions = record(p.exception).values;
  if (Array.isArray(exceptions) && exceptions.length) return "Exception";
  const hasText = (value: unknown) =>
    Boolean(
      text(value) ??
      text(record(value).formatted) ??
      text(record(value).message),
    );
  return hasText(p.message) || hasText(p.logentry) ? "Message" : "Event";
}

/** Top-level event fields that otherwise only appear in the raw JSON. */
export function eventSummaryFields(
  payload: unknown,
): { label: string; value: string }[] {
  const p = record(payload);
  const exceptions = record(p.exception).values;
  const handled = (Array.isArray(exceptions) ? exceptions : [])
    .map((exception) => record(record(exception).mechanism).handled)
    .filter((value): value is boolean => typeof value === "boolean");
  return Object.entries({
    Level: text(p.level),
    Handled: handled.length
      ? handled.every(Boolean)
        ? "Yes"
        : "No"
      : undefined,
    Environment: text(p.environment),
    Release: text(p.release),
    Server: text(p.server_name),
  }).flatMap(([label, value]) => (value ? [{ label, value }] : []));
}

const CONTEXT_LABELS: Record<string, string> = {
  os: "OS",
  client_os: "Client OS",
  gpu: "GPU",
};
export function contextLabel(name: string): string {
  const label = CONTEXT_LABELS[name] ?? name.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export const EVENT_CONTEXT_SECTIONS = [
  "user",
  "request",
  "contexts",
  "tags",
  "extra",
  "modules",
] as const;
export function hasEventContext(payload: unknown): boolean {
  const value = record(payload);
  const breadcrumbs = Array.isArray(value.breadcrumbs)
    ? value.breadcrumbs
    : record(value.breadcrumbs).values;
  return (
    (Array.isArray(breadcrumbs) && breadcrumbs.length > 0) ||
    EVENT_CONTEXT_SECTIONS.some((key) => hasEventSection(value, key))
  );
}
/** Whether a context section has fields to show; empty named contexts do not count. */
export function hasEventSection(
  payload: unknown,
  key: (typeof EVENT_CONTEXT_SECTIONS)[number],
): boolean {
  const section = record(record(payload)[key]);
  return key === "contexts"
    ? Object.values(section).some(
        (context) => Object.keys(record(context)).length > 0,
      )
    : Object.keys(section).length > 0;
}
