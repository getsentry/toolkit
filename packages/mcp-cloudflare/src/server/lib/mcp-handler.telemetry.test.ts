import type { ExecutionContext } from "@cloudflare/workers-types";
import * as Sentry from "@sentry/cloudflare";
import { describe, expect, it } from "vitest";
import type { Env } from "../types";
import mcpHandler from "./mcp-handler";

describe("MCP request attribution", () => {
  it("attributes discovery spans without leaking client identity between requests", async () => {
    const spans: Array<{ attributes: Record<string, unknown> }> = [];
    const worker = Sentry.withSentry(
      () => ({
        dsn: "https://public@example.ingest.sentry.io/1",
        tracesSampleRate: 1,
        cacheClient: false,
        defaultIntegrations: false,
        transport: () => ({
          send: async () => ({ statusCode: 200 }),
          flush: async () => true,
        }),
        beforeSendSpan(span) {
          spans.push(span);
          return span;
        },
      }),
      mcpHandler,
    );

    for (const { method, userAgent, clientName, modern } of [
      {
        method: "resources/list",
        userAgent: "codex-mcp-client/1.0.0",
        clientName: "Registered client",
        modern: false,
      },
      {
        method: "tools/list",
        userAgent: "claude-code/1.0.0",
        clientName: undefined,
        modern: false,
      },
      {
        method: "server/discover",
        userAgent: "codex-mcp-client/1.0.0",
        clientName: "Registered discovery client",
        modern: true,
      },
    ]) {
      const pending: Promise<unknown>[] = [];
      const ctx = {
        waitUntil(promise: Promise<unknown>) {
          pending.push(promise);
        },
        passThroughOnException() {},
        props: {
          id: "test-user",
          clientId: "test-client",
          clientName,
          accessToken: "test-access-token",
          refreshToken: "test-refresh-token",
          grantedSkills: ["inspect"],
        },
      } as ExecutionContext;
      const response = await worker.fetch!(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "User-Agent": userAgent,
            Host: "localhost",
            ...(modern
              ? {
                  "MCP-Protocol-Version": "2026-07-28",
                  "Mcp-Method": method,
                }
              : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            ...(modern
              ? {
                  params: {
                    _meta: {
                      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                      "io.modelcontextprotocol/clientCapabilities": {},
                      "io.modelcontextprotocol/clientInfo": {
                        name: "Protocol client",
                        version: "1.0.0",
                      },
                    },
                  },
                }
              : {}),
          }),
        }),
        { SENTRY_HOST: "sentry.io" } as Env,
        ctx,
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      const message = JSON.parse(
        response.headers.get("content-type")?.includes("text/event-stream")
          ? (
              body.split("\n").find((line) => line.startsWith("data: ")) ?? ""
            ).slice(6)
          : body,
      );
      if (method === "resources/list") {
        expect(message).toMatchObject({ error: { code: -32601 } });
      } else if (method === "server/discover") {
        expect(message.result).toMatchObject({ resultType: "complete" });
        expect(message.result.capabilities).not.toHaveProperty("resources");
      }
      await Promise.all(pending);
    }

    const resourceSpan = spans.find(
      (span) => span.attributes["mcp.method.name"] === "resources/list",
    );
    const toolsSpan = spans.find(
      (span) => span.attributes["mcp.method.name"] === "tools/list",
    );
    expect(resourceSpan?.attributes).toMatchObject({
      "app.client.family": "codex",
      "app.client.name": "Registered client",
      "app.transport": "http",
    });
    expect(toolsSpan?.attributes).toMatchObject({
      "app.client.family": "claude-code",
      "app.transport": "http",
    });
    expect(toolsSpan?.attributes).not.toHaveProperty("app.client.name");
    expect(resourceSpan?.attributes).not.toHaveProperty("mcp.client.name");
    const discoverSpan = spans.find(
      (span) => span.attributes["mcp.method.name"] === "server/discover",
    );
    expect(discoverSpan?.attributes).toMatchObject({
      "app.client.family": "codex",
      "app.client.name": "Registered discovery client",
      "app.transport": "http",
      "mcp.client.name": "Protocol client",
    });
  });
});
