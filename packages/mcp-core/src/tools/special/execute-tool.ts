import { type Span, type SpanAttributeValue, startSpan } from "@sentry/core";
import { z } from "zod";
import { defineTool } from "../../internal/tool-helpers/define";
import {
  isExpectedToolError,
  recordToolFailure,
} from "../../internal/error-handling";
import { UserInputError } from "../../errors";
import { ALL_SKILLS } from "../../skills";
import type { ServerContext } from "../../types";
import {
  getSearchableTools,
  prepareToolParams,
  type ToolRegistry,
} from "../catalog-runtime/availability";
import type { ToolConfig } from "../types";

function setToolArgumentAttributes(
  span: Span,
  params: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(params)) {
    const attributeValue =
      value == null || typeof value === "object"
        ? JSON.stringify(value)
        : value;
    span.setAttribute(
      `gen_ai.tool.call.arguments.${key}`,
      attributeValue as SpanAttributeValue | undefined,
    );
  }
}

async function executeCatalogToolWithSpan({
  tool,
  params,
  context,
}: {
  tool: ToolConfig<any>;
  params: Record<string, unknown>;
  context: ServerContext;
}) {
  return await startSpan(
    {
      name: `tools/call ${tool.name}`,
      op: "mcp.execute_tool",
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": tool.name,
      },
    },
    async (span) => {
      try {
        const paramsWithConstraints = prepareToolParams({
          tool,
          params,
          context,
        });
        setToolArgumentAttributes(span, paramsWithConstraints);
        const output = await tool.handler(
          paramsWithConstraints as never,
          context,
        );
        span.setStatus({ code: 1 });
        return output;
      } catch (error) {
        span.setStatus({ code: 2 });
        // Expected failures (validation, AI provider outages) still fail the
        // span, but skip exception recording to avoid Sentry noise.
        if (!isExpectedToolError(error)) {
          span.recordException(error);
        }
        recordToolFailure(tool, error, params, context);
        throw error;
      }
    },
  );
}

export function createExecuteTool(getTools: () => ToolRegistry) {
  return defineTool({
    name: "execute_sentry_tool",
    skills: ALL_SKILLS,
    requiredScopes: [],
    description: [
      "Execute an available Sentry MCP tool discovered through search_sentry_tools.",
      "",
      "Use this tool when you need to:",
      "- Call a Sentry operation returned by search_sentry_tools",
      "- Execute a tool by name using arguments that match its returned schema",
      "",
      "<examples>",
      "execute_sentry_tool(name='find_projects', arguments={ organizationSlug: 'my-org' })",
      "execute_sentry_tool(name='whoami', arguments={})",
      "</examples>",
      "",
      "<hints>",
      "- Use search_sentry_tools first if you are not sure which name or arguments to pass.",
      "- Arguments are validated against the target tool's schema before execution.",
      "- Active organization, project, and region constraints are injected automatically.",
      "</hints>",
    ].join("\n"),
    inputSchema: {
      name: z
        .string()
        .trim()
        .min(1)
        .describe("The name of the available tool to execute."),
      arguments: z
        .record(z.string(), z.unknown())
        .default({})
        .describe(
          "Arguments for the target tool, matching the schema returned by search_sentry_tools.",
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    async handler(params, context: ServerContext) {
      const availableTools = getSearchableTools({
        tools: getTools(),
        context,
        experimentalMode: context.experimentalMode ?? false,
        useDefaultSurfacePolicy: true,
      });
      const match = availableTools.find(
        ({ key, tool }) => key === params.name || tool.name === params.name,
      );

      if (!match) {
        throw new UserInputError(
          `Tool "${params.name}" is not available in this session. Use search_sentry_tools to find an executable tool.`,
        );
      }

      return await executeCatalogToolWithSpan({
        tool: match.tool,
        params: params.arguments,
        context,
      });
    },
  });
}
