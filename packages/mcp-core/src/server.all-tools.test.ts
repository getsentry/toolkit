import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type Span, getActiveSpan } from "@sentry/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./server";
import type { Skill } from "./skills";
import { getStructuredContent } from "./test-utils/structured-content";
import tools from "./tools/index";
import { EXPOSE_ALL_TOOLS } from "./tools/exposure";
import { isToolVisibleInMode } from "./tools/types";
import type { ServerContext } from "./types";

vi.mock("@sentry/core/server", () => ({
  wrapMcpServerWithSentry: vi.fn((server) => server),
}));

vi.mock("@sentry/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/core")>()),
  getActiveSpan: vi.fn(),
}));

const ALL_SKILLS = new Set<Skill>([
  "inspect",
  "triage",
  "project-management",
  "seer",
]);

function getContext(overrides: Partial<ServerContext> = {}): ServerContext {
  return {
    accessToken: "test-token",
    grantedSkills: ALL_SKILLS,
    constraints: { organizationSlug: null, projectSlug: null },
    sentryHost: "sentry.io",
    ...overrides,
  };
}

async function withClient<T>(
  context: ServerContext,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const server = buildServer({ context });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "all-tools-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function listToolNames(context: ServerContext): Promise<string[]> {
  return await withClient(context, async (client) =>
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
  );
}

// server.test.ts covers the gateway surface used when the flag is off.
describe.skipIf(!EXPOSE_ALL_TOOLS)("buildServer with EXPOSE_ALL_TOOLS", () => {
  it("lists every skill-granted tool and drops the catalog gateway", async () => {
    const toolNames = await listToolNames(getContext());

    const expected = Object.values(tools)
      .filter(
        (tool) =>
          isToolVisibleInMode(tool, false) &&
          tool.skills.some((skill) => ALL_SKILLS.has(skill)) &&
          tool.name !== "search_sentry_tools" &&
          tool.name !== "execute_sentry_tool" &&
          !tool.deprecated &&
          // Hidden without a telemetry DSN, which tests do not configure.
          tool.name !== "submit_feedback_to_sentry_team",
      )
      .map((tool) => tool.name)
      .sort();

    expect(toolNames).toEqual(expected);
    expect(toolNames).toContain("whoami");
    expect(toolNames).toContain("get_issue_details");
    expect(toolNames).toContain("create_project");
  });

  it("lists the replacements of deprecated tools instead of the tools", async () => {
    const toolNames = await listToolNames(getContext());
    const deprecatedTools = Object.values(tools).filter(
      (tool) => tool.deprecated,
    );

    expect(deprecatedTools.map((tool) => tool.name).sort()).toEqual([
      "get_ai_conversation_details",
      "search_ai_conversations",
      "search_events",
    ]);
    for (const tool of deprecatedTools) {
      expect(toolNames).not.toContain(tool.name);
      for (const replacement of tool.deprecated?.replacedBy ?? []) {
        expect(toolNames).toContain(replacement);
      }
    }
  });

  it("still gates tools by granted skills", async () => {
    const toolNames = await listToolNames(
      getContext({ grantedSkills: new Set<Skill>(["inspect"]) }),
    );

    expect(toolNames).toContain("get_issue_details");
    expect(toolNames).not.toContain("create_project");
    expect(toolNames).not.toContain("update_issue");
    expect(toolNames).not.toContain("search_sentry_tools");
    expect(toolNames).not.toContain("execute_sentry_tool");
  });

  it("calls a formerly catalog-only tool directly", async () => {
    const result = await withClient(
      getContext({ grantedSkills: new Set<Skill>(["inspect"]) }),
      (client) => client.callTool({ name: "whoami", arguments: {} }),
    );

    expect(result.isError).toBeFalsy();
    expect(getStructuredContent<{ user: { id: string } }>(result).user.id).toBe(
      "123456",
    );
  });

  describe("calls to unregistered tools", () => {
    // Sentry's MCP instrumentation leaves the span status unset for -32602
    // errors, so these calls used to be recorded as successful spans.
    afterEach(() => {
      vi.mocked(getActiveSpan).mockReset();
    });

    function mockActiveSpan() {
      const span = { setAttributes: vi.fn(), setStatus: vi.fn() };
      vi.mocked(getActiveSpan).mockReturnValue(span as unknown as Span);
      return span;
    }

    it("tells clients that the gateway tools were removed and marks the span failed", async () => {
      const span = mockActiveSpan();

      const error = await withClient(
        getContext({ transport: "http" }),
        (client) =>
          client.callTool({
            name: "execute_sentry_tool",
            arguments: { name: "whoami", arguments: {} },
          }),
      ).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: -32602,
        message:
          "MCP error -32602: Tool execute_sentry_tool was removed from the Sentry MCP server. Call Sentry tools directly by name. If they are missing from your tool list, reconnect the Sentry MCP server to refresh it.",
      });
      expect(span.setStatus).toHaveBeenCalledWith({
        code: 2,
        message: "not_found",
      });
      expect(span.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({
          "error.type": "unknown_tool",
          "app.transport": "http",
        }),
      );
    });

    it("keeps the SDK's not-found error for other unknown tools", async () => {
      const span = mockActiveSpan();

      const error = await withClient(getContext(), (client) =>
        client.callTool({ name: "not_a_sentry_tool", arguments: {} }),
      ).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: -32602,
        message: "MCP error -32602: Tool not_a_sentry_tool not found",
      });
      expect(span.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({ "error.type": "unknown_tool" }),
      );
    });

    it("does not mark registered tools", async () => {
      const span = mockActiveSpan();

      await withClient(getContext(), (client) =>
        client.callTool({ name: "whoami", arguments: {} }),
      );

      expect(span.setAttributes).not.toHaveBeenCalledWith(
        expect.objectContaining({ "error.type": "unknown_tool" }),
      );
      expect(span.setStatus).not.toHaveBeenCalledWith(
        expect.objectContaining({ code: 2 }),
      );
    });
  });
});
