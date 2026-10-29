import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMcpServer } from "./index";

const started = vi.hoisted(() => ({ server: undefined as unknown }));

vi.mock("./transports/stdio", () => ({
  startStdio: vi.fn(async (server: unknown) => {
    started.server = server;
  }),
}));

/**
 * A host transport answering the two endpoints the tools below call: one a
 * plain `SentryApiService` request, the other an `@sentry/api` operation.
 */
function hostFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const { pathname } = new URL(
      input instanceof Request ? input.url : String(input),
    );
    if (pathname === "/api/0/auth/") {
      return Response.json({ id: "1", name: "Test", email: "t@example.com" });
    }
    if (pathname === "/api/0/organizations/") {
      return Response.json([]);
    }
    return Response.json({ detail: "Not found" }, { status: 404 });
  });
}

type ToolCall = { name: string; arguments: Record<string, unknown> };

async function callTools(server: McpServer, calls: ToolCall[]) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    for (const call of calls) {
      const result = await client.callTool(call);
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    }
  } finally {
    await client.close();
  }
}

describe("runMcpServer", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends every tool request through the host's fetch", async () => {
    const fetch = hostFetch();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("tool requests must use the host fetch");
    });

    await runMcpServer([], {
      environment: {},
      resolveAccessToken: async () => "host-token",
      fetch,
      throwOnError: true,
    });
    await callTools(started.server as McpServer, [
      {
        name: "execute_sentry_tool",
        arguments: { name: "whoami", arguments: {} },
      },
      { name: "find_organizations", arguments: {} },
    ]);

    const paths = fetch.mock.calls.map(
      ([input]) =>
        new URL(input instanceof Request ? input.url : String(input)).pathname,
    );
    expect(paths).toEqual(["/api/0/auth/", "/api/0/organizations/"]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
