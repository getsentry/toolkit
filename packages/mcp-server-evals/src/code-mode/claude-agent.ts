import { spawn } from "node:child_process";
import { z } from "zod";

interface ClaudeAgentOptions {
  toolNames: string[];
  serverName: string;
  model?: string;
  /** Omit to keep Claude Code's default instructions and let it select tools. */
  systemPrompt?: string;
}

const usageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
});
const contentSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
});
// Select task evidence without persisting account, session, or machine metadata.
const eventSchema = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  message: z
    .object({
      model: z.string().optional(),
      content: z.array(contentSchema),
    })
    .optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
  usage: usageSchema.optional(),
  total_cost_usd: z.number().optional(),
  num_turns: z.number().optional(),
  duration_api_ms: z.number().optional(),
});
type TraceEvent = z.infer<typeof eventSchema>;

/** Fresh authenticated Claude session with the supplied MCP inventory. */
export async function runClaudeAgent(
  directory: string,
  mcpUrl: string,
  accessToken: string,
  prompt: string,
  { toolNames, serverName, model, systemPrompt }: ClaudeAgentOptions,
) {
  const toolPrefix = `mcp__${serverName}__`;
  const allowedTools = toolNames.map((name) => `${toolPrefix}${name}`);
  const events: TraceEvent[] = [];
  let buffer = "";
  let bytes = 0;
  let protocolError: string | undefined;
  let processError: string | undefined;
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--tools",
    "",
    "--allowedTools",
    allowedTools.join(","),
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({
      mcpServers: {
        [serverName]: {
          type: "http",
          url: mcpUrl,
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      },
    }),
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--effort",
    "medium",
    "--no-chrome",
    ...(systemPrompt === undefined ? [] : ["--system-prompt", systemPrompt]),
    ...(model ? ["--model", model] : []),
  ];
  const started = performance.now();
  const child = spawn("claude", args, {
    cwd: directory,
    stdio: ["pipe", "pipe", "pipe"],
    signal: AbortSignal.timeout(300_000),
  });
  const fail = (error: string) => {
    protocolError ??= error;
    child.kill();
  };
  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    let event: TraceEvent;
    try {
      event = eventSchema.parse(JSON.parse(line));
    } catch {
      fail("Claude emitted an invalid JSON event");
      return;
    }
    events.push(event);
    if (
      event.type === "system" &&
      event.subtype === "init" &&
      (event.tools?.length !== allowedTools.length ||
        allowedTools.some((name) => !event.tools?.includes(name)))
    ) {
      fail(
        "Claude advertised tools outside the experiment or omitted its MCP tools",
      );
    }
    if (
      event.type === "assistant" &&
      event.message?.content.some(
        (block) =>
          block.type === "tool_use" && !allowedTools.includes(block.name ?? ""),
      )
    ) {
      fail("Claude used a tool outside the experiment");
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 10_000_000) {
      fail("Agent trace exceeded 10 MB");
      return;
    }
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
  });
  // Drain diagnostics, but do not save potentially identifying CLI metadata.
  child.stderr.resume();
  child.stdin.on("error", () => {
    processError ??= "Claude closed its input before accepting the prompt";
  });
  child.stdin.end(prompt);
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      processError = error.message;
    });
    child.once("close", resolve);
  });
  consumeLine(buffer);

  const init = events.find(
    (event) => event.type === "system" && event.subtype === "init",
  );
  const completion = events.findLast((event) => event.type === "result");
  const assistantMessages = events.filter(
    (event) => event.type === "assistant",
  );
  const calls = new Map(
    assistantMessages.flatMap((event) =>
      (event.message?.content ?? [])
        .filter((block) => block.type === "tool_use" && block.id)
        .map((block) => [block.id, block] as const),
    ),
  );
  const results = new Map(
    events
      .filter((event) => event.type === "user")
      .flatMap((event) =>
        (event.message?.content ?? [])
          .filter((block) => block.type === "tool_result" && block.tool_use_id)
          .map((block) => [block.tool_use_id, block] as const),
      ),
  );
  const finalMessage = assistantMessages.findLast((event) =>
    event.message?.content.some((block) => block.type === "text"),
  );
  const resolvedModel = assistantMessages.findLast(
    (event) => event.message?.model && event.message.model !== "<synthetic>",
  )?.message?.model;
  return {
    durationMs: Math.round(performance.now() - started),
    model: resolvedModel ?? init?.model,
    advertisedModel: init?.model,
    exitCode,
    error:
      processError ??
      protocolError ??
      (!init ? "Claude did not advertise its tool inventory" : undefined) ??
      (exitCode !== 0 ||
      !completion ||
      completion.subtype !== "success" ||
      completion.is_error
        ? completion?.errors?.join("; ") ||
          completion?.result ||
          "Claude did not finish successfully"
        : undefined),
    text:
      completion?.result ??
      finalMessage?.message?.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n") ??
      "",
    // The result is already aggregated; summing message usage double-counts it.
    usage: completion?.usage,
    reportedCostUsd: completion?.total_cost_usd,
    turns: completion?.num_turns,
    modelDurationMs: completion?.duration_api_ms,
    mcpCalls: [...calls.values()].map(({ id, name, input }) => ({
      id,
      name: name?.startsWith(toolPrefix) ? name.slice(toolPrefix.length) : name,
      input,
    })),
    mcpErrors: [...results.values()].filter((result) => result.is_error).length,
    toolResultBytes: [...results.values()].reduce(
      (sum, result) =>
        sum + Buffer.byteLength(JSON.stringify(result.content ?? null)),
      0,
    ),
    events,
  };
}
