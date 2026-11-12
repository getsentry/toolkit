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
    const name = toolName(command);
    if (!Object.hasOwn(tools, name)) {
      throw new Error(`no tool for ${command}`);
    }
    const tool = tools[name];
    return JSON.parse((await tool.handler(params, context)) as string);
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

  it("grants writes only to the skill that covers them", () => {
    const { tools } = setup();
    expect(tools.sentry_issue_list.skills).toContain("inspect");
    expect(tools.sentry_issue_resolve.skills).toEqual(["triage"]);
    expect(tools.sentry_issue_plan.skills).toEqual(["seer"]);
    expect(tools.sentry_project_delete.skills).toEqual(["project-management"]);
    expect(tools.sentry_api.skills).toContain("inspect");
  });

  it("refuses sentry api writes without a write skill", async () => {
    const { call, calls } = setup();
    const inspectOnly = createTestContext({
      grantedSkills: new Set(["inspect"]),
    });
    await call("api", { positional: ["organizations/"] }, inspectOnly);
    await expect(
      call(
        "api",
        { positional: ["projects/acme/web/"], flags: { method: "DELETE" } },
        inspectOnly,
      ),
    ).rejects.toThrow("needs the triage or project-management skill");
    expect(calls).toHaveLength(1);
  });

  it("names tools from the command path", () => {
    const { tools } = setup();
    expect(tools.sentry_issue_list).toBeDefined();
    expect(tools.sentry_agent_conversation_list).toBeDefined();
    // Hidden and stdio-only commands are not tools.
    expect(tools.sentry_auth_login).toBeUndefined();
    expect(tools.sentry_sourcemap_upload).toBeUndefined();
  });

  it("titles each tool from its command path", () => {
    const { tools } = setup();
    expect(tools.sentry_issue_list.title).toBe("Issue List");
    expect(tools.sentry_agent_conversation_list.title).toBe(
      "Agent Conversation List",
    );
    const titles = Object.values(tools).map((tool) => tool.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("describes a command with its brief and usable examples", () => {
    const description = setup().tools.sentry_issue_view.description;
    expect(description).toMatch(/^View details of/);
    expect(description).toContain("sentry issue view FRONT-ABC");
    // Examples that pipe output elsewhere are dropped.
    expect(description).not.toContain("| jq");
  });

  it("gives sentry api the hints of its session", () => {
    expect(setup().tools.sentry_api.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(
      setup({ readOnly: true }).tools.sentry_api.annotations,
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
      ].map((tool) => tool.annotations),
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
    [
      "status show",
      "url",
      "http://169.254.169.254",
      "it fetches a host the caller picks",
    ],
  ])("refuses %s --%s", async (command, flag, value, reason) => {
    const { call } = setup();
    await expect(
      call(command, { positional: ["x"], flags: { [flag]: value } }),
    ).rejects.toThrow(
      `\`--${flag}\` is not available to agents, because ${reason}`,
    );
  });

  it.each([
    "https://evil.example/api/0/organizations/acme/issues/",
    " HTTP://169.254.169.254/latest/",
    "ht\ntps://evil.example/organizations/acme/",
  ])("refuses sentry api with the absolute URL %j", async (endpoint) => {
    const { call, calls } = setup();
    await expect(call("api", { positional: [endpoint] })).rejects.toThrow(
      "an absolute URL fetches a host the caller picks",
    );
    expect(calls).toEqual([]);
  });

  it.each(["next", "prev", "last", "previous"])(
    "refuses the stored-cursor keyword %s when hosted",
    async (cursor) => {
      const { call } = setup({ runtime: "hosted" });
      await expect(call("issue list", { flags: { cursor } })).rejects.toThrow(
        "Pass the nextCursor value",
      );
    },
  );

  it("treats null flags and positionals as none", async () => {
    const { call, calls } = setup();
    await call("org list", { positional: null, flags: null });
    expect(calls[0]).toMatchObject({ positional: [], flags: {} });
    await expect(call("org list", { flags: "limit=5" })).rejects.toThrow(
      "flags: must be an object",
    );
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

  it("pins every project of an organization to the session's project", async () => {
    const { call, calls } = setup();
    await call("issue list", { positional: ["acme/"] }, project);
    await call("explore", { positional: ["acme/"] }, project);
    await call("issue list", { positional: ["acme/"] }, org);
    expect(calls.map((c) => c.positional)).toEqual([
      ["acme/web"],
      ["acme/web"],
      ["acme/"],
    ]);
  });

  it("keeps GitHub-style and colon issue references in the session", async () => {
    const { call, calls } = setup();
    await call("issue view", { positional: ["acme/web#G"] }, project);
    await call("issue view", { positional: ["web:G"] }, project);
    await call("issue view", { positional: ["#G"] }, project);
    expect(calls.map((c) => c.positional)).toEqual([
      ["acme/web#G"],
      ["web:G"],
      ["#G"],
    ]);
  });

  it("keeps dashboard and trace targets in the session", async () => {
    const { call, calls } = setup();
    await call("dashboard view", { positional: ["acme", "123"] }, org);
    await call("span list", { positional: ["acme/web"] }, project);
    await call("trace view", { positional: ["acme/web", "abc123"] }, project);
    expect(calls.map((c) => c.positional)).toEqual([
      ["acme", "123"],
      ["acme/web"],
      ["acme/web", "abc123"],
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
    ["project view", ["https://sentry.io/settings/other/projects/web/"], org],
    [
      "project view",
      ["https://sentry.io/settings/acme/projects/api/"],
      project,
    ],
    [
      "project view",
      ["https://acme.sentry.io/settings/projects/api/"],
      project,
    ],
    [
      "feedback view",
      ["https://acme.sentry.io/feedback/?feedbackSlug=api:1"],
      project,
    ],
    ["release view", ["other/1.0.0"], org],
    ["attribute list", ["other/web"], org],
    ["attribute list", ["api"], project],
    ["explore", ["other/"], org],
    ["feedback view", ["other/WEB-1"], org],
    ["feedback view", ["acme/api/1"], project],
    ["issue view", ["acme/api/G"], project],
    ["issue view", ["acme/api#G"], project],
    ["issue view", ["api#G"], project],
    ["issue view", ["api:G"], project],
    ["issue view", ["other/web#G"], org],
    ["agent-conversation view", ["conv-1", "other/conv-2"], org],
    ["agent-conversation view", ["other", "conv-1"], org],
    ["dashboard view", ["other", "123"], org],
    ["dashboard view", ["other", "Errors"], org],
    ["span list", ["acme/api"], project],
    ["trace view", ["acme/api", "abc123"], project],
    ["log list", ["acme/api"], project],
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

  it.each([
    ["release create", ["acme/1.0.0"], "api"],
    ["release create", ["acme/1.0.0"], "web,api"],
    ["alert metrics edit", ["acme/rule"], ["web", "api"]],
    ["alert metrics edit", ["acme/rule"], ["web,api"]],
  ])(
    "refuses %s with --project %j for another project",
    async (command, positional, projectFlag) => {
      const { call, calls } = setup();
      await expect(
        call(command, { positional, flags: { project: projectFlag } }, project),
      ).rejects.toThrow("outside this session's scope");
      expect(calls).toEqual([]);
    },
  );

  it("checks sentry api endpoints against the session", async () => {
    const { call, calls } = setup();
    await call(
      "api",
      { positional: ["/api/0/organizations/acme/issues/"] },
      org,
    );
    await call("api", { positional: ["api/0/organizations/acme/"] }, org);
    expect(calls).toHaveLength(2);
    await expect(
      call("api", { positional: ["api/0/organizations/other/"] }, org),
    ).rejects.toThrow("outside this session's scope");
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
    expect(calls).toHaveLength(3);
    await call(
      "project view",
      { positional: ["https://sentry.io/settings/acme/projects/web/"] },
      project,
    );
    expect(calls).toHaveLength(4);
    await expect(
      call("api", { positional: ["issues/1/"] }, org),
    ).rejects.toThrow("not scoped to an organization");
    await expect(
      call(
        "api",
        { positional: ["organizations/acme/../../projects/other/web/"] },
        org,
      ),
    ).rejects.toThrow("outside this session's scope");
    await expect(
      call("api", { positional: ["organizations/acme/%2e%2e/other/"] }, org),
    ).rejects.toThrow("outside this session's scope");
    await call("api", { positional: ["teams/acme/backend/projects/"] }, org);
    await expect(
      call("api", { positional: ["teams/other/backend/"] }, org),
    ).rejects.toThrow("outside this session's scope");
    for (const endpoint of [
      "organizations/acme/issues/",
      "teams/acme/backend/projects/",
      "projects/acme/",
    ]) {
      await expect(
        call("api", { positional: [endpoint] }, project),
      ).rejects.toThrow("not scoped to a project");
    }
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
    const text = (await tools.sentry_issue_list.handler(
      {},
      createTestContext(),
    )) as string;
    const result = JSON.parse(text);

    expect(text.length).toBeLessThanOrEqual(2_000);
    expect(result.truncated).toMatchObject({ total: 100 });
    expect(result.result.data).toHaveLength(result.truncated.returned);
  });

  it("drops nextCursor when a page is cut, since it would skip items", async () => {
    const data = Array.from({ length: 100 }, (_, id) => ({
      id,
      title: "x".repeat(100),
    }));
    const { tools } = setup(
      { maxResultChars: 2_000 },
      { data, hasMore: true, nextCursor: "0:100:0" },
    );
    const result = JSON.parse(
      (await tools.sentry_issue_list.handler(
        {},
        createTestContext(),
      )) as string,
    );

    expect(result.truncated.returned).toBeLessThan(100);
    expect(result).not.toHaveProperty("nextCursor");
    expect(result.truncated.hint).toContain("lower limit");
  });

  it("cuts a large single value to valid JSON within the cap", async () => {
    const { tools } = setup(
      { maxResultChars: 500 },
      { body: "x".repeat(2_000) },
    );
    const text = (await tools.sentry_org_list.handler(
      {},
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
    expect(flags.limit.default).toBe(25);
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
