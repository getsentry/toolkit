import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test, vi } from "vitest";
import { app } from "../index";
import {
  MAX_REQUEST_BODY_BYTES,
  MAX_TOOL_INPUT_ELEMENTS,
} from "../request-limits";
import { streamOf } from "./streams";

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

function mcpRequest(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request("https://docs-mcp.internal/mcp", {
    body,
    // Node requires `duplex` for streamed request bodies.
    duplex: "half",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  } as RequestInit);
}

const PAYLOAD_TOO_LARGE = {
  error: {
    code: -32000,
    message: `Payload Too Large: Request body must not exceed ${MAX_REQUEST_BODY_BYTES} bytes`,
  },
  id: null,
  jsonrpc: "2.0",
};

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
  test("runs a tool call at the input element budget", async () => {
    stubDocsUnavailable();
    const client = await connectClient();

    try {
      // `libs` is one key, so this is exactly MAX_TOOL_INPUT_ELEMENTS.
      const libs = Array.from(
        { length: MAX_TOOL_INPUT_ELEMENTS - 1 },
        (_, i) => `lib-${i}`,
      );
      const result = await client.callTool({
        arguments: { libs },
        name: "get-available-features",
      });

      // The handler ran and stopped at the missing API key, before any model call.
      expect(result).toEqual({
        content: [
          {
            text: JSON.stringify({
              error:
                "Failed to list features: Set OPENROUTER_API_KEY on the docs-mcp worker",
            }),
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

  test("rejects a tool call over the input element budget before the handler runs", async () => {
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

  test("accepts a request body at the size budget", async () => {
    stubDocsUnavailable();
    try {
      const request = {
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { query: "" }, name: "search-docs" },
      };
      const query = "a".repeat(
        MAX_REQUEST_BODY_BYTES - JSON.stringify(request).length,
      );
      const body = JSON.stringify({
        ...request,
        params: { ...request.params, arguments: { query } },
      });
      expect(new TextEncoder().encode(body).byteLength).toBe(
        MAX_REQUEST_BODY_BYTES,
      );

      const response = await app.request(mcpRequest(body), undefined, TEST_ENV);

      // The transport answers over SSE; the tool ran and hit the stubbed fetch.
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('"id":1');
      expect(text).toContain("Failed to search docs");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("rejects a declared oversized body before reading it", async () => {
    const response = await app.request(
      mcpRequest(streamOf(16), {
        "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
      }),
      undefined,
      TEST_ENV,
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual(PAYLOAD_TOO_LARGE);
  });

  test("rejects an oversized streamed body without Content-Length", async () => {
    const request = mcpRequest(streamOf(MAX_REQUEST_BODY_BYTES + 1));
    expect(request.headers.has("content-length")).toBe(false);

    const response = await app.request(request, undefined, TEST_ENV);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual(PAYLOAD_TOO_LARGE);
  });
});
