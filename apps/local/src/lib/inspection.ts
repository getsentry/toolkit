import { inspectAI, isAIInteraction as isAiPayload } from "@sentry/telemetry";
export {
  isAIInteraction as isAiPayload,
  readSpanData as spanData,
} from "@sentry/telemetry";
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
  const ai = inspectAI(payload);
  if (!ai) return;
  const labels: Record<string, string> = {
    model: "Model",
    provider: "Provider",
    inputTokens: "Input tokens",
    outputTokens: "Output tokens",
    finishReason: "Finish reason",
    function: "Function",
    maxRetries: "Max retries",
    maxSteps: "Max steps",
  };
  return {
    ...ai,
    fields: Object.entries(ai.fields).map(([key, value]) => ({
      label: labels[key] ?? key,
      value: display(value),
    })),
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

export const EVENT_CONTEXT_SECTIONS = [
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
    EVENT_CONTEXT_SECTIONS.some(
      (key) => Object.keys(record(value[key])).length > 0,
    )
  );
}
