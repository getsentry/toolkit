/**
 * MCP Metadata API endpoint
 *
 * Provides immediate access to MCP server metadata including tools
 * without requiring a chat stream to be initialized.
 */
import { Hono } from "hono";
import { experimental_createMCPClient } from "@ai-sdk/mcp";
import type { Env } from "../types";
import { logIssue, logWarn } from "@sentry/mcp-core/telem/logging";
import { AuthDataSchema } from "../types/chat";
import { analyzeAuthError, getAuthErrorResponse } from "../utils/auth-errors";

type MCPClient = Awaited<ReturnType<typeof experimental_createMCPClient>>;

export default new Hono<{ Bindings: Env }>().get("/", async (c) => {
  // Support cookie-based auth (preferred) with fallback to Authorization header
  let accessToken: string | null = null;

  // Try to read from signed cookie set during OAuth
  try {
    const { getCookie } = await import("hono/cookie");
    const authDataCookie = getCookie(c, "sentry_auth_data");
    if (authDataCookie) {
      const authData = AuthDataSchema.parse(JSON.parse(authDataCookie));
      accessToken = authData.access_token;
    }
  } catch {
    // Ignore cookie parse errors; we'll check header below
  }

  // Fallback to Authorization header if cookie is not present
  if (!accessToken) {
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      accessToken = authHeader.substring(7);
    }
  }

  if (!accessToken) {
    return c.json(
      {
        error: "Authorization required",
        name: "MISSING_AUTH_TOKEN",
      },
      401,
    );
  }

  // Declare mcpClient in outer scope for cleanup in catch block
  let mcpClient: MCPClient | undefined;

  try {
    // Get tools by connecting to MCP server
    let tools: string[] = [];
    try {
      const requestUrl = new URL(c.req.url);
      const mcpUrl = `${requestUrl.protocol}//${requestUrl.host}/mcp`;

      mcpClient = await experimental_createMCPClient({
        name: "sentry",
        transport: {
          type: "http",
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      });

      const mcpTools = await mcpClient.tools();
      tools = Object.keys(mcpTools);
    } catch (error) {
      // If we can't get tools, return empty array
      logWarn(error, {
        loggerScope: ["cloudflare", "metadata"],
        extra: {
          message: "Failed to fetch tools from MCP server",
        },
      });
    } finally {
      // Ensure the MCP client connection is properly closed to prevent hanging connections
      if (mcpClient && typeof mcpClient.close === "function") {
        try {
          await mcpClient.close();
        } catch (closeError) {
          logWarn(closeError, {
            loggerScope: ["cloudflare", "metadata"],
            extra: {
              message: "Failed to close MCP client connection",
            },
          });
        }
      }
    }

    // Return the metadata
    return c.json({
      type: "mcp-metadata",
      tools,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    // Cleanup mcpClient if it was created
    if (mcpClient && typeof mcpClient.close === "function") {
      try {
        await mcpClient.close();
      } catch (closeError) {
        logWarn(closeError, {
          loggerScope: ["cloudflare", "metadata"],
          extra: {
            message: "Failed to close MCP client connection in error handler",
          },
        });
      }
    }

    logIssue(error, {
      loggerScope: ["cloudflare", "metadata"],
      extra: {
        message: "Metadata API error",
      },
    });

    // Check if this is an authentication error
    const authInfo = analyzeAuthError(error);
    if (authInfo.isAuthError) {
      return c.json(
        getAuthErrorResponse(authInfo),
        authInfo.statusCode || (401 as any),
      );
    }

    const eventId = logIssue(error);
    return c.json(
      {
        error: "Failed to fetch MCP metadata",
        name: "METADATA_FETCH_FAILED",
        eventId,
      },
      500,
    );
  }
});
