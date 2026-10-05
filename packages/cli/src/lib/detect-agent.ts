/**
 * AI agent detection — determines whether the CLI is being driven by
 * a specific AI coding agent.
 *
 * Detection uses two strategies:
 * 1. **Environment variables** (sync) — agents inject these into child
 *    processes. Selected rules adapted from Vercel's detect-agent v1.2.0
 *    (Apache-2.0): https://github.com/vercel/detect-agent/tree/3ab1df1
 * 2. **Process tree walking** (async) — scan parent/grandparent process
 *    names for known agent executables. Runs as a non-blocking background
 *    task so it never delays CLI startup.
 *
 * To add a new agent, add entries to {@link ENV_VAR_AGENTS} and/or
 * {@link PROCESS_NAME_AGENTS}.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { getEnv } from "./env.js";
import { logger } from "./logger.js";

/** Structured agent identity returned by detection functions. */
export type AgentInfo = {
  /** Canonical agent family name (e.g. "claude", "cursor", "unknown"). */
  name: string;
  /** Semver-ish version extracted from compound values (e.g. "2.1.123"). */
  version?: string;
  /** Role/variant extracted from compound values (e.g. "agent"). */
  role?: string;
};

/**
 * Canonical name aliases — maps alternative agent identifiers to their
 * canonical family name. Checked after lowercasing.
 */
export const AGENT_ALIASES = new Map<string, string>([
  ["claude-code", "claude"],
  ["claudecode", "claude"],
  ["claude_code", "claude"],
  ["codex_cli", "codex"],
  ["gemini_cli", "gemini"],
  ["open_code", "opencode"],
  ["cursor-cli", "cursor"],
  ["augment-cli", "augment"],
]);

/** Truthy boolean-ish values — signal "an agent is present" but don't name it. */
const TRUTHY_GARBAGE_RE = /^(1|true|yes|on)$/;

/** Falsy boolean-ish values — signal "no agent" / explicit opt-out. */
const FALSY_GARBAGE_RE = /^(0|false|no|off)$/;

/** Semver-ish: one or more dot-separated digit groups, optional leading `v`. */
const VERSION_RE = /^v?\d+(\.\d+)*$/;

/** Matches a leading `v` prefix on version strings. */
const VERSION_V_PREFIX_RE = /^v/;

/**
 * Normalize a raw agent string into structured {@link AgentInfo}.
 *
 * Handles compound slash-separated values (e.g. `"claude-code/2.1.123/agent"`),
 * alias resolution, and garbage detection.
 *
 * Boolean-ish values are split into two classes:
 * - **Falsy** (`false`, `no`, `0`, `off`) → `undefined` — explicit opt-out,
 *   treated as "no agent present."
 * - **Truthy** (`1`, `true`, `yes`, `on`) → `{ name: "unknown" }` — an agent
 *   is active but didn't identify itself.
 *
 * When a truthy/falsy name appears in a compound value (e.g. `"true/1.0.0/agent"`),
 * version and role segments are discarded — the name alone determines the outcome.
 *
 * Empty strings, whitespace-only strings, and leading-slash inputs (where the
 * first segment is empty) also return `undefined`.
 */
export function normalizeAgent(raw: string): AgentInfo | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return;
  }

  const segments = trimmed.split("/");
  const rawName = (segments[0] ?? "").toLowerCase();

  // Resolve aliases
  const name = AGENT_ALIASES.get(rawName) ?? rawName;

  // Falsy opt-out — "no agent" signal, treat as not detected
  if (!name || FALSY_GARBAGE_RE.test(name)) {
    return;
  }

  // Truthy garbage — agent is present but unnamed
  if (TRUTHY_GARBAGE_RE.test(name)) {
    return { name: "unknown" };
  }

  const result: AgentInfo = { name };

  // Extract version from second segment if it looks semver-ish
  const rawVersion = segments[1]?.trim();
  if (rawVersion && VERSION_RE.test(rawVersion)) {
    result.version = rawVersion.replace(VERSION_V_PREFIX_RE, "");
  }

  // Extract role from third segment if present and non-empty
  const rawRole = segments[2]?.trim().toLowerCase();
  if (
    rawRole &&
    !TRUTHY_GARBAGE_RE.test(rawRole) &&
    !FALSY_GARBAGE_RE.test(rawRole)
  ) {
    result.role = rawRole;
  }

  return result;
}

/**
 * Env var → agent name. Checked in insertion order — first match wins.
 * Each env var maps directly to the agent that sets it.
 */
export const ENV_VAR_AGENTS = new Map<string, string>([
  // Cursor
  ["CURSOR_TRACE_ID", "cursor"],
  ["CURSOR_AGENT", "cursor"],
  // Kimi Code plugin hooks — KIMI_CODE_HOME can be set outside a session
  ["KIMI_PLUGIN_ROOT", "kimi"],
  // Grok plugin hooks must win over Claude compatibility markers
  ["GROK_PLUGIN_ROOT", "grok"],
  ["GROK_PLUGIN_DATA", "grok"],
  // Gemini CLI
  ["GEMINI_CLI", "gemini"],
  // Cline
  ["CLINE_ACTIVE", "cline"],
  // OpenAI Codex
  ["CODEX_SANDBOX", "codex"],
  ["CODEX_CI", "codex"],
  ["CODEX_THREAD_ID", "codex"],
  ["CODEX_SANDBOX_NETWORK_DISABLED", "codex"],
  // Antigravity
  ["ANTIGRAVITY_AGENT", "antigravity"],
  ["ANTIGRAVITY_CLI_ALIAS", "antigravity"],
  // Augment
  ["AUGMENT_AGENT", "augment"],
  // OpenCode
  ["OPENCODE_CLIENT", "opencode"],
  ["OPENCODE", "opencode"],
  // Junie
  ["JUNIE_DATA", "junie"],
  ["JUNIE_SHIM_PATH", "junie"],
  // OpenClaw
  ["OPENCLAW_SHELL", "openclaw"],
  // Replit — REPL_ID intentionally excluded because it's set in ALL Replit
  // workspaces, not just when the AI agent is driving the CLI
  // GitHub Copilot — COPILOT_GITHUB_TOKEN intentionally excluded because
  // users may export it persistently for auth, causing false positives
  ["COPILOT_MODEL", "github-copilot"],
  ["COPILOT_ALLOW_ALL", "github-copilot"],
  // Goose — GOOSE_PROVIDER can be persistent configuration in a human shell
  ["GOOSE_TERMINAL", "goose"],
  // Amp
  ["AMP_THREAD_ID", "amp"],
]);

/**
 * Process executable basename (lowercase) → agent name.
 * Used when scanning the parent process tree as a fallback.
 */
export const PROCESS_NAME_AGENTS = new Map<string, string>([
  ["cursor", "cursor"],
  ["claude", "claude"],
  ["goose", "goose"],
  ["windsurf", "windsurf"],
  ["amp", "amp"],
  ["codex", "codex"],
  ["augment", "augment"],
  ["opencode", "opencode"],
  ["gemini", "gemini"],
]);

/** Max levels to walk up the process tree before giving up. */
const MAX_ANCESTOR_DEPTH = 5;

/** Pattern to extract `Name:` from `/proc/<pid>/status`. */
const PROC_STATUS_NAME_RE = /^Name:\s+(.+)$/m;

/** Pattern to extract `PPid:` from `/proc/<pid>/status`. */
const PROC_STATUS_PPID_RE = /^PPid:\s+(\d+)$/m;

/** Pattern to parse `ps -o ppid=,comm=` output: "  <ppid> <comm>". */
const PS_PPID_COMM_RE = /^(\d+)\s+(.+)$/;

/** Name + parent PID of a process. */
type ProcessInfo = {
  /** Basename of the executable (e.g. "cursor", "bash"). */
  name: string;
  /** Parent process ID, or 0 if unavailable. */
  ppid: number;
};

/**
 * Async process info provider signature. Default reads from `/proc/` or `ps(1)`.
 * Override via {@link setProcessInfoProvider} for testing.
 */
type ProcessInfoProvider = (pid: number) => Promise<ProcessInfo | undefined>;

let _getProcessInfo: ProcessInfoProvider = getProcessInfoFromOS;

/**
 * Override the process info provider. Follows the same pattern as
 * {@link setEnv} — call with a mock in tests, reset in `afterEach`.
 *
 * Pass `getProcessInfoFromOS` to restore the real implementation.
 */
export function setProcessInfoProvider(provider: ProcessInfoProvider): void {
  _getProcessInfo = provider;
}

/**
 * Detect agent from environment variables only (synchronous, no I/O).
 *
 * Priority:
 * 1. `AI_AGENT` env var — explicit override, any agent can self-identify
 * 2. Cursor's exact agent-exec role, then env vars from {@link ENV_VAR_AGENTS}
 * 3. Claude Code with Cowork variant (conditional, can't be in the map)
 * 4. `AGENT` env var — generic fallback set by Goose, Amp, and others
 *
 * Returns structured {@link AgentInfo}, or `undefined` if no agent is detected.
 * All return paths go through {@link normalizeAgent} for consistent output.
 * For process tree fallback, use {@link detectAgentFromProcessTree} separately.
 */
export function detectAgent(): AgentInfo | undefined {
  const env = getEnv();

  // 1. Highest priority: explicit override — any agent can self-identify.
  //    normalizeAgent returns undefined for falsy opt-outs ("false", "0"),
  //    which should fall through to the next detection level.
  const aiAgent = env.AI_AGENT?.trim();
  if (aiAgent) {
    const normalized = normalizeAgent(aiAgent);
    if (normalized) {
      return normalized;
    }
  }

  // The role marker also exists outside agent execution; only this value
  // identifies an agent. Check before the map to retain Cursor's priority.
  if (env.CURSOR_EXTENSION_HOST_ROLE === "agent-exec") {
    return normalizeAgent("cursor");
  }

  // 2. Table-driven env var check (Map iteration preserves insertion order).
  //    These values are our own clean strings — normalizeAgent won't return undefined.
  for (const [envVar, agent] of ENV_VAR_AGENTS) {
    if (env[envVar]) {
      return normalizeAgent(agent);
    }
  }

  // 3. Claude Code / Cowork — requires branching logic, so not in the map
  if (env.CLAUDECODE || env.CLAUDE_CODE) {
    return normalizeAgent(env.CLAUDE_CODE_IS_COWORK ? "cowork" : "claude");
  }

  // 4. Lowest priority: generic AGENT fallback
  const agentValue = env.AGENT?.trim();
  if (agentValue) {
    return normalizeAgent(agentValue);
  }

  return;
}

/**
 * Walk the ancestor process tree looking for known agent executables.
 *
 * Fully async — never blocks CLI startup. Starts at the direct parent
 * (`process.ppid`) and walks up to {@link MAX_ANCESTOR_DEPTH} levels.
 * Stops at PID 1 (init/launchd) or on any read error.
 *
 * - **Linux**: reads `/proc/<pid>/status` (in-memory filesystem, fast).
 * - **macOS**: uses `ps(1)` with a 500ms timeout per invocation.
 * - **Windows**: not supported (env var detection still works).
 */
export async function detectAgentFromProcessTree(): Promise<
  AgentInfo | undefined
> {
  let pid = process.ppid;

  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && pid > 1; depth++) {
    const info = await _getProcessInfo(pid);
    if (!info) {
      break;
    }

    const agent = PROCESS_NAME_AGENTS.get(info.name.toLowerCase());
    if (agent) {
      return normalizeAgent(agent);
    }

    pid = info.ppid;
  }

  return;
}

/**
 * Read process name and parent PID for a given PID.
 *
 * Tries `/proc/<pid>/status` first (Linux, no subprocess overhead),
 * falls back to `ps(1)` (macOS and other Unix systems).
 * Windows is unsupported — returns `undefined`.
 */
const log = logger.withTag("detect-agent");

export async function getProcessInfoFromOS(
  pid: number
): Promise<ProcessInfo | undefined> {
  // Linux: /proc is an in-memory filesystem — fast even though async
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf-8");
    const nameMatch = status.match(PROC_STATUS_NAME_RE);
    const ppidMatch = status.match(PROC_STATUS_PPID_RE);
    if (nameMatch?.[1] && ppidMatch?.[1]) {
      return { name: nameMatch[1].trim(), ppid: Number(ppidMatch[1]) };
    }
  } catch (error) {
    log.debug(`Could not read /proc/${pid}/status`, error);
  }

  // macOS / other Unix: use ps(1) asynchronously
  if (process.platform !== "win32") {
    try {
      const result = await execFileUnreffed(
        "ps",
        ["-p", String(pid), "-o", "ppid=,comm="],
        { timeout: 500 }
      );
      const match = result.trim().match(PS_PPID_COMM_RE);
      if (match?.[1] && match?.[2]) {
        return { name: basename(match[2].trim()), ppid: Number(match[1]) };
      }
    } catch (error) {
      log.debug(`Could not query ps for pid ${pid}`, error);
    }
  }
}

/**
 * Spawn `execFile` with the child process unreffed so it never
 * prevents the CLI from exiting. Resolves with stdout on success.
 */
function execFileUnreffed(
  cmd: string,
  args: readonly string[],
  opts: { timeout?: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { encoding: "utf-8", ...opts },
      (err, stdout) => {
        if (err) {
          reject(err);
        } else {
          resolve(stdout);
        }
      }
    );
    child.unref();
  });
}
