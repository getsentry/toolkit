import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test, vi } from "vitest";
import { app } from "../index";

describe("private MCP transport", () => {
  test("initializes and lists the docs tools through the service binding", async () => {
    const client = new Client({ name: "docs-mcp-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL("https://docs-mcp.internal/mcp"),
      {
        fetch: async (input, init) =>
          await app.request(new Request(input, init), undefined, {
            CF_VERSION_METADATA: { id: "test", tag: "test", timestamp: "test" },
          }),
      },
    );

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "get-available-features",
        "get-docs",
        "query-docs",
        "search-docs",
      ]);
      expect(tools.every((tool) => tool.inputSchema.type === "object")).toBe(
        true,
      );
    } finally {
      await client.close();
    }
  });

  test.each([
    {
      args: { libs: ["nextjs"] },
      error:
        "Failed to list features: Set OPENROUTER_API_KEY on the docs-mcp worker",
      name: "get-available-features",
    },
    {
      args: { query: "tracing" },
      error:
        "Failed to search docs: Failed to fetch https://docs.sentry.io/doctree.json: 503 Service Unavailable",
      name: "search-docs",
    },
  ])("marks $name failures as MCP errors", async ({ args, error, name }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("Unavailable", {
            status: 503,
            statusText: "Service Unavailable",
          }),
      ),
    );

    const client = new Client({ name: "docs-mcp-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL("https://docs-mcp.internal/mcp"),
      {
        fetch: async (input, init) =>
          await app.request(new Request(input, init), undefined, {
            CF_VERSION_METADATA: { id: "test", tag: "test", timestamp: "test" },
          }),
      },
    );

    try {
      await client.connect(transport);
      const result = await client.callTool({ arguments: args, name });

      expect(result).toEqual({
        content: [
          {
            text: JSON.stringify({ error }),
            type: "text",
          },
        ],
        isError: true,
      });
    } finally {
      vi.unstubAllGlobals();
      await client.close();
    }
  });

  test("rejects MCP requests outside the service binding", async () => {
    const response = await app.request(
      "https://docs-mcp.getsentry.workers.dev/mcp",
      {
        method: "POST",
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Docs MCP is only available through its service binding",
    });
  });
});
