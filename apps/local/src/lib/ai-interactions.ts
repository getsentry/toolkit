import type { TraceSpan } from "./trace-model.ts";
import {
  display,
  inspectAi,
  parsed,
  record,
  spanData,
  type AiInspection,
} from "./inspection.ts";

type InteractionNode = {
  payload: unknown;
  children: InteractionNode[];
  start?: number;
};

function finishReason(value: unknown): string | undefined {
  const decoded = parsed(value);
  if (Array.isArray(decoded))
    return typeof decoded[0] === "string"
      ? decoded[0].trim() || undefined
      : undefined;
  if (typeof decoded !== "string") return;
  const reason = decoded.trim();
  return reason && !["[", "{", '"'].includes(reason[0]!) ? reason : undefined;
}

function tokenCount(
  data: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = data[key];
    const number =
      typeof value === "string" && value.trim() ? Number(value) : value;
    if (typeof number === "number" && Number.isFinite(number) && number >= 0)
      return number;
  }
}

function hasConversation(value: unknown): boolean {
  const messages = record(value).messages ?? value;
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.every((message) => typeof record(message).role === "string")
  );
}

const TOKEN_KEYS = {
  "Input tokens": [
    "gen_ai.usage.input_tokens",
    "vercel.ai.usage.promptTokens",
    "ai.usage.promptTokens",
  ],
  "Output tokens": [
    "gen_ai.usage.output_tokens",
    "vercel.ai.usage.completionTokens",
    "ai.usage.completionTokens",
  ],
} as const;

/** A Local inspector summary; captured payloads and per-step details stay intact. */
export function inspectAiInteraction(
  payload: unknown,
  steps: readonly TraceSpan[],
): AiInspection | undefined {
  const own = inspectAi(payload);
  if (!own) return;
  const root: InteractionNode = { payload, children: [] };
  const nodes = [root];
  const seen = new Set<string>();
  const pending = steps.toReversed().map((span) => ({ span, parent: root }));
  while (pending.length) {
    const { span, parent } = pending.pop()!;
    if (seen.has(span.id)) continue;
    seen.add(span.id);
    const node: InteractionNode = {
      payload: span.payload,
      children: [],
      start: span.startTimestamp,
    };
    parent.children.push(node);
    nodes.push(node);
    for (const child of span.children.toReversed())
      pending.push({ span: child, parent: node });
  }
  const vercel = nodes.some((node) =>
    Object.keys(spanData(node.payload)).some((key) =>
      key.startsWith("vercel.ai."),
    ),
  );
  const fields = new Map<string, string>();
  let system = own.system;
  let messages = own.messages;
  let response: unknown;
  let reason: string | undefined;
  let hasResponse = false;
  const tools: unknown[] = [];
  // Stable timestamp order makes late-arriving earlier turns unable to replace
  // the latest model response. Untimed captures retain their tree order.
  const ordered = [...nodes].sort((a, b) =>
    a === root
      ? -1
      : b === root
        ? 1
        : (a.start ?? Infinity) - (b.start ?? Infinity),
  );
  for (const node of ordered) {
    const ai = inspectAi(node.payload);
    if (!ai) continue;
    for (const field of ai.fields) {
      if (
        field.label !== "Finish reason" &&
        !(field.label in TOKEN_KEYS) &&
        !fields.has(field.label)
      )
        fields.set(field.label, field.value);
    }
    system ??= ai.system;
    if (
      messages === undefined ||
      (!hasConversation(messages) && hasConversation(ai.messages))
    )
      messages = ai.messages;
    tools.push(...ai.tools);
    const data = spanData(node.payload);
    const nodeReason =
      finishReason(data["gen_ai.response.finish_reasons"]) ??
      finishReason(data["vercel.ai.response.finishReason"]);
    const captured = ai.response;
    const usable =
      captured !== undefined &&
      captured !== null &&
      captured !== "" &&
      (!Array.isArray(captured) || captured.length > 0);
    if (usable) {
      response = captured;
      reason = nodeReason;
      hasResponse = true;
    } else if (!hasResponse && nodeReason !== undefined) reason = nodeReason;
  }
  for (const [label, keys] of Object.entries(TOKEN_KEYS)) {
    const totals = new Map<InteractionNode, number | undefined>();
    for (const node of nodes.toReversed()) {
      const reported = tokenCount(spanData(node.payload), keys);
      let children: number | undefined;
      for (const child of node.children) {
        const value = totals.get(child);
        if (value !== undefined) children = (children ?? 0) + value;
      }
      // Vercel parents may report a full subtotal or only the final step.
      // Reconcile their non-overlapping child totals rather than counting both.
      const total =
        reported === undefined
          ? children
          : children === undefined
            ? reported
            : vercel
              ? Math.max(reported, children)
              : reported + children;
      totals.set(node, total);
    }
    const total = totals.get(root);
    if (total !== undefined && Number.isFinite(total))
      fields.set(label, display(total));
  }
  if (reason !== undefined) fields.set("Finish reason", reason);
  const data = spanData(payload);
  const operation =
    data["gen_ai.operation.name"] ??
    data["vercel.ai.operationId"] ??
    record(payload).op;
  if (typeof operation === "string" && operation)
    fields.set("Operation", operation);
  const agent = data["gen_ai.agent.name"];
  if (typeof agent === "string" && agent) fields.set("Agent", agent);
  return {
    fields: [...fields].map(([label, value]) => ({ label, value })),
    system,
    messages,
    response,
    tools,
  };
}
