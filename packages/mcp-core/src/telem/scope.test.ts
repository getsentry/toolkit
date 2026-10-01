import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  captureException,
  type ErrorEvent,
  getCurrentScope,
  getIsolationScope,
  type StreamedSpanJSON,
  setCurrentClient,
} from "@sentry/core";
import { ServerRuntimeClient } from "@sentry/core/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../server";
import { getServerContext } from "../test-setup";
import findProjects from "../tools/catalog/find-projects";
import type { ServerContext } from "../types";

const beforeSendSpan = vi.fn((span: StreamedSpanJSON) => span);
const beforeSend = vi.fn((event: ErrorEvent) => event);
let sentry: ServerRuntimeClient;

beforeEach(() => {
  vi.clearAllMocks();
  getIsolationScope().setAttribute("organization.slug", undefined);
  getIsolationScope().setTag("organization.slug", undefined);
  sentry = new ServerRuntimeClient({
    dsn: "https://public@example.com/1",
    integrations: [],
    stackParser: () => [],
    tracesSampleRate: 1,
    transport: () => ({
      send: async () => ({ statusCode: 200 }),
      flush: async () => true,
    }),
    beforeSendSpan,
    beforeSend,
  });
  setCurrentClient(sentry);
  sentry.init();
});

afterEach(async () => {
  await sentry.close();
  getCurrentScope().setClient(undefined);
  getIsolationScope().setAttribute("organization.slug", undefined);
  getIsolationScope().setTag("organization.slug", undefined);
});

async function callTool(
  context: ServerContext,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const server = buildServer({ context });
  const client = new Client({ name: "telemetry-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
  await sentry.flush();
}

describe("organization telemetry", () => {
  it.each([
    {
      description: "explicit organization arguments",
      name: "find_projects",
      args: { organizationSlug: "sentry-mcp-evals" },
      constraints: {},
    },
    {
      description: "session constraints",
      name: "find_projects",
      args: {},
      constraints: { organizationSlug: "sentry-mcp-evals" },
    },
    {
      description: "URL-derived organizations through catalog execution",
      name: "execute_sentry_tool",
      args: {
        name: "get_issue_breadcrumbs",
        arguments: {
          issueUrl:
            "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41/",
        },
      },
      constraints: {},
    },
  ])(
    "includes $description on streamed root spans",
    async ({ name, args, constraints }) => {
      await callTool(
        getServerContext({
          constraints,
          grantedSkills: new Set(["inspect"]),
        }),
        name,
        args,
      );
      expect(beforeSendSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          is_segment: true,
          attributes: expect.objectContaining({
            "organization.slug": "sentry-mcp-evals",
          }),
        }),
      );
    },
  );

  it("preserves organization tags on error events", async () => {
    await findProjects.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        query: null,
        cursor: null,
      },
      getServerContext(),
    );
    captureException(new Error("organization telemetry regression"));
    await sentry.flush();
    expect(beforeSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: expect.objectContaining({
          "organization.slug": "sentry-mcp-evals",
        }),
      }),
      expect.anything(),
    );
  });
});

describe("request and tool telemetry", () => {
  it("includes request and tool context on streamed root spans", async () => {
    await callTool(
      getServerContext({
        clientId: "telemetry-test-client",
        grantedSkills: new Set(["inspect"]),
      }),
      "execute_sentry_tool",
      {
        name: "get_issue_breadcrumbs",
        arguments: {
          issueUrl:
            "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41/",
        },
      },
    );
    expect(beforeSendSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        is_segment: true,
        attributes: expect.objectContaining({
          "client.id": "telemetry-test-client",
          "issue.id": "CLOUDFLARE-MCP-41",
        }),
      }),
    );
  });
});
