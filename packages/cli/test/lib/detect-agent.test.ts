import { afterEach, describe, expect, test } from "vitest";

import {
  AGENT_ALIASES,
  type AgentInfo,
  detectAgent,
  detectAgentFromProcessTree,
  ENV_VAR_AGENTS,
  getProcessInfoFromOS,
  normalizeAgent,
  PROCESS_NAME_AGENTS,
  setProcessInfoProvider,
} from "../../src/lib/detect-agent.js";
import { setEnv } from "../../src/lib/env.js";

/** Shorthand for building an AgentInfo with only a name. */
function named(name: string): AgentInfo {
  return { name };
}

function withEnv(vars: Record<string, string>) {
  setEnv(vars as NodeJS.ProcessEnv);
}

/** No-op async provider typed to satisfy ProcessInfoProvider. */
async function noProcessInfo(_pid: number): Promise<undefined> {
  return;
}

describe("detectAgent", () => {
  afterEach(() => {
    setEnv(process.env);
    setProcessInfoProvider(getProcessInfoFromOS);
  });

  // ── AI_AGENT override ──────────────────────────────────────────────

  test("AI_AGENT takes highest priority", () => {
    withEnv({
      AI_AGENT: "custom-agent",
      CURSOR_EXTENSION_HOST_ROLE: "agent-exec",
      GROK_PLUGIN_DATA: "/tmp/grok",
      CLAUDE_CODE: "1",
      CI: "true",
    });
    expect(detectAgent()).toEqual(named("custom-agent"));
  });

  test("AI_AGENT empty string is ignored", () => {
    withEnv({ AI_AGENT: "" });
    expect(detectAgent()).toBeUndefined();
  });

  test("AI_AGENT whitespace-only is ignored", () => {
    withEnv({ AI_AGENT: "   " });
    expect(detectAgent()).toBeUndefined();
  });

  test("AI_AGENT is trimmed and lowercased", () => {
    withEnv({ AI_AGENT: "  My-Agent  " });
    expect(detectAgent()).toEqual(named("my-agent"));
  });

  test("AI_AGENT compound value extracts name, version, and role", () => {
    withEnv({ AI_AGENT: "claude-code/2.1.123/agent" });
    expect(detectAgent()).toEqual({
      name: "claude",
      version: "2.1.123",
      role: "agent",
    });
  });

  test("AI_AGENT with alias resolves to canonical name", () => {
    withEnv({ AI_AGENT: "claude-code" });
    expect(detectAgent()).toEqual(named("claude"));
  });

  test("AI_AGENT garbage value '1' becomes unknown", () => {
    withEnv({ AI_AGENT: "1" });
    expect(detectAgent()).toEqual(named("unknown"));
  });

  test("AI_AGENT garbage value 'true' becomes unknown", () => {
    withEnv({ AI_AGENT: "true" });
    expect(detectAgent()).toEqual(named("unknown"));
  });

  test("AI_AGENT falsy value 'false' is treated as no agent", () => {
    withEnv({ AI_AGENT: "false" });
    expect(detectAgent()).toBeUndefined();
  });

  test("AI_AGENT falsy value '0' is treated as no agent", () => {
    withEnv({ AI_AGENT: "0" });
    expect(detectAgent()).toBeUndefined();
  });

  test("AI_AGENT falsy opt-out falls through to next detection level", () => {
    withEnv({ AI_AGENT: "false", CLAUDE_CODE: "1" });
    expect(detectAgent()).toEqual(named("claude"));
  });

  test.each([
    ["CLINE_ACTIVE", "cline"],
    ["OPENCLAW_SHELL", "openclaw"],
    ["KIMI_PLUGIN_ROOT", "kimi"],
    ["GROK_PLUGIN_ROOT", "grok"],
    ["GROK_PLUGIN_DATA", "grok"],
    ["JUNIE_DATA", "junie"],
    ["JUNIE_SHIM_PATH", "junie"],
    ["CODEX_SANDBOX_NETWORK_DISABLED", "codex"],
    ["ANTIGRAVITY_CLI_ALIAS", "antigravity"],
    ["OPENCODE", "opencode"],
  ])("%s detects %s before the AGENT fallback", (envVar, agent) => {
    withEnv({ [envVar]: "1", AGENT: "other-agent" });
    expect(detectAgent()).toEqual(named(agent));
  });

  test("empty agent-specific signals are ignored", () => {
    withEnv({
      CLINE_ACTIVE: "",
      OPENCLAW_SHELL: "",
      KIMI_PLUGIN_ROOT: "",
      GROK_PLUGIN_ROOT: "",
      GROK_PLUGIN_DATA: "",
      JUNIE_DATA: "",
      JUNIE_SHIM_PATH: "",
      CODEX_SANDBOX_NETWORK_DISABLED: "",
      ANTIGRAVITY_CLI_ALIAS: "",
      OPENCODE: "",
    });
    expect(detectAgent()).toBeUndefined();
  });

  // ── Cursor ─────────────────────────────────────────────────────────

  test("CURSOR_TRACE_ID → cursor", () => {
    withEnv({ CURSOR_TRACE_ID: "abc123" });
    expect(detectAgent()).toEqual(named("cursor"));
  });

  test("CURSOR_AGENT → cursor", () => {
    withEnv({ CURSOR_AGENT: "1" });
    expect(detectAgent()).toEqual(named("cursor"));
  });

  test("CURSOR_TRACE_ID takes priority over CURSOR_AGENT", () => {
    withEnv({ CURSOR_TRACE_ID: "abc", CURSOR_AGENT: "1" });
    expect(detectAgent()).toEqual(named("cursor"));
  });

  test("CURSOR_EXTENSION_HOST_ROLE=agent-exec → cursor", () => {
    withEnv({ CURSOR_EXTENSION_HOST_ROLE: "agent-exec" });
    expect(detectAgent()).toEqual(named("cursor"));
  });

  test("Cursor agent-exec takes priority over other agent markers", () => {
    withEnv({
      CURSOR_EXTENSION_HOST_ROLE: "agent-exec",
      GEMINI_CLI: "1",
      GROK_PLUGIN_ROOT: "/tmp/grok",
      CLAUDE_CODE: "1",
      AGENT: "other-agent",
    });
    expect(detectAgent()).toEqual(named("cursor"));
  });

  test.each([
    "",
    "terminal",
    "agent-exec-helper",
    "AGENT-EXEC",
  ])("CURSOR_EXTENSION_HOST_ROLE=%j does not trigger detection", (role) => {
    withEnv({ CURSOR_EXTENSION_HOST_ROLE: role });
    expect(detectAgent()).toBeUndefined();
  });

  test("a different Cursor role falls through to other agent markers", () => {
    withEnv({ CURSOR_EXTENSION_HOST_ROLE: "terminal", CLINE_ACTIVE: "1" });
    expect(detectAgent()).toEqual(named("cline"));
  });

  // ── Gemini ─────────────────────────────────────────────────────────

  test("GEMINI_CLI → gemini", () => {
    withEnv({ GEMINI_CLI: "1" });
    expect(detectAgent()).toEqual(named("gemini"));
  });

  // ── Codex ──────────────────────────────────────────────────────────

  test("CODEX_SANDBOX → codex", () => {
    withEnv({ CODEX_SANDBOX: "1" });
    expect(detectAgent()).toEqual(named("codex"));
  });

  test("CODEX_CI → codex", () => {
    withEnv({ CODEX_CI: "1" });
    expect(detectAgent()).toEqual(named("codex"));
  });

  test("CODEX_THREAD_ID → codex", () => {
    withEnv({ CODEX_THREAD_ID: "thread-123" });
    expect(detectAgent()).toEqual(named("codex"));
  });

  // ── Antigravity ────────────────────────────────────────────────────

  test("ANTIGRAVITY_AGENT → antigravity", () => {
    withEnv({ ANTIGRAVITY_AGENT: "1" });
    expect(detectAgent()).toEqual(named("antigravity"));
  });

  // ── Augment ────────────────────────────────────────────────────────

  test("AUGMENT_AGENT → augment", () => {
    withEnv({ AUGMENT_AGENT: "1" });
    expect(detectAgent()).toEqual(named("augment"));
  });

  // ── OpenCode ───────────────────────────────────────────────────────

  test("OPENCODE_CLIENT → opencode", () => {
    withEnv({ OPENCODE_CLIENT: "1" });
    expect(detectAgent()).toEqual(named("opencode"));
  });

  // ── Claude Code ────────────────────────────────────────────────────

  test("CLAUDE_CODE → claude", () => {
    withEnv({ CLAUDE_CODE: "1" });
    expect(detectAgent()).toEqual(named("claude"));
  });

  test("CLAUDECODE → claude", () => {
    withEnv({ CLAUDECODE: "1" });
    expect(detectAgent()).toEqual(named("claude"));
  });

  test("CLAUDE_CODE + CLAUDE_CODE_IS_COWORK → cowork", () => {
    withEnv({ CLAUDE_CODE: "1", CLAUDE_CODE_IS_COWORK: "1" });
    expect(detectAgent()).toEqual(named("cowork"));
  });

  test("CLAUDECODE + CLAUDE_CODE_IS_COWORK → cowork", () => {
    withEnv({ CLAUDECODE: "1", CLAUDE_CODE_IS_COWORK: "1" });
    expect(detectAgent()).toEqual(named("cowork"));
  });

  test("CLAUDE_CODE_IS_COWORK alone does not trigger detection", () => {
    withEnv({ CLAUDE_CODE_IS_COWORK: "1" });
    expect(detectAgent()).toBeUndefined();
  });

  test.each([
    ["GROK_PLUGIN_ROOT", "CLAUDE_CODE", ""],
    ["GROK_PLUGIN_DATA", "CLAUDECODE", ""],
    ["GROK_PLUGIN_ROOT", "CLAUDECODE", "1"],
    ["GROK_PLUGIN_DATA", "CLAUDE_CODE", "1"],
  ])("%s takes priority over %s with CLAUDE_CODE_IS_COWORK=%j", (grokVar, claudeVar, cowork) => {
    withEnv({
      [grokVar]: "/tmp/grok",
      [claudeVar]: "1",
      CLAUDE_CODE_IS_COWORK: cowork,
    });
    expect(detectAgent()).toEqual(named("grok"));
  });

  // ── Excluded env vars (false positive risks) ──────────────────────

  test("REPL_ID alone does not trigger detection (platform env, not agent signal)", () => {
    withEnv({ REPL_ID: "abc123" });
    expect(detectAgent()).toBeUndefined();
  });

  test("COPILOT_GITHUB_TOKEN alone does not trigger detection (false positive risk)", () => {
    withEnv({ COPILOT_GITHUB_TOKEN: "ghu_xxx" });
    expect(detectAgent()).toBeUndefined();
  });

  test.each([
    ["GOOSE_PROVIDER", "openai"],
    ["KIMI_CODE_HOME", "/tmp/kimi"],
  ])("%s configuration alone does not trigger detection", (envVar, value) => {
    withEnv({ [envVar]: value });
    expect(detectAgent()).toBeUndefined();
  });

  // ── GitHub Copilot ─────────────────────────────────────────────────

  test("COPILOT_MODEL → github-copilot", () => {
    withEnv({ COPILOT_MODEL: "gpt-4" });
    expect(detectAgent()).toEqual(named("github-copilot"));
  });

  test("COPILOT_ALLOW_ALL → github-copilot", () => {
    withEnv({ COPILOT_ALLOW_ALL: "1" });
    expect(detectAgent()).toEqual(named("github-copilot"));
  });

  // ── Goose ──────────────────────────────────────────────────────────

  test("GOOSE_TERMINAL → goose", () => {
    withEnv({ GOOSE_TERMINAL: "1" });
    expect(detectAgent()).toEqual(named("goose"));
  });

  // ── Amp ────────────────────────────────────────────────────────────

  test("AMP_THREAD_ID → amp", () => {
    withEnv({ AMP_THREAD_ID: "thread-456" });
    expect(detectAgent()).toEqual(named("amp"));
  });

  // ── AGENT generic fallback ─────────────────────────────────────────

  test("AGENT as generic fallback", () => {
    withEnv({ AGENT: "some-new-agent" });
    expect(detectAgent()).toEqual(named("some-new-agent"));
  });

  test("AGENT is trimmed", () => {
    withEnv({ AGENT: "  goose  " });
    expect(detectAgent()).toEqual(named("goose"));
  });

  test("AGENT empty string is ignored", () => {
    withEnv({ AGENT: "" });
    expect(detectAgent()).toBeUndefined();
  });

  test("specific env vars take priority over AGENT", () => {
    withEnv({ AGENT: "goose", CLAUDE_CODE: "1" });
    expect(detectAgent()).toEqual(named("claude"));
  });

  test("AGENT garbage value '1' becomes unknown", () => {
    withEnv({ AGENT: "1" });
    expect(detectAgent()).toEqual(named("unknown"));
  });

  test("AGENT falsy value 'false' is treated as no agent", () => {
    withEnv({ AGENT: "false" });
    expect(detectAgent()).toBeUndefined();
  });

  test("AGENT compound value is normalized", () => {
    withEnv({ AGENT: "my-agent/1.0.0" });
    expect(detectAgent()).toEqual({ name: "my-agent", version: "1.0.0" });
  });

  test.each([
    ["claude_code", "claude"],
    ["codex_cli", "codex"],
    ["gemini_cli", "gemini"],
    ["open_code", "opencode"],
    ["cursor-cli", "cursor"],
    ["augment-cli", "augment"],
  ])("%s identifies %s through AI_AGENT and AGENT", (alias, name) => {
    for (const envVar of ["AI_AGENT", "AGENT"]) {
      withEnv({ [envVar]: `${alias}/1.2.3/agent` });
      expect(detectAgent()).toEqual({ name, version: "1.2.3", role: "agent" });
    }
  });

  // ── No agent ───────────────────────────────────────────────────────

  test("no env vars → undefined", () => {
    withEnv({});
    expect(detectAgent()).toBeUndefined();
  });
});

describe("ENV_VAR_AGENTS map structure", () => {
  test("is a Map instance", () => {
    expect(ENV_VAR_AGENTS).toBeInstanceOf(Map);
  });

  test("all values are non-empty strings", () => {
    for (const [envVar, agent] of ENV_VAR_AGENTS) {
      expect(envVar.length).toBeGreaterThan(0);
      expect(agent.length).toBeGreaterThan(0);
    }
  });

  test("env var keys are UPPER_SNAKE_CASE", () => {
    for (const envVar of ENV_VAR_AGENTS.keys()) {
      expect(envVar).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  test("agent names are lowercase with optional hyphens", () => {
    for (const agent of ENV_VAR_AGENTS.values()) {
      expect(agent).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});

describe("PROCESS_NAME_AGENTS map structure", () => {
  test("is a Map instance", () => {
    expect(PROCESS_NAME_AGENTS).toBeInstanceOf(Map);
  });

  test("all keys are lowercase", () => {
    for (const name of PROCESS_NAME_AGENTS.keys()) {
      expect(name).toBe(name.toLowerCase());
    }
  });

  test("agent names are lowercase with optional hyphens", () => {
    for (const agent of PROCESS_NAME_AGENTS.values()) {
      expect(agent).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});

describe("detectAgentFromProcessTree", () => {
  afterEach(() => {
    setProcessInfoProvider(getProcessInfoFromOS);
  });

  test("returns agent when parent matches", async () => {
    setProcessInfoProvider(async (pid) => {
      if (pid === process.ppid) {
        return { name: "cursor", ppid: 1 };
      }
    });
    expect(await detectAgentFromProcessTree()).toEqual(named("cursor"));
  });

  test("walks up to grandparent", async () => {
    const shellPid = 100;
    setProcessInfoProvider(async (pid) => {
      // parent is bash, grandparent is cursor
      if (pid === process.ppid) {
        return { name: "bash", ppid: shellPid };
      }
      if (pid === shellPid) {
        return { name: "Cursor", ppid: 1 };
      }
    });
    expect(await detectAgentFromProcessTree()).toEqual(named("cursor"));
  });

  test("case-insensitive matching", async () => {
    setProcessInfoProvider(async (pid) => {
      if (pid === process.ppid) {
        return { name: "Claude", ppid: 1 };
      }
    });
    expect(await detectAgentFromProcessTree()).toEqual(named("claude"));
  });

  test("returns undefined when no agent in tree", async () => {
    setProcessInfoProvider(async (pid) => {
      if (pid === process.ppid) {
        return { name: "bash", ppid: 1 };
      }
    });
    expect(await detectAgentFromProcessTree()).toBeUndefined();
  });

  test("stops at PID 1 (init/launchd)", async () => {
    setProcessInfoProvider(async (pid) => {
      if (pid === process.ppid) {
        return { name: "bash", ppid: 1 };
      }
      // PID 1 should not be checked
      if (pid === 1) {
        return { name: "cursor", ppid: 0 };
      }
    });
    expect(await detectAgentFromProcessTree()).toBeUndefined();
  });

  test("stops when getProcessInfo returns undefined", async () => {
    setProcessInfoProvider(noProcessInfo);
    expect(await detectAgentFromProcessTree()).toBeUndefined();
  });

  test("respects max depth", async () => {
    // Create a chain deeper than MAX_ANCESTOR_DEPTH (5)
    let nextPid = process.ppid;
    const chain = new Map<number, { name: string; ppid: number }>();
    for (let i = 0; i < 10; i++) {
      const ppid = nextPid + 1;
      chain.set(nextPid, { name: "bash", ppid });
      nextPid = ppid;
    }
    // Put cursor at depth 8 (beyond the limit)
    chain.set(nextPid, { name: "cursor", ppid: 1 });

    setProcessInfoProvider(async (pid) => chain.get(pid));
    expect(await detectAgentFromProcessTree()).toBeUndefined();
  });
});

describe("normalizeAgent", () => {
  test("simple name passes through lowercase", () => {
    expect(normalizeAgent("cursor")).toEqual(named("cursor"));
  });

  test("uppercased name is lowercased", () => {
    expect(normalizeAgent("Cursor")).toEqual(named("cursor"));
  });

  test("whitespace is trimmed", () => {
    expect(normalizeAgent("  cursor  ")).toEqual(named("cursor"));
  });

  test("empty string returns undefined", () => {
    expect(normalizeAgent("")).toBeUndefined();
  });

  test("whitespace-only returns undefined", () => {
    expect(normalizeAgent("   ")).toBeUndefined();
  });

  test("claude-code resolves to claude", () => {
    expect(normalizeAgent("claude-code")).toEqual(named("claude"));
  });

  test("claudecode resolves to claude", () => {
    expect(normalizeAgent("claudecode")).toEqual(named("claude"));
  });

  test("Claude-Code resolves to claude (case-insensitive)", () => {
    expect(normalizeAgent("Claude-Code")).toEqual(named("claude"));
  });

  test("name/version extracts both", () => {
    expect(normalizeAgent("cursor/1.2.3")).toEqual({
      name: "cursor",
      version: "1.2.3",
    });
  });

  test("name/version/role extracts all three", () => {
    expect(normalizeAgent("claude-code/2.1.123/agent")).toEqual({
      name: "claude",
      version: "2.1.123",
      role: "agent",
    });
  });

  test("version with v prefix strips the v", () => {
    expect(normalizeAgent("my-agent/v3.0.0")).toEqual({
      name: "my-agent",
      version: "3.0.0",
    });
  });

  test("non-semver second segment is ignored", () => {
    expect(normalizeAgent("my-agent/not-a-version")).toEqual(named("my-agent"));
  });

  test("single-number version is accepted", () => {
    expect(normalizeAgent("agent/42")).toEqual({
      name: "agent",
      version: "42",
    });
  });

  test("four-segment version is accepted", () => {
    expect(normalizeAgent("agent/1.2.3.4")).toEqual({
      name: "agent",
      version: "1.2.3.4",
    });
  });

  test("garbage role is dropped", () => {
    expect(normalizeAgent("agent/1.0.0/true")).toEqual({
      name: "agent",
      version: "1.0.0",
    });
  });

  test("extra slash segments beyond role are ignored", () => {
    expect(normalizeAgent("agent/1.0.0/role/extra")).toEqual({
      name: "agent",
      version: "1.0.0",
      role: "role",
    });
  });

  test("'1' becomes unknown", () => {
    expect(normalizeAgent("1")).toEqual(named("unknown"));
  });

  test("'true' becomes unknown", () => {
    expect(normalizeAgent("true")).toEqual(named("unknown"));
  });

  test("'yes' becomes unknown", () => {
    expect(normalizeAgent("yes")).toEqual(named("unknown"));
  });

  test("'on' becomes unknown", () => {
    expect(normalizeAgent("on")).toEqual(named("unknown"));
  });

  test("'TRUE' (uppercase) becomes unknown", () => {
    expect(normalizeAgent("TRUE")).toEqual(named("unknown"));
  });

  test("'0' returns undefined", () => {
    expect(normalizeAgent("0")).toBeUndefined();
  });

  test("'false' returns undefined", () => {
    expect(normalizeAgent("false")).toBeUndefined();
  });

  test("'no' returns undefined", () => {
    expect(normalizeAgent("no")).toBeUndefined();
  });

  test("'off' returns undefined", () => {
    expect(normalizeAgent("off")).toBeUndefined();
  });

  test("'FALSE' (uppercase) returns undefined", () => {
    expect(normalizeAgent("FALSE")).toBeUndefined();
  });
});

describe("AGENT_ALIASES map structure", () => {
  test("all keys are lowercase", () => {
    for (const key of AGENT_ALIASES.keys()) {
      expect(key).toBe(key.toLowerCase());
    }
  });

  test("all values are lowercase with optional hyphens", () => {
    for (const value of AGENT_ALIASES.values()) {
      expect(value).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  test("no alias maps to itself", () => {
    for (const [key, value] of AGENT_ALIASES) {
      expect(key).not.toBe(value);
    }
  });
});

describe("getProcessInfoFromOS", () => {
  test("returns info for own process", async () => {
    const info = await getProcessInfoFromOS(process.pid);
    expect(info).toBeDefined();
    if (info) {
      expect(info.name.length).toBeGreaterThan(0);
      expect(info.ppid).toBeGreaterThan(0);
    }
  });

  test("returns info for parent process", async () => {
    const info = await getProcessInfoFromOS(process.ppid);
    expect(info).toBeDefined();
    if (info) {
      expect(info.name.length).toBeGreaterThan(0);
      expect(info.ppid).toBeGreaterThanOrEqual(0);
    }
  });

  test("returns undefined for non-existent PID", async () => {
    const info = await getProcessInfoFromOS(99_999_999);
    expect(info).toBeUndefined();
  });

  test("returns undefined for PID 0", async () => {
    const info = await getProcessInfoFromOS(0);
    expect(info).toBeUndefined();
  });
});
