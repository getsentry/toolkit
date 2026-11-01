import { experimental_createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { getOpenRouterModel } from "@sentry/mcp-core/internal/agents/openrouter-provider";
import { generateText, stepCountIs, type LanguageModel } from "ai";

function toToolCall(call: { toolName: string; input: unknown }) {
  const input =
    call.input && typeof call.input === "object" && !Array.isArray(call.input)
      ? (call.input as Record<string, unknown>)
      : {};

  return {
    name: call.toolName,
    arguments: input,
  };
}

export function McpToolCallTaskRunner(
  model: LanguageModel = getOpenRouterModel(),
  maxSteps = 6,
) {
  return async function McpToolCallTaskRunner(input: string) {
    const transport = new Experimental_StdioMCPTransport({
      command: "pnpm",
      args: ["--filter", "@sentry/mcp-server-evals", "start"],
      env: {
        ...process.env,
        SENTRY_HOST: "sentry.io",
      },
    });
    const client = await experimental_createMCPClient({ transport });

    try {
      const tools = await client.tools();
      const result = await generateText({
        model,
        tools,
        system: [
          "You are a Sentry assistant with access to Sentry MCP tools.",
          "Use search_sentry_tools only when you need to discover the right Sentry operation or inspect its schema.",
          "When you already know the right Sentry tool name, use that tool directly through the available MCP tools.",
        ].join("\n"),
        prompt: input,
        stopWhen: stepCountIs(maxSteps),
        experimental_telemetry: {
          isEnabled: true,
          functionId: "catalog_tool_behavior_eval",
        },
      });

      return {
        result: result.text,
        toolCalls: result.steps.flatMap((step) =>
          step.toolCalls.map(toToolCall),
        ),
      };
    } finally {
      await client.close();
    }
  };
}
