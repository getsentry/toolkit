import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./server";
import { buildServerInstructions } from "./server-instructions";
import type { ToolConfig } from "./tools/types";
import type { ServerContext } from "./types";
import { LIB_VERSION, setServerVersion } from "./version";

const context: ServerContext = {
  accessToken: "test-token",
  sentryHost: "sentry.io",
  grantedSkills: new Set(["inspect"]),
  constraints: { organizationSlug: null, projectSlug: null },
};

const tools: Record<string, ToolConfig> = {
  static_tool: {
    name: "static_tool",
    title: "Static Tool",
    description: "A tool fixed for the lifetime of the server",
    inputSchema: {},
    skills: ["inspect"],
    requiredScopes: [],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    handler: async () => "ok",
  },
};

function modernRequest(method: string, params: Record<string, unknown> = {}) {
  return new Request("https://mcp.example.test/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

describe("static tool catalog capabilities", () => {
  it("keeps legacy tools callable without promising list-change notifications", async () => {
    const server = buildServer({ context, tools });
    const client = new Client({ name: "capability-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      expect(client.getServerCapabilities()?.tools).toEqual({
        listChanged: false,
      });
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        ["static_tool"],
      );
      expect(
        await client.callTool({ name: "static_tool", arguments: {} }),
      ).toMatchObject({
        content: [{ type: "text", text: "ok" }],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns server instructions from server/discover", async () => {
    const handler = createMcpHandler(() => buildServer({ context, tools }), {
      keepAliveMs: 0,
    });
    try {
      const discovery = await handler.fetch(modernRequest("server/discover"));
      expect(discovery.status).toBe(200);
      expect(await discovery.json()).toMatchObject({
        result: {
          instructions: buildServerInstructions(new Set(["static_tool"])),
        },
      });
    } finally {
      await handler.close();
    }
  });

  it("does not advertise or acknowledge modern tool-list subscriptions", async () => {
    const handler = createMcpHandler(() => buildServer({ context, tools }), {
      keepAliveMs: 0,
    });
    try {
      const discovery = await handler.fetch(modernRequest("server/discover"));
      expect(discovery.status).toBe(200);
      expect(await discovery.json()).toMatchObject({
        result: { capabilities: { tools: { listChanged: false } } },
      });

      const list = await handler.fetch(modernRequest("tools/list"));
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({
        result: { tools: [{ name: "static_tool" }] },
      });

      const subscription = await handler.fetch(
        modernRequest("subscriptions/listen", {
          notifications: { toolsListChanged: true },
        }),
      );
      expect(subscription.status).toBe(200);
      const reader = subscription.body!.getReader();
      try {
        let frame = "";
        const decoder = new TextDecoder();
        while (!frame.includes("\n\n")) {
          const { done, value } = await reader.read();
          if (done) break;
          frame += decoder.decode(value, { stream: true });
        }
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));
        const acknowledgement = JSON.parse(data!.slice(6));
        expect(acknowledgement.method).toBe(
          "notifications/subscriptions/acknowledged",
        );
        expect(acknowledgement.params.notifications).toEqual({});
      } finally {
        await reader.cancel();
      }
    } finally {
      await handler.close();
    }
  });
});

describe("serverInfo version", () => {
  async function initializeVersion(serverContext: ServerContext) {
    const server = buildServer({ context: serverContext, tools });
    const client = new Client({ name: "version-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return client.getServerVersion()?.version;
    } finally {
      await client.close();
      await server.close();
    }
  }

  afterEach(() => {
    setServerVersion(undefined);
  });

  it("reports the host's version when it sets one", async () => {
    setServerVersion("0.48.0-test");
    expect(await initializeVersion(context)).toBe("0.48.0-test");
  });

  it("falls back to mcp-core's version", async () => {
    expect(await initializeVersion(context)).toBe(LIB_VERSION);
  });
});
