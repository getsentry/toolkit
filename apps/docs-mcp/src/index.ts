/**
 * Owns the docs Worker HTTP boundary. Health is public for readiness checks;
 * docs routes accept only service-bound or local-development requests.
 */
import { StreamableHTTPTransport } from "@hono/mcp";
import * as Sentry from "@sentry/cloudflare";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { isDocsMcpServiceRequest } from "./access";
import {
  executeInternalDocsRequest,
  internalDocsRequestSchema,
  isModelUnavailableError,
  isUngroundedDocsError,
} from "./internal-api";
import { createMcpServer } from "./mcp";
import { trackToolCall, trackToolDuration } from "./metrics";
import type { Env } from "./types";

export const app = new Hono<{ Bindings: Env }>().use(cors());

app.get("/health", (c) => c.json({ status: "ok" }));

app.all("/mcp", async (c) => {
  if (!isDocsMcpServiceRequest(c.req.raw)) {
    return c.json(
      { error: "Docs MCP is only available through its service binding" },
      403,
    );
  }

  const transport = new StreamableHTTPTransport();
  const mcp = createMcpServer(
    c.env.OPENROUTER_API_KEY,
    c.env.CF_VERSION_METADATA.id,
  );

  await mcp.connect(transport);

  return await transport.handleRequest(c);
});

app.post("/internal/docs", async (c) => {
  if (!isDocsMcpServiceRequest(c.req.raw)) {
    return c.json(
      { error: "Docs API is only available through its service binding" },
      403,
    );
  }

  const body = await c.req.json().catch(() => undefined);
  const parsed = internalDocsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid docs API request" }, 400);
  }

  const start = Date.now();
  const { operation } = parsed.data;
  Sentry.getActiveSpan()?.setAttribute("docs.operation", operation);

  try {
    const result = await executeInternalDocsRequest(
      c.env.OPENROUTER_API_KEY,
      parsed.data,
      c.env.CF_VERSION_METADATA.id,
    );
    trackToolCall(operation, true);
    trackToolDuration(operation, Date.now() - start);
    return c.json(result);
  } catch (error) {
    Sentry.getActiveSpan()?.setStatus({ code: 2, message: "error" });
    Sentry.captureException(error);
    trackToolCall(operation, false);
    trackToolDuration(operation, Date.now() - start);
    let errorCode: "DOCS_MODEL_UNAVAILABLE" | "DOCS_UNGROUNDED" | undefined;
    if (operation === "query-docs" && isUngroundedDocsError(error)) {
      errorCode = "DOCS_UNGROUNDED";
    } else if (operation === "query-docs" && isModelUnavailableError(error)) {
      errorCode = "DOCS_MODEL_UNAVAILABLE";
    }
    return c.json(
      {
        ...(errorCode ? { code: errorCode } : {}),
        error: "Docs API request failed",
      },
      500,
    );
  }
});

export default Sentry.withSentry(
  (_env: Env) => ({
    dsn: "https://05c618aef6e0489b8c9d07e0d65664ce@o1.ingest.us.sentry.io/4511189954199552",
    sendDefaultPii: true,
    tracesSampleRate: 1.0,
  }),
  app,
);
