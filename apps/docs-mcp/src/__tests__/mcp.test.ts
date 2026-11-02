import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test, vi } from "vitest";
import { app } from "../index";
import {
  MAX_MCP_REQUEST_BODY_BYTES,
  MAX_TOOL_INPUT_ELEMENTS,
  mcpPayloadTooLargeResponse,
} from "@sentry/toolkit-core/mcp-limits";

const TEST_ENV = {
  CF_VERSION_METADATA: { id: "test", tag: "test", timestamp: "test" },
};

async function connectClient(): Promise<Client> {
  const client = new Client({ name: "docs-mcp-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("https://docs-mcp.internal/mcp"),
    {
      fetch: async (input, init) =>
        await app.request(new Request(input, init), undefined, TEST_ENV),
    },
  );
  await client.connect(transport);
  return client;
}

function stubDocsUnavailable() {
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
}

describe("private MCP transport", () => {
  test("initializes and lists the docs tools through the service binding", async () => {
    const client = await connectClient();

    try {
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
    stubDocsUnavailable();
    const client = await connectClient();

    try {
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
  // Body and element limits themselves are tested in toolkit-core; these
  // check that this server applies them.
  test("rejects a tool call over the shared input element budget before the handler runs", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = await connectClient();

    try {
      const libs = Array.from(
        { length: MAX_TOOL_INPUT_ELEMENTS },
        (_, i) => `lib-${i}`,
      );
      const result = await client.callTool({
        arguments: { libs },
        name: "get-available-features",
      });

      expect(result).toEqual({
        content: [
          {
            text: `MCP error -32602: Invalid arguments for tool get-available-features: arguments contain more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`,
            type: "text",
          },
        ],
        isError: true,
      });
      // The handler warms the doctree cache first, so no fetch means it never ran.
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await client.close();
    }
  });

  test("rejects an oversized body before the MCP transport reads it", async () => {
    const response = await app.request(
      "https://docs-mcp.internal/mcp",
      {
        body: "a".repeat(MAX_MCP_REQUEST_BODY_BYTES + 1),
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        method: "POST",
      },
      TEST_ENV,
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual(
      await mcpPayloadTooLargeResponse().json(),
    );
  });
});
