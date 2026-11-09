/**
 * MCP Server Configuration and Request Handling Infrastructure.
 *
 * This module orchestrates tool execution and telemetry collection
 * in a unified server interface for LLMs.
 *
 * **Configuration Example:**
 * ```typescript
 * const server = buildServer({
 *   context: {
 *     accessToken: "your-sentry-token",
 *     sentryHost: "sentry.io",
 *     userId: "user-123",
 *     clientId: "mcp-client",
 *     constraints: {}
 *   },
 *   wrapWithSentry: (s) => Sentry.wrapMcpServerWithSentry(s),
 * });
 * ```
 */
import {
  type CallToolResult,
  type JSONRPCRequest,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type Result,
} from "@modelcontextprotocol/server";
import {
  getActiveSpan,
  type SpanAttributeValue,
  setUser,
  setAttributes,
  setTags,
} from "@sentry/core";
import { wrapMcpServerWithSentry } from "@sentry/core/server";
import { isApiAuthenticationErrorDeep } from "./api-client";
import { isUnauthorizedHandled } from "./internal/tool-helpers/credential-routing";
import { MAX_TOOL_INPUT_ELEMENTS } from "@sentry/toolkit-core/mcp-limits";
import { MCP_SERVER_INFO } from "./constants";
import { buildServerInstructions } from "./server-instructions";
import {
  formatErrorForUser,
  isExpectedToolError,
  recordToolFailure,
} from "./internal/error-handling";
import type { Skill } from "./skills";
import { type LogIssueOptions, logIssue } from "./telem/logging";
import {
  executeToolHandler,
  getAvailableTools,
  getFilteredInputSchema,
  injectConstraintParams,
  resolveToolDescription,
  type ToolRegistry,
} from "./tools/catalog-runtime/availability";
import tools from "./tools/index";
import { isCatalogInfrastructureToolName } from "./tools/surfaces";
import type { StructuredToolOutput } from "./tools/types";
import type { ServerContext } from "./types";
import { getServerVersion } from "./version";

function getSkillGrantedAttributeName(skill: Skill): string {
  return `app.consent.skill.${skill.replaceAll("-", "_")}.granted`;
}

/**
 * Request-scoped attributes for the active `tools/call` span.
 */
function getToolCallSpanAttributes(
  context: ServerContext,
  experimentalMode: boolean,
): Record<string, SpanAttributeValue> {
  const attributes: Record<string, SpanAttributeValue> = {
    "app.server.mode.experimental": experimentalMode,
  };
  if (context.transport) {
    attributes["app.transport"] = context.transport;
  }
  if (context.clientFamily) {
    attributes["app.client.family"] = context.clientFamily;
  }
  if (context.constraints.organizationSlug) {
    attributes["app.constraint.organization_slug"] =
      context.constraints.organizationSlug;
  }
  if (context.constraints.projectSlug) {
    attributes["app.constraint.project_slug"] = context.constraints.projectSlug;
  }
  for (const skill of [...(context.grantedSkills ?? [])].sort()) {
    attributes[getSkillGrantedAttributeName(skill)] = true;
  }
  return attributes;
}

type RequestHandler = (
  request: JSONRPCRequest,
  ctx: unknown,
) => Promise<Result>;

/**
 * Makes calls to tool names this server did not register visible.
 *
 * The SDK rejects them with a -32602 JSON-RPC error before any of our
 * handlers run. Sentry's MCP instrumentation treats -32602 as a client error
 * and leaves the `tools/call` span status unset, so these calls showed up as
 * successful 0ms spans without our request attributes. This marks the span as
 * failed with `error.type: unknown_tool`, which keeps the call out of Sentry
 * Issues, and explains the removed gateway tools that older sessions still
 * call.
 */
function markUnknownToolCalls(
  server: McpServer,
  registeredToolNames: ReadonlySet<string>,
  spanAttributes: Record<string, SpanAttributeValue>,
): void {
  // The SDK has no hook for unknown tool names, so this wraps its tools/call
  // handler in the Protocol's private handler map.
  // If an SDK upgrade changes it, this is a no-op.
  const handlers = (server.server as unknown as { _requestHandlers?: unknown })
    ._requestHandlers;
  if (!(handlers instanceof Map)) {
    return;
  }
  const requestHandlers = handlers as Map<string, RequestHandler>;
  const handleToolsCall = requestHandlers.get("tools/call");
  if (typeof handleToolsCall !== "function") {
    return;
  }

  requestHandlers.set("tools/call", async (request, ctx) => {
    const name = request.params?.name;
    if (typeof name !== "string" || registeredToolNames.has(name)) {
      return await handleToolsCall(request, ctx);
    }

    const activeSpan = getActiveSpan();
    if (activeSpan) {
      activeSpan.setAttributes({
        ...spanAttributes,
        "error.type": "unknown_tool",
      });
      activeSpan.setStatus({
        code: 2, // error
        message: "not_found",
      });
    }

    if (isCatalogInfrastructureToolName(name)) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Tool ${name} was removed from the Sentry MCP server. Call Sentry tools directly by name. If they are missing from your tool list, reconnect the Sentry MCP server to refresh it.`,
      );
    }
    return await handleToolsCall(request, ctx);
  });
}

function isCallToolResult(output: unknown): output is CallToolResult {
  return (
    !!output &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    Array.isArray((output as { content?: unknown }).content)
  );
}

/**
 * Detects structured-only tool output. Full CallToolResult objects are excluded
 * so compatibility text generation stays centralized in server.ts.
 */
function isStructuredToolOutput(
  output: unknown,
): output is StructuredToolOutput {
  return (
    !!output &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    "structuredContent" in output &&
    !("content" in output) &&
    !!(output as { structuredContent?: unknown }).structuredContent &&
    typeof (output as { structuredContent?: unknown }).structuredContent ===
      "object" &&
    !Array.isArray(
      (output as { structuredContent?: unknown }).structuredContent,
    )
  );
}

/**
 * Wraps structured-only output in an MCP CallToolResult with generated JSON
 * text for clients that do not read structuredContent yet.
 *
 * The text is compact JSON because clients that read it send it to a model,
 * and indentation adds tokens without adding data.
 */
function structuredOutputToCallToolResult(
  output: StructuredToolOutput,
): CallToolResult {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(output.structuredContent),
      },
    ],
    structuredContent: output.structuredContent,
  };
}

/**
 * Replaces lone UTF-16 surrogates in tool output with U+FFFD.
 *
 * Formatters truncate upstream text by UTF-16 index, so a cut can keep only
 * half of an emoji. `JSON.stringify` writes that half as `\ud83d`, and strict
 * JSON parsers such as serde_json in Codex reject the message and close the
 * transport. Normalizing handler output here covers every tool, including
 * structuredContent and the compatibility text generated from it.
 *
 * Runs on every tool call, so it copies on write: it returns the input itself
 * when nothing changes, and copies only the arrays and objects on the path to
 * a replaced string. V8 returns the same string from `toWellFormed()` when it
 * is already well formed, so the `!==` checks are pointer comparisons.
 */
function toWellFormedOutput<T>(value: T): T {
  if (typeof value === "string") {
    return value.toWellFormed() as T;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined;
    for (let index = 0; index < value.length; index++) {
      const next = toWellFormedOutput(value[index]);
      if (next !== value[index]) {
        copy ??= [...value];
        copy[index] = next;
      }
    }
    return (copy ?? value) as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  // `for...in` avoids allocating a key list per object on the common path.
  let entries: [string, unknown][] | undefined;
  let index = 0;
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    const item = record[key];
    const nextKey = key.toWellFormed();
    const next = toWellFormedOutput(item);
    if (!entries && (nextKey !== key || next !== item)) {
      entries = Object.entries(record).slice(0, index);
    }
    entries?.push([nextKey, next]);
    index++;
  }
  return (entries ? Object.fromEntries(entries) : value) as T;
}

/**
 * Creates and configures a complete MCP server with Sentry instrumentation.
 *
 * The server is built with tools filtered based on the granted skills in the context.
 * Context is captured in tool handler closures and passed directly to handlers.
 *
 * @example Usage with stdio transport
 * ```typescript
 * import { buildServer } from "@sentry/mcp-core/server";
 * import { startStdio } from "@sentry/mcp-core/transports/stdio";
 *
 * const context = {
 *   accessToken: process.env.SENTRY_TOKEN,
 *   sentryHost: "sentry.io",
 *   userId: "user-123",
 *   clientId: "cursor-ide",
 *   constraints: {}
 * };
 *
 * const server = buildServer({ context });
 * const { closed } = await startStdio(server, context);
 * await closed;
 * ```
 *
 */
export function buildServer({
  context,
  experimentalMode = false,
  tools: customTools,
}: {
  context: ServerContext;
  experimentalMode?: boolean;
  tools?: ToolRegistry;
}): McpServer {
  const contextWithModes: ServerContext = {
    ...context,
    experimentalMode,
  };
  const toolCallSpanAttributes = getToolCallSpanAttributes(
    contextWithModes,
    experimentalMode,
  );
  const registrations = configureServer({
    context: contextWithModes,
    experimentalMode,
    tools: customTools,
    toolCallSpanAttributes,
  });
  const server = new McpServer(
    {
      ...MCP_SERVER_INFO,
      version: getServerVersion(),
    },
    {
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
      instructions: buildServerInstructions(
        new Set(registrations.map(({ name }) => name)),
      ),
    },
  );
  server.server.onerror = (error) => {
    const transportLogOptions: LogIssueOptions = {
      loggerScope: ["server", "transport"] as const,
      contexts: {
        transport: {
          phase: "server.onerror",
        },
      },
    };

    logIssue(error, transportLogOptions);
  };
  for (const { name, config, handler } of registrations) {
    server.registerTool(name, config, handler);
  }
  // Registration enables this by default, but each server's tool catalog is fixed.
  if (registrations.length > 0) {
    server.server.registerCapabilities({ tools: { listChanged: false } });
    markUnknownToolCalls(
      server,
      new Set(registrations.map(({ name }) => name)),
      toolCallSpanAttributes,
    );
  }
  return wrapMcpServerWithSentry(server);
}

/**
 * Configures an MCP server with tools filtered by granted skills.
 *
 * Internal function used by buildServer(). Use buildServer() instead for most cases.
 * Tools are filtered at registration time based on grantedSkills, and context is
 * captured in closures for tool handler execution.
 */
function configureServer({
  context,
  experimentalMode = false,
  tools: customTools,
  toolCallSpanAttributes,
}: {
  context: ServerContext;
  experimentalMode?: boolean;
  tools?: ToolRegistry;
  toolCallSpanAttributes: Record<string, SpanAttributeValue>;
}) {
  const registrations = [];
  const registry: ToolRegistry = customTools ?? tools;

  const availableTools = getAvailableTools({
    tools: registry,
    context,
    experimentalMode,
    useDefaultSurfacePolicy: !customTools,
  });
  const toolsToRegister = availableTools.filter(({ isTopLevel }) => isTopLevel);
  const contextWithToolAvailability: ServerContext = {
    ...context,
    availableToolNames: new Set(
      availableTools.flatMap(({ key, tool }) => [key, tool.name]),
    ),
    directToolNames: new Set(
      toolsToRegister.flatMap(({ key, tool }) => [key, tool.name]),
    ),
  };

  for (const { tool } of toolsToRegister) {
    const filteredInputSchema = getFilteredInputSchema(
      tool,
      contextWithToolAvailability,
    );
    const resolvedDescription = resolveToolDescription(tool, {
      experimentalMode,
      availableToolNames: contextWithToolAvailability.availableToolNames,
      directToolNames: contextWithToolAvailability.directToolNames,
    });

    const toolRegistration = {
      title: tool.title,
      description: resolvedDescription,
      inputSchema: filteredInputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    };
    const handleToolCall = async (params: unknown): Promise<CallToolResult> => {
      // Get the active MCP server span and attach request-scoped attributes.
      const activeSpan = getActiveSpan();

      activeSpan?.setAttributes(toolCallSpanAttributes);

      if (context.userId) {
        const user = {
          id: context.userId,
          ...(context.userIpAddress
            ? { ip_address: context.userIpAddress }
            : {}),
        };
        setUser(user);
      }
      const requestContext = {
        ...(context.clientId ? { "client.id": context.clientId } : {}),
        ...(context.clientFamily
          ? { "app.client.family": context.clientFamily }
          : {}),
        ...(context.transport ? { "app.transport": context.transport } : {}),
        "app.server.mode.experimental": experimentalMode,
      };
      setTags(requestContext);
      setAttributes(requestContext);

      // Hoisted so both the handler path and the catch (onError) share one
      // narrowing instead of re-casting `params`.
      const rawParams =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};

      try {
        // Apply constraints as parameters, handling aliases (e.g., projectSlug → projectSlugOrId)
        const paramsWithConstraints = injectConstraintParams(
          rawParams,
          tool,
          contextWithToolAvailability,
        );

        if (activeSpan) {
          // Intentional GenAI semconv extension: per-key attrs like http.request.header.<key>.
          for (const [key, value] of Object.entries(paramsWithConstraints)) {
            const attributeValue =
              value == null || typeof value === "object"
                ? JSON.stringify(value)
                : value;
            activeSpan.setAttribute(
              `gen_ai.tool.call.arguments.${key}`,
              attributeValue as SpanAttributeValue | undefined,
            );
          }
        }

        const output = toWellFormedOutput(
          await executeToolHandler({
            tool,
            params: rawParams,
            context: contextWithToolAvailability,
          }),
        );

        if (activeSpan) {
          activeSpan.setStatus({
            code: 1, // ok
          });
        }

        // if the tool returns a string, assume it's a message
        if (typeof output === "string") {
          return {
            content: [
              {
                type: "text" as const,
                text: output,
              },
            ],
          };
        }
        // if the tool returns a list, assume it's a content list
        if (Array.isArray(output)) {
          return {
            content: output,
          };
        }
        // Some tools return a full MCP CallToolResult for custom content
        // payloads such as images or resources.
        if (isCallToolResult(output)) {
          return output;
        }
        if (isStructuredToolOutput(output)) {
          return structuredOutputToCallToolResult(output);
        }
        throw new Error(
          `Invalid tool output: ${typeof output === "object" ? JSON.stringify(output) : String(output)}`,
        );
      } catch (error) {
        if (activeSpan) {
          activeSpan.setStatus({
            code: 2, // error
          });
          // Expected tool failures (bad input, AI provider outages, auth expiry)
          // still mark the span as failed, but do not record exceptions so a
          // provider budget/outage does not flood Sentry with per-request noise.
          if (!isExpectedToolError(error)) {
            activeSpan.recordException(error);
          }
        }

        // Upstream 401 during a tool call — route via the transport so it
        // can revoke the MCP grant or refresh the token; swallow callback
        // errors since the formatted tool response still needs to land.
        // A routed call already refreshed its own credential.
        if (
          isApiAuthenticationErrorDeep(error) &&
          !isUnauthorizedHandled(error) &&
          context.onUpstreamUnauthorized
        ) {
          try {
            const refreshedToken = await context.onUpstreamUnauthorized();
            // Handlers read this shared copy, not the caller's context.
            if (refreshedToken) {
              contextWithToolAvailability.accessToken = refreshedToken;
            }
          } catch {}
        }

        // Let the tool record its own failure telemetry (e.g. search_events
        // logs the failing query).
        recordToolFailure(tool, error, rawParams, contextWithToolAvailability);

        // CRITICAL: Tool errors MUST be returned as formatted text responses,
        // NOT thrown as exceptions. This ensures consistent error handling
        // and prevents the MCP client from receiving raw error objects.
        //
        // The formatErrorForUser function provides user-friendly error messages
        // with appropriate formatting for different error types:
        // - UserInputError: Clear guidance for fixing input problems
        // - ConfigurationError: Clear guidance for fixing configuration issues
        // - LLMProviderError / AI provider outages: graceful availability message
        // - ApiError: HTTP status context with helpful messaging
        // - System errors: Sentry event IDs for debugging
        //
        // DO NOT change this to throw error - it breaks error handling!
        return {
          content: [
            {
              type: "text" as const,
              text: (
                await formatErrorForUser(error, {
                  transport: context.transport,
                })
              ).toWellFormed(),
            },
          ],
          isError: true,
        };
      }
    };

    registrations.push({
      name: tool.name,
      config: toolRegistration,
      handler: handleToolCall,
    });
  }

  return registrations;
}
