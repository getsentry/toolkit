import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "./server";
import { MAX_SERVER_INSTRUCTIONS_LENGTH } from "./server-instructions";
import type { Skill } from "./skills";
import { getStructuredContent } from "./test-utils/structured-content";
import tools from "./tools/index";
import { EXPOSE_ALL_TOOLS } from "./tools/exposure";
import { isToolVisibleInMode } from "./tools/types";
import type { ServerContext } from "./types";
import { LIB_VERSION } from "./version";

vi.mock("@sentry/core/server", () => ({
  wrapMcpServerWithSentry: vi.fn((server) => server),
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
  experimentalMode = false,
): Promise<T> {
  const server = buildServer({ context, experimentalMode });
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

/**
 * Paths of `type: "array"` nodes whose `items` is not a schema object.
 *
 * VS Code Copilot rejects a tool at registration when any array lacks a
 * truthy `items`, and GPT models need an item type. `z.tuple` emits
 * `prefixItems` with `items: false`, which trips this.
 */
function findArraysWithoutItemSchema(
  schema: unknown,
  path: string[] = [],
): string[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) =>
      findArraysWithoutItemSchema(item, [...path, String(index)]),
    );
  }

  const record = schema as Record<string, unknown>;
  const types = Array.isArray(record.type) ? record.type : [record.type];
  const items = record.items;
  const violations =
    types.includes("array") &&
    (!items || typeof items !== "object" || Array.isArray(items))
      ? [path.join(".") || "(root)"]
      : [];

  return [
    ...violations,
    ...Object.entries(record).flatMap(([key, value]) =>
      findArraysWithoutItemSchema(value, [...path, key]),
    ),
  ];
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

  it("exports each tool's title in tools/list", async () => {
    const listed = await withClient(
      getContext(),
      async (client) => (await client.listTools()).tools,
    );
    const titles = new Map(
      Object.values(tools).map((tool) => [tool.name, tool.title]),
    );

    expect(listed.length).toBeGreaterThan(0);
    for (const tool of listed) {
      expect(tool.title, tool.name).toBe(titles.get(tool.name));
      expect(tool.title?.trim(), tool.name).toBeTruthy();
    }
  });

  it.each([false, true])(
    "gives every array in tools/list an item schema (experimentalMode=%s)",
    async (experimentalMode) => {
      const listed = await withClient(
        getContext(),
        async (client) => (await client.listTools()).tools,
        experimentalMode,
      );

      expect(listed.length).toBeGreaterThan(0);
      const violations = listed.flatMap((tool) =>
        findArraysWithoutItemSchema(tool.inputSchema).map(
          (path) => `${tool.name}: ${path}`,
        ),
      );
      expect(violations).toEqual([]);
    },
  );

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

  it("returns server instructions that fit the harness cap", async () => {
    const instructions = await withClient(getContext(), async (client) =>
      client.getInstructions(),
    );

    expect(instructions?.length).toBeLessThanOrEqual(
      MAX_SERVER_INSTRUCTIONS_LENGTH,
    );
    expect(instructions).toMatchInlineSnapshot(`
      "Use Sentry tools for questions about the user's production apps or Sentry account: errors, crashes, issues, stack traces, traces, spans, slow requests, logs, metrics, replays, profiles, releases, monitors, alert rules, and Sentry SDK setup and docs.
      - For a Sentry URL or an issue, event, trace, or replay ID, call get_sentry_resource first.
      - Do not look up the organization first; tools default to it when the user has one. If a tool asks for organizationSlug, call find_organizations and pass the slug and regionUrl it returns.
      - search_issues finds grouped problems ("what's broken", "top issues"); search_errors, search_logs, search_traces, search_metrics, search_profiles, search_replays find individual events, counts, and aggregates."
    `);
  });

  it("identifies the server for client UIs", async () => {
    const serverInfo = await withClient(getContext(), async (client) =>
      client.getServerVersion(),
    );

    expect(serverInfo).toEqual({
      name: "Sentry MCP",
      title: "Sentry",
      description:
        "Search and debug Sentry issues, errors, traces, logs, replays, and monitors.",
      websiteUrl: "https://mcp.sentry.dev",
      icons: [
        {
          src: "https://mcp.sentry.dev/sentry-icon.png",
          mimeType: "image/png",
          sizes: ["256x256"],
        },
      ],
      version: LIB_VERSION,
    });
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

  it("tells clients that the gateway tools were removed", async () => {
    const error = await withClient(getContext(), (client) =>
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
  });
});

// telem/unknown-tool.test.ts covers the span these calls produce.
it("keeps the SDK's not-found error for other unknown tools", async () => {
  const error = await withClient(getContext(), (client) =>
    client.callTool({ name: "not_a_sentry_tool", arguments: {} }),
  ).catch((caught: unknown) => caught);

  expect(error).toMatchObject({
    code: -32602,
    message: "MCP error -32602: Tool not_a_sentry_tool not found",
  });
});
