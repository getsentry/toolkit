/**
 * Metadata linter for what an MCP client receives from `initialize` and
 * `tools/list`. See docs/contributing/tool-responses.md#metadata-linter for
 * the checks and for how to add a skip entry.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineTool } from "./internal/tool-helpers/define";
import { buildServer } from "./server";
import { MAX_SERVER_INSTRUCTIONS_LENGTH } from "./server-instructions";
import type { Skill } from "./skills";
import catalogTools from "./tools/catalog/index";
import { MAX_TOOL_DESCRIPTION_LENGTH } from "./tools/types";
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

/** The only `_meta` keys each tool may export. */
const ALLOWED_TOOL_META: Record<string, readonly string[]> = {
  // Claude Code keeps it loaded so a pasted Sentry URL works without a tool
  // search. See docs/mcp/harnesses.md.
  get_sentry_resource: ["anthropic/alwaysLoad"],
};

/** Tools that return no `structuredContent` by design. */
const OUTPUT_SCHEMA_EXEMPT: Record<string, string> = {
  get_issue_details:
    "markdown-only by policy (docs/contributing/tool-responses.md)",
  get_trace_details:
    "markdown-only by policy (docs/contributing/tool-responses.md)",
  get_event_stacktrace:
    "markdown-only by policy (docs/contributing/tool-responses.md)",
  get_span_details: "delegates to the get_trace_details renderer",
  get_doc: "returns doc text",
  get_snapshot_image: "returns an image",
  get_event_attachment: "its download path returns image or resource content",
  get_sentry_resource: "passes through whatever tool it resolves to",
  analyze_issue_with_seer: "has narrative polling paths",
};

/**
 * PENDING: tools whose outputSchema has not landed yet. Delete an entry when
 * its PR merges; a test below fails until you do.
 */
const OUTPUT_SCHEMA_PENDING: Record<string, string> = {
  search_attributes: "pending: experimental-only, no outputSchema PR yet",
};

const CATALOG_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "tools/catalog",
);

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

interface ClientSurface {
  serverInfo: ReturnType<Client["getServerVersion"]>;
  instructions: string | undefined;
  tools: ListedTool[];
}

async function readSurface(experimentalMode: boolean): Promise<ClientSurface> {
  const context: ServerContext = {
    accessToken: "test-token",
    grantedSkills: ALL_SKILLS,
    constraints: { organizationSlug: null, projectSlug: null },
    sentryHost: "sentry.io",
  };
  const server = buildServer({ context, experimentalMode });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "metadata-lint", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    // A second page would hide tools from every check below.
    expect(listed.nextCursor).toBeUndefined();
    return {
      serverInfo: client.getServerVersion(),
      instructions: client.getInstructions(),
      tools: listed.tools,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/** Each server mode a client can get, keyed by its test label. */
const MODES = { stable: false, experimental: true } as const;

const surfaces = new Map<string, ClientSurface>();

beforeAll(async () => {
  for (const [mode, experimentalMode] of Object.entries(MODES)) {
    surfaces.set(mode, await readSurface(experimentalMode));
  }
});

function failures(
  tools: ListedTool[],
  check: (tool: ListedTool) => string | undefined,
): string[] {
  return tools.flatMap((tool) => {
    const failure = check(tool);
    return failure ? [`${tool.name}: ${failure}`] : [];
  });
}

describe.each(Object.keys(MODES))("%s mode", (mode) => {
  const surface = () => {
    const found = surfaces.get(mode);
    if (!found) throw new Error(`no ${mode} surface`);
    return found;
  };

  it("identifies the server in serverInfo", () => {
    const { serverInfo } = surface();
    // Telemetry and clients key on this name; clients display `title`.
    expect(serverInfo?.name).toBe("Sentry MCP");
    for (const field of ["title", "description", "websiteUrl"] as const) {
      expect(serverInfo?.[field]?.trim(), `serverInfo.${field}`).toBeTruthy();
    }
    expect(serverInfo?.websiteUrl).toMatch(/^https:\/\//);
    expect(serverInfo?.icons?.length, "serverInfo.icons").toBeGreaterThan(0);
    for (const icon of serverInfo?.icons ?? []) {
      expect(icon.src, "serverInfo.icons[].src").toMatch(/^https:\/\//);
      expect(icon.mimeType, "serverInfo.icons[].mimeType").toBeTruthy();
    }
  });

  it(`returns instructions of at most ${MAX_SERVER_INSTRUCTIONS_LENGTH} characters`, () => {
    const { instructions } = surface();
    expect(instructions?.trim(), "instructions").toBeTruthy();
    expect(instructions?.length).toBeLessThanOrEqual(
      MAX_SERVER_INSTRUCTIONS_LENGTH,
    );
  });

  it("uses valid tool names, object input schemas, and no task support", () => {
    const problems = failures(surface().tools, (tool) => {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) {
        return "name must match ^[A-Za-z0-9_.-]{1,128}$";
      }
      if (tool.inputSchema.type !== "object") {
        return "inputSchema root must be an object";
      }
      // The server implements no MCP tasks, so no tool may advertise them.
      return tool.execution?.taskSupport === undefined
        ? undefined
        : `advertises execution.taskSupport: ${tool.execution.taskSupport}`;
    });
    expect(problems).toEqual([]);
  });

  it("gives every tool a unique title", () => {
    const owners = new Map<string, string>();
    const problems = failures(surface().tools, (tool) => {
      const title = tool.title?.trim();
      if (!title) return "missing title";
      const owner = owners.get(title);
      owners.set(title, tool.name);
      // Deprecated aliases are told apart by their " (Deprecated)" suffix.
      return owner ? `reuses the title of ${owner}` : undefined;
    });
    expect(problems).toEqual([]);
  });

  it("sets every safety hint explicitly", () => {
    const hints = ["readOnlyHint", "destructiveHint", "openWorldHint"] as const;
    const problems = failures(surface().tools, (tool) => {
      const missing = hints.filter(
        (hint) => typeof tool.annotations?.[hint] !== "boolean",
      );
      return missing.length > 0 ? `missing ${missing.join(", ")}` : undefined;
    });
    expect(problems).toEqual([]);
  });

  it(`keeps descriptions at most ${MAX_TOOL_DESCRIPTION_LENGTH} characters`, () => {
    const problems = failures(surface().tools, (tool) => {
      const length = tool.description?.trim().length ?? 0;
      if (length === 0) return "missing description";
      return length > MAX_TOOL_DESCRIPTION_LENGTH
        ? `description is ${length} characters`
        : undefined;
    });
    expect(problems).toEqual([]);
  });

  it("exports only allowlisted _meta keys", () => {
    const problems = failures(surface().tools, (tool) => {
      const allowed = ALLOWED_TOOL_META[tool.name] ?? [];
      const extra = Object.keys(tool._meta ?? {}).filter(
        (key) => !allowed.includes(key),
      );
      return extra.length > 0
        ? `_meta key ${extra.join(", ")} is not in ALLOWED_TOOL_META`
        : undefined;
    });
    expect(problems).toEqual([]);
  });

  it("declares an object outputSchema unless the tool is skipped", () => {
    const problems = failures(surface().tools, (tool) => {
      if (tool.outputSchema) {
        return tool.outputSchema.type === "object"
          ? undefined
          : "outputSchema root must be an object";
      }
      return tool.name in OUTPUT_SCHEMA_EXEMPT ||
        tool.name in OUTPUT_SCHEMA_PENDING
        ? undefined
        : "missing outputSchema; add one, or an OUTPUT_SCHEMA_EXEMPT or OUTPUT_SCHEMA_PENDING entry with a reason";
    });
    expect(problems).toEqual([]);
  });
});

describe("outputSchema skip lists", () => {
  const listed = () =>
    new Map(
      [...surfaces.values()].flatMap(({ tools }) =>
        tools.map((tool) => [tool.name, tool] as const),
      ),
    );

  it("name listed tools without an outputSchema", () => {
    const tools = listed();
    const problems = [
      ...Object.keys(OUTPUT_SCHEMA_EXEMPT).map((name) => ["EXEMPT", name]),
      ...Object.keys(OUTPUT_SCHEMA_PENDING).map((name) => ["PENDING", name]),
    ].flatMap(([list, name]) => {
      const tool = tools.get(name);
      if (!tool) return [`${name}: in OUTPUT_SCHEMA_${list} but not listed`];
      if (tool.outputSchema) {
        return [
          `${name}: has an outputSchema now; delete its OUTPUT_SCHEMA_${list} entry`,
        ];
      }
      return [];
    });
    expect(problems).toEqual([]);
  });

  it("do not overlap", () => {
    expect(
      Object.keys(OUTPUT_SCHEMA_EXEMPT).filter(
        (name) => name in OUTPUT_SCHEMA_PENDING,
      ),
    ).toEqual([]);
  });

  it("give every entry a reason", () => {
    for (const [name, reason] of Object.entries({
      ...OUTPUT_SCHEMA_EXEMPT,
      ...OUTPUT_SCHEMA_PENDING,
    })) {
      expect(reason.trim(), name).toBeTruthy();
    }
  });
});

describe("structured output", () => {
  it("validates handler results against outputSchema in every test", async () => {
    // test-utils/structured-output-guard.ts wraps defineTool for the suite.
    const tool = defineTool({
      name: "lint_probe",
      title: "Lint Probe",
      description: "Probe.",
      skills: ["inspect"],
      requiredScopes: [],
      inputSchema: {},
      outputSchema: z.object({ count: z.number() }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      // @ts-expect-error -- the probe breaks its schema on purpose; the guard
      // catches what types miss, such as unvalidated upstream data.
      handler: async () => ({ structuredContent: { count: "one" } }),
    });

    await expect(tool.handler({}, {} as ServerContext)).rejects
      .toThrowErrorMatchingInlineSnapshot(`
      [Error: lint_probe returned structuredContent that does not match its outputSchema: [
        {
          "expected": "number",
          "code": "invalid_type",
          "path": [
            "count"
          ],
          "message": "Invalid input: expected number, received string"
        }
      ]]
    `);
  });

  it("covers every listed tool with an outputSchema in its colocated tests", () => {
    const catalogFiles = fs.readdirSync(CATALOG_DIR);
    const problems = [...surfaces.values()]
      .flatMap(({ tools }) => tools)
      .filter((tool) => tool.outputSchema && tool.name in catalogTools)
      .flatMap((tool) => {
        // Matches <name>.test.ts and variants such as <name>.structured.test.ts.
        const base = tool.name.replaceAll("_", "-");
        const testFile = new RegExp(`^${base}(\\..+)?\\.test\\.ts$`);
        const readsStructuredContent = catalogFiles
          .filter((file) => testFile.test(file))
          .some((file) => {
            const contents = fs.readFileSync(
              path.join(CATALOG_DIR, file),
              "utf8",
            );
            return (
              contents.includes("structuredContent") ||
              contents.includes("getStructuredContent(") ||
              contents.includes("assertStructuredOnlyResult(")
            );
          });
        return readsStructuredContent
          ? []
          : [`${tool.name}: no ${base}*.test.ts reads structuredContent`];
      });
    expect([...new Set(problems)]).toEqual([]);
  });
});
