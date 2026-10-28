import { record, parsed } from "../internal/wireValues.ts";
/** Merge legacy span data and typed span-v2 attributes without losing unknown fields. */
export function readSpanData(payload: unknown): Record<string, unknown> {
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
export function isAIInteraction(payload: unknown): boolean {
  const p = record(payload),
    data = readSpanData(p);
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
export type AIInspection = {
  fields: Record<string, unknown>;
  system?: unknown;
  messages?: unknown;
  response?: unknown;
  tools: unknown[];
};
export function inspectAI(payload: unknown): AIInspection | undefined {
  if (!isAIInteraction(payload)) return;
  const data = readSpanData(payload);
  const pick = (...keys: string[]) =>
    keys
      .map((key) => data[key])
      .find((value) => value !== undefined && value !== null);
  const definitions: [string, string[]][] = [
    [
      "model",
      ["gen_ai.request.model", "gen_ai.response.model", "vercel.ai.model.id"],
    ],
    [
      "provider",
      ["gen_ai.system", "gen_ai.provider.name", "vercel.ai.model.provider"],
    ],
    [
      "inputTokens",
      [
        "gen_ai.usage.input_tokens",
        "vercel.ai.usage.promptTokens",
        "ai.usage.promptTokens",
      ],
    ],
    [
      "outputTokens",
      [
        "gen_ai.usage.output_tokens",
        "vercel.ai.usage.completionTokens",
        "ai.usage.completionTokens",
      ],
    ],
    [
      "finishReason",
      ["gen_ai.response.finish_reasons", "vercel.ai.response.finishReason"],
    ],
    ["function", ["gen_ai.function_id", "vercel.ai.telemetry.functionId"]],
    ["maxRetries", ["vercel.ai.settings.maxRetries"]],
    ["maxSteps", ["vercel.ai.settings.maxSteps"]],
  ];
  const calls = parsed(
    pick(
      "gen_ai.response.tool_calls",
      "vercel.ai.response.toolCalls",
      "ai.response.toolCalls",
    ),
  );
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
  return {
    fields: Object.fromEntries(
      definitions.flatMap(([label, keys]) => {
        const value = pick(...keys);
        return value === undefined ? [] : [[label, value]];
      }),
    ),
    system: parsed(
      pick(
        "gen_ai.system_instructions",
        "gen_ai.prompt.system",
        "ai.prompt.system",
      ),
    ),
    messages: parsed(
      pick(
        "gen_ai.request.messages",
        "gen_ai.input.messages",
        "vercel.ai.prompt.messages",
        "vercel.ai.prompt",
        "gen_ai.prompt",
        "ai.prompt.messages",
        "ai.prompt",
      ),
    ),
    response: parsed(
      pick(
        "gen_ai.response.text",
        "gen_ai.output.messages",
        "vercel.ai.response.text",
        "ai.response.text",
      ),
    ),
    tools,
  };
}
