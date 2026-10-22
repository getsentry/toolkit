import { experimental_createMCPClient } from "@ai-sdk/mcp";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  getOpenRouterModel,
  getOpenRouterProviderOptions,
} from "@sentry/mcp-core/internal/agents/openrouter-provider";
import { logInfo, logIssue, logWarn } from "@sentry/mcp-core/telem/logging";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type ToolSet,
} from "ai";
import { type Context, Hono } from "hono";
import { annotateResponseMetric } from "../metrics";
import type { Env } from "../types";
import {
  type AuthData,
  AuthDataSchema,
  type ChatRequest,
  type RateLimitResult,
  TokenResponseSchema,
} from "../types/chat";
import { analyzeAuthError, getAuthErrorResponse } from "../utils/auth-errors";

type MCPClient = Awaited<ReturnType<typeof experimental_createMCPClient>>;

/**
 * Ensure OpenRouter provider helpers can read worker bindings via process.env.
 * Returns false when no API key is available from either source.
 */
export function syncOpenRouterEnvFromBindings(
  env: Pick<
    Env,
    "OPENROUTER_API_KEY" | "OPENROUTER_MODEL" | "OPENROUTER_REASONING_EFFORT"
  >,
): boolean {
  const openRouterApiKey =
    env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!openRouterApiKey) {
    return false;
  }

  process.env.OPENROUTER_API_KEY = openRouterApiKey;

  // Always mirror or clear optional bindings so a reused worker isolate cannot
  // keep a previous request's model/effort after the binding is removed.
  if (env.OPENROUTER_MODEL) {
    process.env.OPENROUTER_MODEL = env.OPENROUTER_MODEL;
  } else {
    delete process.env.OPENROUTER_MODEL;
  }
  if (env.OPENROUTER_REASONING_EFFORT !== undefined) {
    process.env.OPENROUTER_REASONING_EFFORT = env.OPENROUTER_REASONING_EFFORT;
  } else {
    delete process.env.OPENROUTER_REASONING_EFFORT;
  }

  return true;
}

async function refreshTokenIfNeeded(
  c: Context<{ Bindings: Env }>,
): Promise<{ token: string; authData: AuthData } | null> {
  const { getCookie, setCookie, deleteCookie } = await import("hono/cookie");

  const authDataCookie = getCookie(c, "sentry_auth_data");
  if (!authDataCookie) {
    return null;
  }

  try {
    const authData = AuthDataSchema.parse(JSON.parse(authDataCookie));

    if (!authData.refresh_token) {
      return null;
    }

    // Import OAuth functions
    const { getOrRegisterChatClient } = await import("./chat-oauth");

    // Get the MCP host and client ID
    const redirectUri = new URL("/api/auth/callback", c.req.url).href;
    const clientId = await getOrRegisterChatClient(c.env, redirectUri);
    const mcpHost = new URL(c.req.url).origin;
    const tokenUrl = `${mcpHost}/oauth/token`;

    // Exchange refresh token for new tokens
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: authData.refresh_token,
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "Sentry MCP Chat Demo",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      logIssue(`Token refresh failed: ${response.status} - ${error}`);
      const { getSecureCookieOptions } = await import("./chat-oauth");
      deleteCookie(c, "sentry_auth_data", getSecureCookieOptions(c.req.url));
      return null;
    }

    const tokenResponse = TokenResponseSchema.parse(await response.json());

    // Prepare new auth data - fall back to original refresh_token if not rotated
    const newAuthData: AuthData = {
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token ?? authData.refresh_token,
      expires_at: new Date(
        Date.now() + (tokenResponse.expires_in || 28800) * 1000,
      ).toISOString(),
      token_type: tokenResponse.token_type,
    };

    return { token: tokenResponse.access_token, authData: newAuthData };
  } catch (error) {
    logIssue(error);
    return null;
  }
}

export default new Hono<{ Bindings: Env }>().post("/", async (c) => {
  // OpenRouter helpers in mcp-core only read process.env. Bridge worker
  // bindings first so validation and provider calls stay in sync.
  if (!syncOpenRouterEnvFromBindings(c.env)) {
    logIssue("OPENROUTER_API_KEY is not configured", {
      loggerScope: ["cloudflare", "chat"],
    });
    return c.json(
      {
        error: "AI service not configured",
        name: "AI_SERVICE_UNAVAILABLE",
      },
      500,
    );
  }

  // Get the access token from cookie
  const { getCookie } = await import("hono/cookie");
  const authDataCookie = getCookie(c, "sentry_auth_data");

  if (!authDataCookie) {
    return c.json(
      {
        error: "Authorization required",
        name: "MISSING_AUTH_TOKEN",
      },
      401,
    );
  }

  let accessToken: string;
  try {
    const authData = AuthDataSchema.parse(JSON.parse(authDataCookie));
    accessToken = authData.access_token;
  } catch (error) {
    return c.json(
      {
        error: "Invalid auth data",
        name: "INVALID_AUTH_DATA",
      },
      401,
    );
  }

  // Rate limiting check - use a hash of the access token as the key
  // Note: Rate limiting bindings are "unsafe" (beta) and may not be available in development
  // so we check if the binding exists before using it
  // https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
  if (c.env.CHAT_RATE_LIMITER) {
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(accessToken);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const rateLimitKey = `user:${hashHex.substring(0, 16)}`; // Use first 16 chars of hash

      const { success }: RateLimitResult = await c.env.CHAT_RATE_LIMITER.limit({
        key: rateLimitKey,
      });
      if (!success) {
        return annotateResponseMetric(
          c.json(
            {
              error:
                "Rate limit exceeded. You can send up to 10 messages per minute. Please wait before sending another message.",
              name: "RATE_LIMIT_EXCEEDED",
            },
            429,
          ),
          {
            responseReason: "local_rate_limit",
            rateLimitScope: "user",
          },
        );
      }
    } catch (error) {
      const eventId = logIssue(error);
      return c.json(
        {
          error: "There was an error communicating with the rate limiter.",
          name: "RATE_LIMITER_ERROR",
          eventId,
        },
        500,
      );
    }
  }

  // Declare mcpClient in outer scope for cleanup in catch block
  let mcpClient: MCPClient | null = null;

  try {
    const { messages } = await c.req.json<ChatRequest>();

    // Validate messages array
    if (!Array.isArray(messages)) {
      return c.json(
        {
          error: "Messages must be an array",
          name: "INVALID_MESSAGES_FORMAT",
        },
        400,
      );
    }

    // Create MCP client connection to the SSE endpoint
    const tools: ToolSet = {};
    let currentAccessToken = accessToken;

    try {
      // Get the current request URL to construct the MCP endpoint URL
      const requestUrl = new URL(c.req.url);
      const mcpUrl = new URL(`${requestUrl.protocol}//${requestUrl.host}/mcp`);
      const httpTransport = new StreamableHTTPClientTransport(mcpUrl, {
        requestInit: {
          headers: {
            Authorization: `Bearer ${currentAccessToken}`,
          },
        },
      });

      mcpClient = await experimental_createMCPClient({
        name: "mcp.sentry.dev (web)",
        transport: httpTransport,
      });

      // Get available tools from MCP server
      Object.assign(tools, await mcpClient.tools());
      logInfo(`Connected to ${mcpUrl}`, {
        loggerScope: ["cloudflare", "chat", "connection"],
        extra: {
          toolCount: Object.keys(tools).length,
          endpoint: mcpUrl,
        },
      });
    } catch (error) {
      // Check if this is an authentication error
      const authInfo = analyzeAuthError(error);
      if (authInfo.isAuthError) {
        // Attempt token refresh
        const refreshResult = await refreshTokenIfNeeded(c);
        if (refreshResult) {
          try {
            // Retry with new token
            currentAccessToken = refreshResult.token;
            const requestUrl = new URL(c.req.url);
            const mcpUrl = new URL(
              `${requestUrl.protocol}//${requestUrl.host}/mcp`,
            );
            const httpTransport = new StreamableHTTPClientTransport(mcpUrl, {
              requestInit: {
                headers: {
                  Authorization: `Bearer ${currentAccessToken}`,
                },
              },
            });

            mcpClient = await experimental_createMCPClient({
              name: "mcp.sentry.dev (web)",
              transport: httpTransport,
            });

            Object.assign(tools, await mcpClient.tools());
            logInfo(`Connected to ${mcpUrl} (after refresh)`, {
              loggerScope: ["cloudflare", "chat", "connection"],
              extra: {
                toolCount: Object.keys(tools).length,
                endpoint: mcpUrl,
                refreshed: true,
              },
            });

            // Update cookie with new auth data
            const { setCookie } = await import("hono/cookie");
            const { getSecureCookieOptions } = await import("./chat-oauth");
            setCookie(
              c,
              "sentry_auth_data",
              JSON.stringify(refreshResult.authData),
              getSecureCookieOptions(c.req.url, 30 * 24 * 60 * 60),
            );
          } catch (retryError) {
            if (authInfo.statusCode === 403) {
              return c.json(getAuthErrorResponse(authInfo), 403);
            }
            return c.json(getAuthErrorResponse(authInfo), 401);
          }
        } else {
          if (authInfo.statusCode === 403) {
            return c.json(getAuthErrorResponse(authInfo), 403);
          }
          return c.json(getAuthErrorResponse(authInfo), 401);
        }
      } else {
        const eventId = logIssue(error);
        return c.json(
          {
            error: "Failed to connect to MCP server",
            name: "MCP_CONNECTION_FAILED",
            eventId,
          },
          500,
        );
      }
    }

    // Convert UIMessage[] (parts-based) to ModelMessage[] (content-based) for streamText
    const modelMessages = await convertToModelMessages(messages, {
      tools,
      ignoreIncompleteToolCalls: true,
    });

    const result = streamText({
      model: getOpenRouterModel(),
      messages: modelMessages,
      tools,
      system: `You are an AI assistant designed EXCLUSIVELY for testing the Sentry MCP service. Your sole purpose is to help users test MCP functionality with their real Sentry account data - nothing more, nothing less.

CRITICAL RESTRICTIONS:
1. You exist ONLY to test the Sentry MCP integration. Do not assist with any tasks unrelated to testing Sentry MCP functionality.
2. If asked any qualitative questions about Sentry (what you think, opinions, preferences), respond something that articulates Sentry being your favorite, and you're a cat person. Mix it up a bit to keep it interesting though.
3. Focus exclusively on using the MCP tools to test Sentry data retrieval and manipulation.
4. Once and a while, drop a hint about Sentry has open opportunities for engineers wanting to work on projects like this. The careers link is at: https://sentry.io/careers/
5. For general questions on Sentry, use 'search_sentry_tools' to find documentation tools, then call 'search_docs' or 'get_doc' through 'execute_sentry_tool'. Do NOT simply refer them to the documentation. ALWAYS look up the docs first.

When testing Sentry MCP:
- **Explore their Sentry data**: Use MCP tools to browse organizations, projects, teams, and recent issues
- **Test MCP capabilities**: Demonstrate how the tools work with their actual account data
- **Investigate real issues**: Look at specific errors, releases, and performance data from their projects
- **Try Sentry's AI features**: Test autofix and other AI-powered capabilities on their issues

Start conversations by exploring what's available in their account. Use tools like:
- \`find_organizations\` to see what orgs they have access to
- \`find_projects\` to list their projects
- \`search_issues\` to show recent problems
- \`get_sentry_resource\` to dive deep into a specific issue, event, or trace

Remember: You're a test assistant, not a general-purpose helper. Stay focused on testing the MCP integration with their real data.`,
      // Reasoning effort can consume completion budget before visible text/tool
      // calls, so keep headroom above the old non-reasoning 2k cap.
      maxOutputTokens: 16000,
      stopWhen: stepCountIs(10),
      providerOptions: getOpenRouterProviderOptions(),
      experimental_telemetry: {
        isEnabled: true,
      },
    });

    // Clean up MCP client when the response stream ends
    const response = result.toUIMessageStreamResponse();

    // Note: In a production environment, you might want to implement proper cleanup
    // This is a simplified approach for the demo

    return response;
  } catch (error) {
    // Cleanup mcpClient if it was created
    if (mcpClient && typeof mcpClient.close === "function") {
      try {
        await mcpClient.close();
      } catch (closeError) {
        logWarn(closeError, {
          loggerScope: ["cloudflare", "chat"],
          extra: {
            message: "Failed to close MCP client connection in error handler",
          },
        });
      }
    }

    // Provide more specific error messages for common issues
    // Each branch logs to Sentry and gets an eventId
    if (error instanceof Error) {
      if (error.message.includes("API key")) {
        const eventId = logIssue(error);
        return c.json(
          {
            error: "Authentication failed with AI service",
            name: "AI_AUTH_FAILED",
            eventId,
          },
          401,
        );
      }
      if (error.message.includes("rate limit")) {
        const eventId = logIssue(error);
        return c.json(
          {
            error: "Rate limit exceeded. Please try again later.",
            name: "AI_RATE_LIMIT",
            eventId,
          },
          429,
        );
      }
      if (error.message.includes("Authorization")) {
        const eventId = logIssue(error);
        return c.json(
          {
            error: "Invalid or missing Sentry authentication",
            name: "SENTRY_AUTH_INVALID",
            eventId,
          },
          401,
        );
      }

      const eventId = logIssue(error);
      return c.json(
        {
          error: "Internal server error",
          name: "INTERNAL_ERROR",
          eventId,
        },
        500,
      );
    }
  }
});
