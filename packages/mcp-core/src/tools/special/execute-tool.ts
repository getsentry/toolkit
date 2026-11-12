import { type Span, type SpanAttributeValue, startSpan } from "@sentry/core";
import { z } from "zod";
import { defineTool } from "../../internal/tool-helpers/define";
import {
  isExpectedToolError,
  recordToolFailure,
} from "../../internal/error-handling";
import { UserInputError } from "../../errors";
import { withRoutedCredential } from "../../internal/tool-helpers/credential-routing";
import { ALL_SKILLS } from "../../skills";
import type { ServerContext } from "../../types";
import {
  getSearchableTools,
  prepareToolCallParams,
  type ToolRegistry,
} from "../catalog-runtime/availability";
import type { ToolConfig } from "../types";

// Models often name the target tool or its arguments with these keys instead
// of `name` and `arguments`. They stay undocumented to keep the schema small.
const NAME_ALIASES = ["toolName", "tool", "tool_name"] as const;
const ARGUMENTS_ALIASES = ["params", "args"] as const;

// Read-only, so it is safe to run through this wrapper, which models often do.
const SEARCH_TOOL_NAME = "search_sentry_tools";

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
        const paramsWithConstraints = await prepareToolCallParams({
          tool,
          params,
          context,
        });
        setToolArgumentAttributes(span, paramsWithConstraints);
        const output = await withRoutedCredential(
          context,
          paramsWithConstraints,
          async (callContext) =>
            await tool.handler(paramsWithConstraints as never, callContext),
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
    title: "Execute Sentry Tool",
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
        .optional()
        .describe("The name of the available tool to execute."),
      arguments: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Arguments for the target tool, matching the schema returned by search_sentry_tools.",
        ),
      ...Object.fromEntries(
        NAME_ALIASES.map((key) => [key, z.string().trim().min(1).optional()]),
      ),
      ...Object.fromEntries(
        ARGUMENTS_ALIASES.map((key) => [
          key,
          z.record(z.string(), z.unknown()).optional(),
        ]),
      ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    async handler(params, context: ServerContext) {
      const input = params as Record<string, unknown>;
      const name =
        params.name ??
        NAME_ALIASES.map((key) => input[key]).find(
          (value): value is string => typeof value === "string",
        );
      const args =
        params.arguments ??
        ARGUMENTS_ALIASES.map((key) => input[key]).find(
          (value): value is Record<string, unknown> =>
            typeof value === "object" && value !== null,
        ) ??
        {};

      if (!name) {
        throw new UserInputError(
          "Missing `name`. Pass the tool to run as `name` and its arguments as `arguments`, for example execute_sentry_tool(name='find_projects', arguments={}).",
        );
      }

      const tools = getTools();
      const availableTools = getSearchableTools({
        tools,
        context,
        experimentalMode: context.experimentalMode ?? false,
        useDefaultSurfacePolicy: true,
      });
      const matchedTool =
        availableTools.find(
          ({ key, tool }) => key === name || tool.name === name,
        )?.tool ??
        (name === SEARCH_TOOL_NAME ? tools[SEARCH_TOOL_NAME] : undefined);

      if (!matchedTool) {
        throw new UserInputError(
          `Tool "${name}" is not available in this session. Use search_sentry_tools to find an executable tool.`,
        );
      }

      return await executeCatalogToolWithSpan({
        tool: matchedTool,
        params: args,
        context,
      });
    },
  });
}
