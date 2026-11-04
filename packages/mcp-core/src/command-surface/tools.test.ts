import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { type CommandCatalogEntry, commandCatalog } from "../command-catalog";
import { buildServer } from "../server";
import { createTestContext } from "../test-utils/context";
import type { Constraints, ServerContext } from "../types";
import { toCommandArgs } from "./args";
import { type CommandSurfaceOptions, createCommandTools } from "./tools";
import type { CommandCall } from "./types";

vi.mock("@sentry/core/server", () => ({
  wrapMcpServerWithSentry: vi.fn((server) => server),
}));

/** Tools over the generated catalog, with a runner that records each call. */
function setup(
  options: Partial<CommandSurfaceOptions> = {},
  output: unknown = { data: [] },
) {
  const calls: CommandCall[] = [];
  const tools = createCommandTools({
    runtime: "stdio",
    run: async (call) => {
      calls.push(call);
      return output;
    },
    ...options,
  });
  // The registry's handlers are typed per tool; tests call them loosely.
  const call = async (
    command: string,
    params: Record<string, unknown> = {},
    context: ServerContext = createTestContext(),
  ): Promise<Record<string, unknown>> => {
    const tool = tools[toolName(command)];
    if (!tool) {
      throw new Error(`no tool for ${command}`);
    }
    return JSON.parse((await tool.handler(params as never, context)) as string);
  };
  return { tools, calls, call };
}

/** `issue list` → `sentry_issue_list`. */
function toolName(command: string): string {
  return `sentry ${command}`.replace(/[ -]/g, "_");
}

/** The catalog's exposed commands with JSON output, as tool names. */
function exposedToolNames(include: (entry: CommandCatalogEntry) => boolean) {
  return commandCatalog.commands
    .filter(
      (entry) =>
        entry.exposure === "exposed" &&
        entry.parameters.properties?.flags?.properties?.json &&
        include(entry),
    )
    .map((entry) => entry.path.replace(/[ -]/g, "_"))
    .sort();
}

function constrained(constraints: Constraints): ServerContext {
  return createTestContext({ constraints });
}

describe("command tools: listing", () => {
  it("lists one tool per exposed command", () => {
    expect(Object.keys(setup().tools).sort()).toEqual(
      exposedToolNames(() => true),
    );
  });

  it("lists only read tools and sentry api when read-only", () => {
    expect(Object.keys(setup({ readOnly: true }).tools).sort()).toEqual(
      exposedToolNames(
        (entry) => entry.permission === "read" || entry.permission === "method",
      ),
    );
  });

  it("names tools from the command path", () => {
    const { tools } = setup();
    expect(tools.sentry_issue_list).toBeDefined();
    expect(tools.sentry_agent_conversation_list).toBeDefined();
    // Hidden and stdio-only commands are not tools.
    expect(tools.sentry_auth_login).toBeUndefined();
    expect(tools.sentry_sourcemap_upload).toBeUndefined();
  });

  it("describes a command with its brief and usable examples", () => {
    const description = setup().tools.sentry_issue_view?.description ?? "";
    expect(description).toMatch(/^View details of/);
    expect(description).toContain("sentry issue view FRONT-ABC");
    // Examples that pipe output elsewhere are dropped.
    expect(description).not.toContain("| jq");
  });

  it("gives sentry api the hints of its session", () => {
    expect(setup().tools.sentry_api?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(
      setup({ readOnly: true }).tools.sentry_api?.annotations,
    ).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});

describe("command tools: permission classes", () => {
  it("marks read, write, and destructive commands", () => {
    const { tools } = setup();
    expect(
      [
        tools.sentry_issue_list,
        tools.sentry_issue_resolve,
        tools.sentry_project_delete,
      ].map((tool) => tool?.annotations),
    ).toEqual([
      { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    ]);
  });

  it("runs a read command", async () => {
    const { call, calls } = setup();
    await call("issue list", {
      positional: ["acme/web"],
      flags: { limit: 5, query: "is:unresolved" },
    });
    expect(calls).toEqual([
      {
        path: ["issue", "list"],
        positional: ["acme/web"],
        flags: { limit: 5, query: "is:unresolved" },
      },
    ]);
  });

  it("runs write and destructive commands", async () => {
    const { call, calls } = setup();
    await call("issue resolve", { positional: ["WEB-1"] });
    await call("project delete", {
      positional: ["acme/web"],
      flags: { yes: true },
    });
    expect(calls.map((c) => c.path.join(" "))).toEqual([
      "issue resolve",
      "project delete",
    ]);
  });

  it("runs sentry api with any method", async () => {
    const { call, calls } = setup();
    await call("api", { positional: ["organizations/"] });
    await call("api", {
      positional: ["projects/acme/web/"],
      flags: { method: "delete" },
    });
    expect(calls.map((c) => c.flags.method)).toEqual([undefined, "delete"]);
  });

  it("refuses sentry api writes when read-only", async () => {
    const { call, calls } = setup({ readOnly: true });
    await call("api", { positional: ["organizations/"] });
    await expect(
      call("api", {
        positional: ["organizations/acme/releases/"],
        flags: { method: "PUT" },
      }),
    ).rejects.toThrow(
      "this session is read-only, and this call is a write call",
    );
    expect(calls).toHaveLength(1);
  });
});

describe("command tools: arguments", () => {
  it("rejects invalid arguments with what to pass instead", async () => {
    const { call, calls } = setup();
    const error = await call("agent-conversation list", {
      flags: { limit: "ten", sort: "oldest", colour: "red" },
    }).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("flags.limit: expected number, got string");
    expect(message).toMatch(
      /flags\.sort: "oldest" is not allowed \(expected one of: /,
    );
    expect(message).toMatch(
      /flags\.colour: unknown \(expected one of: .*query/,
    );
    expect(calls).toEqual([]);
  });

  it("requires positionals the command needs", async () => {
    const { call } = setup();
    await expect(call("api")).rejects.toThrow("positional: required");
  });

  it("ignores json, which is always on", async () => {
    const { call, calls } = setup();
    await call("org list", { flags: { json: true } });
    expect(calls[0]?.flags).toEqual({});
  });

  it.each([
    ["issue view", "web", true, "it opens a browser"],
    ["log list", "follow", "5", "it streams output with no end"],
    ["dashboard view", "refresh", 10, "it streams output with no end"],
    [
      "api",
      "input",
      "body.json",
      "it reads or writes a path on the local machine",
    ],
  ])("refuses %s --%s", async (command, flag, value, reason) => {
    const { call } = setup();
    await expect(
      call(command, { positional: ["x"], flags: { [flag]: value } }),
    ).rejects.toThrow(
      `\`--${flag}\` is not available to agents, because ${reason}`,
    );
  });

  it("refuses stored-cursor keywords when hosted", async () => {
    const { call } = setup({ runtime: "hosted" });
    await expect(
      call("issue list", { flags: { cursor: "next" } }),
    ).rejects.toThrow("Pass the nextCursor value");
  });
});

describe("command tools: session constraints", () => {
  const org = constrained({ organizationSlug: "acme", projectSlug: null });
  const project = constrained({ organizationSlug: "acme", projectSlug: "web" });

  it("passes the session's target as the default", async () => {
    const { call, calls } = setup();
    await call("issue list", {}, project);
    expect(calls[0]).toMatchObject({
      org: "acme",
      project: "web",
      positional: [],
    });
  });

  it("pins a bare project to the session's organization", async () => {
    const { call, calls } = setup();
    await call("issue list", { positional: ["web"] }, org);
    await call("attribute list", { positional: ["web"] }, org);
    expect(calls.map((c) => c.positional)).toEqual([
      ["acme/web"],
      ["acme/web"],
    ]);
  });

  it("keeps ids that name no target", async () => {
    const { call, calls } = setup();
    await call("agent-conversation view", { positional: ["conv-1"] }, org);
    await call(
      "agent-conversation view",
      { positional: ["acme", "conv-1"] },
      org,
    );
    expect(calls.map((c) => c.positional)).toEqual([
      ["conv-1"],
      ["acme", "conv-1"],
    ]);
  });

  it.each([
    ["issue list", ["other/web"], org],
    ["issue list", ["acme/api"], project],
    ["org view", ["other"], org],
    ["issue view", ["other/WEB-1"], org],
    ["issue view", ["https://other.sentry.io/issues/1/"], org],
    ["release view", ["other/1.0.0"], org],
    ["attribute list", ["other/web"], org],
    ["attribute list", ["api"], project],
    ["explore", ["other/"], org],
    ["feedback view", ["other/WEB-1"], org],
    ["agent-conversation view", ["conv-1", "other/conv-2"], org],
    ["agent-conversation view", ["other", "conv-1"], org],
  ])(
    "refuses %s %j outside the session",
    async (command, positional, context) => {
      const { call, calls } = setup();
      await expect(call(command, { positional }, context)).rejects.toThrow(
        "outside this session's scope",
      );
      expect(calls).toEqual([]);
    },
  );

  it("refuses a --project flag for another project", async () => {
    const { call } = setup();
    await expect(
      call(
        "release create",
        { positional: ["acme/1.0.0"], flags: { project: "api" } },
        project,
      ),
    ).rejects.toThrow("outside this session's scope");
  });

  it("checks sentry api endpoints against the session", async () => {
    const { call, calls } = setup();
    await call(
      "api",
      { positional: ["/api/0/organizations/acme/issues/"] },
      org,
    );
    expect(calls).toHaveLength(1);
    await expect(
      call("api", { positional: ["projects/other/web/"] }, org),
    ).rejects.toThrow("outside this session's scope");
    await expect(
      call(
        "api",
        { positional: ["organizations/acme/projects/api/keys/"] },
        project,
      ),
    ).rejects.toThrow("outside this session's scope");
    await call(
      "api",
      { positional: ["organizations/acme/projects/web/keys/"] },
      project,
    );
    expect(calls).toHaveLength(2);
    await expect(
      call("api", { positional: ["issues/1/"] }, org),
    ).rejects.toThrow("not scoped to an organization");
  });
});

describe("command tools: results", () => {
  it("lifts nextCursor out of a list envelope", async () => {
    const { call } = setup(
      {},
      { data: [{ id: "1" }], hasMore: true, nextCursor: "0:25:0" },
    );
    expect(await call("issue list", {})).toEqual({
      command: "issue list",
      nextCursor: "0:25:0",
      result: { data: [{ id: "1" }], hasMore: true },
    });
  });

  it("returns several yields as one result", async () => {
    const { call } = setup({}, [{ a: 1 }, { b: 2 }]);
    expect(await call("org list", {})).toEqual({
      command: "org list",
      result: [{ a: 1 }, { b: 2 }],
    });
  });

  it("caps a large list at the items that fit", async () => {
    const data = Array.from({ length: 100 }, (_, id) => ({
      id,
      title: "x".repeat(100),
    }));
    const { tools } = setup(
      { maxResultChars: 2_000 },
      { data, hasMore: false },
    );
    const text = (await tools.sentry_issue_list?.handler(
      {} as never,
      createTestContext(),
    )) as string;
    const result = JSON.parse(text);

    expect(text.length).toBeLessThanOrEqual(2_000);
    expect(result.truncated).toMatchObject({ total: 100 });
    expect(result.result.data).toHaveLength(result.truncated.returned);
  });

  it("cuts a large single value to valid JSON within the cap", async () => {
    const { tools } = setup(
      { maxResultChars: 500 },
      { body: "x".repeat(2_000) },
    );
    const text = (await tools.sentry_org_list?.handler(
      {} as never,
      createTestContext(),
    )) as string;
    const parsed = JSON.parse(text);

    expect(text.length).toBeLessThanOrEqual(500);
    expect(parsed.truncated.characters).toBe(2_011);
    expect(parsed.result).toMatch(/^\{"body":"x+$/);
  });
});

describe("toCommandArgs", () => {
  it("passes flags joined, --json, and positionals after --", () => {
    expect(
      toCommandArgs({
        path: ["issue", "list"],
        positional: ["-acme/"],
        flags: {
          sort: "-date",
          limit: 5,
          fresh: true,
          field: ["a=1", "b=2"],
          query: "",
        },
      }),
    ).toEqual([
      "issue",
      "list",
      "--sort=-date",
      "--limit=5",
      "--fresh=true",
      "--field=a=1",
      "--field=b=2",
      "--query",
      "",
      "--json",
      "--",
      "-acme/",
    ]);
  });
});

describe("buildServer with the command tools", () => {
  async function listTools(options: Partial<CommandSurfaceOptions>) {
    const server = buildServer({
      context: createTestContext(),
      tools: setup(options).tools,
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "command-surface-test",
      version: "1.0.0",
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return (await client.listTools()).tools;
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("lists every command tool with the catalog's schema and hints", async () => {
    const tools = await listTools({});
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      exposedToolNames(() => true),
    );

    const issueList = tools.find((tool) => tool.name === "sentry_issue_list");
    if (!issueList) {
      throw new Error("sentry_issue_list is not listed");
    }
    expect(issueList.annotations).toMatchObject({ readOnlyHint: true });
    const flags = (
      issueList.inputSchema.properties as {
        flags: { properties: Record<string, { default?: unknown }> };
      }
    ).flags.properties;
    expect(flags.query).toBeDefined();
    expect(flags.limit?.default).toBe(25);
    expect(flags.json).toBeUndefined();

    const api = tools.find((tool) => tool.name === "sentry_api");
    expect(api?.annotations?.destructiveHint).toBe(true);
    expect(api?.inputSchema.required).toEqual(["positional"]);
  });

  it("lists no write tools when read-only", async () => {
    const names = (await listTools({ readOnly: true })).map(
      (tool) => tool.name,
    );
    expect(names.sort()).toEqual(
      exposedToolNames(
        (entry) => entry.permission === "read" || entry.permission === "method",
      ),
    );
  });
});
