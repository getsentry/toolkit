import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "./server";
import type { Skill } from "./skills";
import { getStructuredContent } from "./test-utils/structured-content";
import tools from "./tools/index";
import { EXPOSE_ALL_TOOLS } from "./tools/exposure";
import { DEPRECATED_TOOL_NAMES } from "./tools/surfaces";
import { isToolVisibleInMode } from "./tools/types";
import type { ServerContext } from "./types";

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
          !(DEPRECATED_TOOL_NAMES as readonly string[]).includes(tool.name) &&
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

  it("does not list deprecated tools next to their replacements", async () => {
    const toolNames = await listToolNames(getContext());

    for (const name of DEPRECATED_TOOL_NAMES) {
      expect(toolNames).not.toContain(name);
    }
    expect(toolNames).toContain("get_agent_conversation_details");
    expect(toolNames).toContain("search_agent_conversations");
    expect(toolNames).toContain("search_errors");
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
});
