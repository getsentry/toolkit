import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
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
    name: string,
    params: Record<string, unknown>,
    context: ServerContext = createTestContext(),
  ): Promise<Record<string, unknown>> => {
    const tool = tools[name];
    if (!tool) {
      throw new Error(`no tool ${name}`);
    }
    return JSON.parse((await tool.handler(params as never, context)) as string);
  };
  return { tools, calls, call };
}

function constrained(constraints: Constraints): ServerContext {
  return createTestContext({ constraints });
}

describe("search_sentry", () => {
  it("ranks commands by the query", async () => {
    const { call } = setup();
    const { commands } = (await call("search_sentry", {
      query: "list issues",
    })) as { commands: { command: string; tool: string }[] };

    expect(commands[0]).toMatchObject({
      command: "issue list",
      permission: "read",
      tool: "execute_sentry_read",
    });
  });

  it("returns a command's schema without the flags agents cannot pass", async () => {
    const { call } = setup();
    const result = await call("search_sentry", {
      command: "sentry issue view",
    });
    const flags = (
      result.params as { properties: { flags: { properties: object } } }
    ).properties.flags.properties;

    expect(result).toMatchObject({
      command: "issue view",
      tool: "execute_sentry_read",
    });
    expect(Object.keys(flags)).toContain("fields");
    expect(Object.keys(flags)).not.toContain("json");
    expect(Object.keys(flags)).not.toContain("web");
    expect(result.examples).toEqual(expect.any(Array));
  });

  it("explains how sentry api picks its execute tool", async () => {
    const { call } = setup();
    expect(await call("search_sentry", { command: "api" })).toMatchObject({
      permission: "method",
      tool: expect.stringContaining("execute_sentry_write otherwise"),
    });
  });

  it("marks commands this session cannot run", async () => {
    const { call } = setup({ runtime: "hosted", readOnly: true });
    expect(
      await call("search_sentry", { command: "sourcemap upload" }),
    ).toMatchObject({
      unavailable: expect.stringContaining("stdio server"),
    });
    expect(
      await call("search_sentry", { command: "issue resolve" }),
    ).toMatchObject({
      unavailable: "this session is read-only",
    });
  });

  it("refuses a hidden command", async () => {
    const { call } = setup();
    await expect(
      call("search_sentry", { command: "auth login" }),
    ).rejects.toThrow('No command "auth login" is available to agents');
  });

  it("offers the complete mode only with a completer", async () => {
    expect(setup().tools.search_sentry?.inputSchema).not.toHaveProperty(
      "complete",
    );

    const complete = vi.fn(async () => [{ value: "acme/" }]);
    const { tools, call } = setup({ complete });
    expect(tools.search_sentry?.inputSchema).toHaveProperty("complete");
    expect(
      await call("search_sentry", {
        command: "issue list",
        complete: { parameter: "positional[0]", value: "ac" },
      }),
    ).toEqual({ command: "issue list", candidates: [{ value: "acme/" }] });
    expect(complete).toHaveBeenCalledWith(
      { command: "issue list", parameter: "positional[0]", value: "ac" },
      expect.anything(),
    );
  });
});

describe("execute tools: permission classes", () => {
  it("runs a read command with the read tool", async () => {
    const { call, calls } = setup();
    await call("execute_sentry_read", {
      command: "issue list",
      params: {
        positional: ["acme/web"],
        flags: { limit: 5, query: "is:unresolved" },
      },
    });
    expect(calls).toEqual([
      {
        path: ["issue", "list"],
        positional: ["acme/web"],
        flags: { limit: 5, query: "is:unresolved" },
      },
    ]);
  });

  it("refuses a write command in the read tool", async () => {
    const { call, calls } = setup();
    await expect(
      call("execute_sentry_read", {
        command: "issue resolve",
        params: { positional: ["WEB-1"] },
      }),
    ).rejects.toThrow("run it with execute_sentry_write");
    expect(calls).toEqual([]);
  });

  it("runs write and destructive commands with the write tool", async () => {
    const { call, calls } = setup();
    await call("execute_sentry_write", {
      command: "issue resolve",
      params: { positional: ["WEB-1"] },
    });
    await call("execute_sentry_write", {
      command: "project delete",
      params: { positional: ["acme/web"], flags: { yes: true } },
    });
    expect(calls.map((c) => c.path.join(" "))).toEqual([
      "issue resolve",
      "project delete",
    ]);
  });

  it("refuses a read command in the write tool", async () => {
    const { call } = setup();
    await expect(
      call("execute_sentry_write", { command: "org list" }),
    ).rejects.toThrow("run it with execute_sentry_read");
  });

  it("gives sentry api the class of its method", async () => {
    const { call, calls } = setup();
    await call("execute_sentry_read", {
      command: "api",
      params: { positional: ["organizations/"] },
    });
    await expect(
      call("execute_sentry_read", {
        command: "api",
        params: {
          positional: ["organizations/acme/releases/"],
          flags: { method: "POST" },
        },
      }),
    ).rejects.toThrow("is a write call here; run it with execute_sentry_write");
    await call("execute_sentry_write", {
      command: "api",
      params: {
        positional: ["projects/acme/web/"],
        flags: { method: "delete" },
      },
    });
    expect(calls.map((c) => c.flags.method)).toEqual([undefined, "delete"]);
  });

  it("lists no write tool on a read-only connection and refuses writes", async () => {
    const { tools, call } = setup({ readOnly: true });
    expect(Object.keys(tools).sort()).toEqual([
      "execute_sentry_read",
      "search_sentry",
    ]);
    await expect(
      call("execute_sentry_read", {
        command: "api",
        params: {
          positional: ["organizations/acme/releases/"],
          flags: { method: "PUT" },
        },
      }),
    ).rejects.toThrow("this session is read-only");
  });
});

describe("execute tools: params", () => {
  it("rejects invalid params with what to pass instead", async () => {
    const { call, calls } = setup();
    const error = await call("execute_sentry_read", {
      command: "agent-conversation list",
      params: { flags: { limit: "ten", sort: "oldest", colour: "red" } },
    }).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(
      "params.flags.limit: expected number, got string",
    );
    expect(message).toMatch(
      /params\.flags\.sort: "oldest" is not allowed \(expected one of: /,
    );
    expect(message).toMatch(
      /params\.flags\.colour: unknown \(expected one of: .*query/,
    );
    expect(calls).toEqual([]);
  });

  it("requires positionals the command needs", async () => {
    const { call } = setup();
    await expect(
      call("execute_sentry_read", { command: "api" }),
    ).rejects.toThrow("params.positional: required");
  });

  it("ignores json, which is always on", async () => {
    const { call, calls } = setup();
    await call("execute_sentry_read", {
      command: "org list",
      params: { flags: { json: true } },
    });
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
      call("execute_sentry_read", {
        command,
        params: { positional: ["x"], flags: { [flag]: value } },
      }),
    ).rejects.toThrow(
      `\`--${flag}\` is not available to agents, because ${reason}`,
    );
  });

  it("refuses stdio-only commands when hosted, and runs them on stdio", async () => {
    const hosted = setup({ runtime: "hosted" });
    await expect(
      hosted.call("execute_sentry_write", {
        command: "sourcemap upload",
        params: { positional: ["dist"] },
      }),
    ).rejects.toThrow("runs only on the stdio server");

    const stdio = setup();
    await stdio.call("execute_sentry_write", {
      command: "sourcemap upload",
      params: { positional: ["dist"] },
    });
    expect(stdio.calls).toHaveLength(1);
  });

  it("refuses stored-cursor keywords when hosted", async () => {
    const { call } = setup({ runtime: "hosted" });
    await expect(
      call("execute_sentry_read", {
        command: "issue list",
        params: { flags: { cursor: "next" } },
      }),
    ).rejects.toThrow("Pass the nextCursor value");
  });
});

describe("execute tools: session constraints", () => {
  const org = constrained({ organizationSlug: "acme", projectSlug: null });
  const project = constrained({ organizationSlug: "acme", projectSlug: "web" });

  it("passes the session's target as the default", async () => {
    const { call, calls } = setup();
    await call("execute_sentry_read", { command: "issue list" }, project);
    expect(calls[0]).toMatchObject({
      org: "acme",
      project: "web",
      positional: [],
    });
  });

  it("pins a bare project to the session's organization", async () => {
    const { call, calls } = setup();
    await call(
      "execute_sentry_read",
      { command: "issue list", params: { positional: ["web"] } },
      org,
    );
    expect(calls[0]?.positional).toEqual(["acme/web"]);
  });

  it.each([
    ["issue list", ["other/web"], org],
    ["issue list", ["acme/api"], project],
    ["org view", ["other"], org],
    ["issue view", ["other/WEB-1"], org],
    ["issue view", ["https://other.sentry.io/issues/1/"], org],
    ["release view", ["other/1.0.0"], org],
  ])(
    "refuses %s %j outside the session",
    async (command, positional, context) => {
      const { call, calls } = setup();
      await expect(
        call(
          "execute_sentry_read",
          { command, params: { positional } },
          context,
        ),
      ).rejects.toThrow("outside this session's scope");
      expect(calls).toEqual([]);
    },
  );

  it("refuses a --project flag for another project", async () => {
    const { call } = setup();
    await expect(
      call(
        "execute_sentry_write",
        {
          command: "release create",
          params: { positional: ["acme/1.0.0"], flags: { project: "api" } },
        },
        project,
      ),
    ).rejects.toThrow("outside this session's scope");
  });

  it("checks sentry api endpoints against the session", async () => {
    const { call, calls } = setup();
    await call(
      "execute_sentry_read",
      {
        command: "api",
        params: { positional: ["/api/0/organizations/acme/issues/"] },
      },
      org,
    );
    expect(calls).toHaveLength(1);
    await expect(
      call(
        "execute_sentry_read",
        { command: "api", params: { positional: ["projects/other/web/"] } },
        org,
      ),
    ).rejects.toThrow("outside this session's scope");
    await expect(
      call(
        "execute_sentry_read",
        { command: "api", params: { positional: ["issues/1/"] } },
        org,
      ),
    ).rejects.toThrow("not scoped to an organization");
  });
});

describe("execute tools: results", () => {
  it("lifts nextCursor out of a list envelope", async () => {
    const { call } = setup(
      {},
      { data: [{ id: "1" }], hasMore: true, nextCursor: "0:25:0" },
    );
    expect(
      await call("execute_sentry_read", { command: "issue list" }),
    ).toEqual({
      command: "issue list",
      nextCursor: "0:25:0",
      result: { data: [{ id: "1" }], hasMore: true },
    });
  });

  it("returns several yields as one result", async () => {
    const { call } = setup({}, [{ a: 1 }, { b: 2 }]);
    expect(await call("execute_sentry_read", { command: "org list" })).toEqual({
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
    const text = (await tools.execute_sentry_read?.handler(
      { command: "issue list" } as never,
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
    const text = (await tools.execute_sentry_read?.handler(
      { command: "org list" } as never,
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

  it("lists the search and execute tools with their hints", async () => {
    const tools = await listTools({});
    expect(
      Object.fromEntries(
        tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint]),
      ),
    ).toEqual({
      search_sentry: true,
      execute_sentry_read: true,
      execute_sentry_write: false,
    });
    const write = tools.find((tool) => tool.name === "execute_sentry_write");
    expect(write?.annotations?.destructiveHint).toBe(true);
    expect(write?.inputSchema.required).toEqual(["command"]);
  });

  it("lists no write tool when read-only", async () => {
    const names = (await listTools({ readOnly: true })).map(
      (tool) => tool.name,
    );
    expect(names.sort()).toEqual(["execute_sentry_read", "search_sentry"]);
  });
});
