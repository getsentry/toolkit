import { describe, expect, it } from "vitest";
import {
  resolveClientFamily,
  resolveClientFamilyFromName,
} from "./client-family";

describe("resolveClientFamily", () => {
  it.each([
    ["claude-code/2.1.118 (cli)", "claude-code"],
    ["Cursor/3.1.15 (darwin arm64)", "cursor"],
    ["copilot/1.0.34", "copilot"],
    ["opencode/1.4.7", "opencode"],
    ["Claude-User", "claude"],
    ["codex-cli/1.0.0", "codex"],
    ["ReactorNetty/1.2.12", "reactor-netty"],
    ["Java-http-client/21.0.10", "java-http-client"],
    ["Go-http-client/1.1", "go-http-client"],
    ["python-httpx/0.28.1", "python"],
    ["Python/3.12 aiohttp/3.13.5", "python"],
    ["Bun/1.3.13", "bun"],
    ["node", "node"],
    ["node-fetch/1.0", "node"],
    ["axios/1.15.0", "other"],
    ["", "unknown"],
    [null, "unknown"],
    [undefined, "unknown"],
  ])("maps %s → %s", (input, expected) => {
    expect(resolveClientFamily(input)).toBe(expected);
  });
});

describe("resolveClientFamilyFromName", () => {
  it.each([
    ["Claude Code", "claude-code"],
    ["claude-code", "claude-code"],
    ["Claude", "claude"],
    ["Claude Desktop", "claude"],
    ["Cursor", "cursor"],
    ["GitHub Copilot", "copilot"],
    ["Codex CLI", "codex"],
    ["opencode", "opencode"],
    ["Some Random Client", "other"],
    ["", "unknown"],
    [null, "unknown"],
    [undefined, "unknown"],
  ])("maps %s → %s", (input, expected) => {
    expect(resolveClientFamilyFromName(input)).toBe(expected);
  });
});
