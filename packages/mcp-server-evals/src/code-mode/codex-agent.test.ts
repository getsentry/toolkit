import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCodexAgent } from "./codex-agent";

const directories: string[] = [];
const options = { model: "test-model", systemPrompt: "Use the MCP tools." };

async function fakeCodex(events: unknown[], closeInput = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-eval-test-"));
  directories.push(directory);
  const executable = path.join(directory, "codex");
  // Exercise the real process boundary, including a final event without a newline.
  const payload = events.map((event) => JSON.stringify(event)).join("\n");
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require("node:fs");
if (${closeInput}) {
  fs.closeSync(0);
  setTimeout(() => process.exit(1), 20);
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    fs.writeFileSync("capture.json", JSON.stringify({ args: process.argv.slice(2), input }));
    const payload = ${JSON.stringify(payload)};
    process.stdout.write(payload.slice(0, 37));
    process.stdout.write(payload.slice(37));
  });
}
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

describe("Codex Code Mode adapter", () => {
  it("keeps the final event and aggregate usage without a trailing newline", async () => {
    const usage = { input_tokens: 100, output_tokens: 20 };
    const directory = await fakeCodex([
      {
        type: "item.completed",
        session_id: "private-session-metadata",
        item: {
          id: "call-1",
          type: "mcp_tool_call",
          server: "sentry_code_mode",
          tool: "execute_sentry_code",
          arguments: { code: "async () => 2" },
          status: "completed",
          result: { content: [{ type: "text", text: "2" }] },
        },
      },
      {
        type: "item.completed",
        item: {
          id: "answer",
          type: "agent_message",
          text: "Copied both dashboards.",
        },
      },
      { type: "turn.completed", usage },
    ]);
    const result = await runCodexAgent(
      directory,
      "http://127.0.0.1:4321/mcp",
      "dummy-token",
      "Copy two dashboards",
      options,
    );
    expect(result).toMatchObject({
      exitCode: 0,
      error: undefined,
      text: "Copied both dashboards.",
      usage,
      mcpCalls: [{ id: "call-1", name: "execute_sentry_code" }],
    });
    expect(JSON.stringify(result.events)).not.toContain("private-");
    const capture = JSON.parse(
      await readFile(path.join(directory, "capture.json"), "utf8"),
    );
    expect(capture.input).toBe("Copy two dashboards");
    expect(capture.args).toContain(
      'developer_instructions="Use the MCP tools."',
    );
    expect(capture.args).toContain("--ignore-user-config");
  });

  it("reports a closed input instead of crashing the evaluation process", async () => {
    const directory = await fakeCodex([], true);
    const result = await runCodexAgent(
      directory,
      "http://localhost/mcp",
      "dummy-token",
      "x".repeat(2_000_000),
      options,
    );
    expect(result.error).toBe(
      "Codex closed its input before accepting the prompt",
    );
  });

  it("rejects an out-of-scope tool even when it is the final event", async () => {
    const directory = await fakeCodex([
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
      {
        type: "item.completed",
        item: { id: "shell", type: "command_execution" },
      },
    ]);
    const result = await runCodexAgent(
      directory,
      "http://localhost/mcp",
      "dummy-token",
      "Copy",
      options,
    );
    expect(result.error).toBe("Agent used a tool outside the experiment");
  });
});
