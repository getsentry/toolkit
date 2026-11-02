import { spawn } from "node:child_process";
import { z } from "zod";

const toolNames = ["search_sentry_api", "execute_sentry_code"];

const usageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cached_input_tokens: z.number().optional(),
  cache_write_input_tokens: z.number().optional(),
  reasoning_output_tokens: z.number().optional(),
});
const itemSchema = z.object({
  id: z.string(),
  type: z.string(),
  server: z.string().optional(),
  tool: z.string().optional(),
  arguments: z.unknown().optional(),
  result: z
    .object({
      content: z.array(z.unknown()),
      structured_content: z.unknown().optional(),
    })
    .nullable()
    .optional(),
  error: z.object({ message: z.string() }).nullable().optional(),
  status: z.string().optional(),
  text: z.string().optional(),
});
const eventSchema = z.object({
  type: z.string(),
  item: itemSchema.optional(),
  usage: usageSchema.optional(),
  error: z.object({ message: z.string() }).optional(),
  message: z.string().optional(),
});
type TraceEvent = z.infer<typeof eventSchema>;

/** Fresh CLI session; reject runs that use anything besides the two MCP tools. */
export async function runCodexAgent(
  directory: string,
  mcpUrl: string,
  accessToken: string,
  prompt: string,
  { model, systemPrompt }: { model: string; systemPrompt: string },
) {
  const events: TraceEvent[] = [];
  let buffer = "";
  let bytes = 0;
  let stderr = "";
  let protocolError: string | undefined;
  let processError: string | undefined;
  const config = {
    approval_policy: "never",
    developer_instructions: systemPrompt,
    project_doc_max_bytes: 0,
    "skills.include_instructions": false,
    web_search: "disabled",
    model_reasoning_effort: "medium",
    "tools.experimental_request_user_input.enabled": false,
    "mcp_servers.sentry_code_mode.url": mcpUrl,
    "mcp_servers.sentry_code_mode.http_headers.Authorization": `Bearer ${accessToken}`,
    "mcp_servers.sentry_code_mode.enabled_tools": toolNames,
    "mcp_servers.sentry_code_mode.required": true,
    "mcp_servers.sentry_code_mode.default_tools_approval_mode": "approve",
  };
  const disabled = [
    "shell_tool",
    "apps",
    "plugins",
    "hooks",
    "memories",
    "browser_use",
    "computer_use",
    "image_generation",
    "multi_agent",
    "code_mode",
    "tool_suggest",
  ];
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--model",
    model,
    ...disabled.flatMap((feature) => ["--disable", feature]),
    ...Object.entries(config).flatMap(([key, value]) => [
      "-c",
      `${key}=${JSON.stringify(value)}`,
    ]),
    "-",
  ];
  const started = performance.now();
  const child = spawn("codex", args, {
    cwd: directory,
    stdio: ["pipe", "pipe", "pipe"],
    signal: AbortSignal.timeout(300_000),
  });
  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    try {
      // Keep task evidence, not session/account/machine metadata.
      events.push(eventSchema.parse(JSON.parse(line)));
    } catch {
      protocolError = "Agent emitted an invalid JSON event";
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 10_000_000) {
      protocolError = "Agent trace exceeded 10 MB";
      child.kill();
      return;
    }
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4_000);
  });
  child.stdin.on("error", () => {
    processError ??= "Codex closed its input before accepting the prompt";
  });
  child.stdin.end(prompt);
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      processError = error.message;
    });
    child.once("close", resolve);
  });
  consumeLine(buffer);
  const completion = events.findLast(
    (event) => event.type === "turn.completed",
  );
  const items = events.flatMap((event) =>
    event.type === "item.completed" && event.item ? [event.item] : [],
  );
  const calls = items.filter((item) => item.type === "mcp_tool_call");
  const unexpected = items.filter(
    (item) =>
      !["mcp_tool_call", "agent_message", "reasoning", "error"].includes(
        item.type,
      ) ||
      (item.type === "mcp_tool_call" &&
        (item.server !== "sentry_code_mode" ||
          !toolNames.includes(item.tool ?? ""))),
  );
  return {
    durationMs: Math.round(performance.now() - started),
    model,
    exitCode,
    error:
      processError ??
      protocolError ??
      (unexpected.length
        ? "Agent used a tool outside the experiment"
        : undefined) ??
      (exitCode !== 0 || !completion
        ? events.findLast((event) => event.error)?.error?.message ||
          stderr ||
          "Agent did not finish successfully"
        : undefined),
    text: items.findLast((item) => item.type === "agent_message")?.text ?? "",
    usage: completion?.usage,
    mcpCalls: calls.map(({ id, tool, arguments: input }) => ({
      id,
      name: tool,
      input,
    })),
    mcpErrors: calls.filter((call) => call.error || call.status === "failed")
      .length,
    toolResultBytes: calls.reduce(
      (sum, call) =>
        sum + Buffer.byteLength(JSON.stringify(call.result ?? null)),
      0,
    ),
    events,
  };
}
