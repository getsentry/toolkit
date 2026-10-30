import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runClaudeAgent } from "./claude-agent";

const tools = [
  "mcp__sentry_code_mode__search_sentry_api",
  "mcp__sentry_code_mode__execute_sentry_code",
];
const options = {
  serverName: "sentry_code_mode",
  toolNames: ["search_sentry_api", "execute_sentry_code"],
};
const init = {
  type: "system",
  subtype: "init",
  model: "claude-test-alias",
  tools,
  session_id: "private-session-metadata",
  apiKeySource: "private-account-metadata",
};
const directories: string[] = [];

async function fakeClaude(events: unknown[], exitCode = 0) {
  const directory = await mkdtemp(path.join(tmpdir(), "claude-eval-test-"));
  directories.push(directory);
  const executable = path.join(directory, "claude");
  // A real process exercises argument boundaries, stdin and JSONL parsing.
  // Deliberately omit the final newline to cover the stream's trailing event.
  const payload = events.map((event) => JSON.stringify(event)).join("\n");
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync("capture.json", JSON.stringify({ args: process.argv.slice(2), input }));
  const payload = ${JSON.stringify(payload)};
  process.stdout.write(payload.slice(0, 37));
  process.stdout.write(payload.slice(37));
  process.exitCode = ${exitCode};
});
`,
  );
  await chmod(executable, 0o755);
  vi.stubEnv("PATH", `${directory}${path.delimiter}${process.env.PATH ?? ""}`);
  return directory;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Claude Code Mode adapter", () => {
  it("uses only MCP tools and reports aggregate usage, resolved model and task evidence", async () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 30,
      cache_creation_input_tokens: 60,
      cache_read_input_tokens: 400,
    };
    const resultContent = [{ type: "text", text: '{"copied":2}' }];
    const directory = await fakeClaude([
      init,
      {
        type: "assistant",
        session_id: "private-session-metadata",
        message: {
          model: "claude-test-resolved",
          usage,
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: tools[1],
              input: { code: "async () => 2" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: resultContent,
              is_error: false,
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          model: "claude-test-resolved",
          usage,
          content: [{ type: "text", text: "Copied both dashboards." }],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Copied both dashboards.",
        usage,
        total_cost_usd: 0.01,
        num_turns: 2,
      },
    ]);
    const result = await runClaudeAgent(
      directory,
      "http://127.0.0.1:4321/mcp",
      "dummy-token",
      "Copy two dashboards",
      {
        ...options,
        model: "requested-alias",
        systemPrompt: "System instructions",
      },
    );
    expect(result).toMatchObject({
      exitCode: 0,
      error: undefined,
      model: "claude-test-resolved",
      advertisedModel: "claude-test-alias",
      text: "Copied both dashboards.",
      usage,
      reportedCostUsd: 0.01,
      turns: 2,
      mcpCalls: [
        {
          id: "call-1",
          name: "execute_sentry_code",
          input: { code: "async () => 2" },
        },
      ],
      mcpErrors: 0,
      toolResultBytes: Buffer.byteLength(JSON.stringify(resultContent)),
    });
    expect(JSON.stringify(result.events)).not.toContain("private-");
    const capture = JSON.parse(
      await readFile(path.join(directory, "capture.json"), "utf8"),
    );
    expect(capture.input).toBe("Copy two dashboards");
    const argument = (name: string) =>
      capture.args[capture.args.indexOf(name) + 1];
    expect(argument("--tools")).toBe("");
    expect(argument("--allowedTools")).toBe(tools.join(","));
    expect(argument("--setting-sources")).toBe("");
    expect(argument("--settings")).toBe('{"disableAllHooks":true}');
    expect(argument("--permission-mode")).toBe("dontAsk");
    expect(argument("--model")).toBe("requested-alias");
    expect(argument("--effort")).toBe("medium");
    expect(argument("--system-prompt")).toBe("System instructions");
    expect(capture.args).toEqual(
      expect.arrayContaining([
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
      ]),
    );
    expect(capture.args).not.toContain("--bare");
    expect(JSON.parse(argument("--mcp-config"))).toEqual({
      mcpServers: {
        sentry_code_mode: {
          type: "http",
          url: "http://127.0.0.1:4321/mcp",
          headers: { Authorization: "Bearer dummy-token" },
        },
      },
    });
  });

  it("lets Claude select among the full MCP inventory with its default system prompt", async () => {
    const names = [
      "search_sentry_tools",
      "execute_sentry_tool",
      "get_issue_details",
      ...options.toolNames,
    ];
    const directory = await fakeClaude([
      { ...init, tools: names.map((name) => `mcp__sentry__${name}`) },
      { type: "result", subtype: "success", is_error: false, result: "Done" },
    ]);
    const result = await runClaudeAgent(
      directory,
      "http://localhost/mcp",
      "dummy",
      "Copy my dashboard",
      {
        serverName: "sentry",
        toolNames: names,
      },
    );
    expect(result.error).toBeUndefined();
    const capture = JSON.parse(
      await readFile(path.join(directory, "capture.json"), "utf8"),
    );
    expect(capture.input).toBe("Copy my dashboard");
    expect(capture.args).not.toContain("--system-prompt");
    expect(capture.args).not.toContain("--append-system-prompt");
    expect(capture.args[capture.args.indexOf("--allowedTools") + 1]).toBe(
      names.map((name) => `mcp__sentry__${name}`).join(","),
    );
  });

  it("fails an OAuth error even when the result subtype says success", async () => {
    const error =
      "Failed to authenticate: OAuth session expired and could not be refreshed";
    const directory = await fakeClaude([
      init,
      {
        type: "assistant",
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: error }],
        },
      },
      { type: "result", subtype: "success", is_error: true, result: error },
    ]);
    const result = await runClaudeAgent(
      directory,
      "http://localhost/mcp",
      "dummy",
      "Copy",
      options,
    );
    expect(result.error).toBe(error);
    expect(result.model).toBe("claude-test-alias");
    expect(result.mcpCalls).toEqual([]);
  });

  it.each([
    { label: "advertised", events: [{ ...init, tools: [...tools, "Bash"] }] },
    {
      label: "used",
      events: [
        init,
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "outside",
                name: "Bash",
                input: { command: "echo unexpected" },
              },
            ],
          },
        },
      ],
    },
  ])(
    "rejects tools $label outside the two-tool experiment",
    async ({ events }) => {
      const directory = await fakeClaude([
        ...events,
        { type: "result", subtype: "success", is_error: false, result: "Done" },
      ]);
      const result = await runClaudeAgent(
        directory,
        "http://localhost/mcp",
        "dummy",
        "Copy",
        options,
      );
      expect(result.error).toContain("outside the experiment");
    },
  );
});
