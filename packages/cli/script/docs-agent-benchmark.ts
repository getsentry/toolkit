#!/usr/bin/env tsx
/**
 * Agent benchmark for `sentry docs`: time and tokens to finish real tasks.
 *
 * Each task in `docs-agent-benchmark.json` is a small repository and a
 * request phrased the way a person asks a coding agent ("Report errors from
 * this Phoenix app to Sentry"). A coding agent, Claude Code or Codex
 * (`--agent`), runs every task twice, in a fresh copy of the repository,
 * with the same tools. The only difference is one line about where Sentry
 * documentation comes from:
 *
 * - `web`: "For Sentry documentation, fetch docs from the web."
 * - `cli`: "For Sentry documentation, use the `sentry docs` command."
 *
 * The agent decides when it knows enough. Afterwards the repository is graded
 * with the task's checks (the right package, init call, or config), and the
 * run's wall time and tokens come from the agent's own report. Claude Code
 * reports its cost; for Codex the cost is priced from the AI Gateway's
 * public model list.
 * Tokens include every page the agent read along the way, so a detour
 * through the wrong pages shows up as cost even when the result is right.
 *
 * Runs are isolated from the machine's agent setup: a fresh config directory
 * per run (no CLAUDE.md, AGENTS.md, memory, or login), no settings files, no
 * MCP servers, and no skills, so nothing such as a Sentry docs MCP server
 * or the sentry-cli skill leaks into either arm. The `web` arm also runs
 * without any `sentry` that is already on the PATH.
 *
 * Requirements:
 * - Claude Code (`claude`, or CLAUDE_BIN) with ANTHROPIC_API_KEY, or an
 *   Anthropic-compatible gateway through ANTHROPIC_BASE_URL and
 *   ANTHROPIC_AUTH_TOKEN (for example `https://ai-gateway.vercel.sh`).
 * - Codex (`codex`, or CODEX_BIN) with OPENAI_API_KEY, or AI_GATEWAY_API_KEY
 *   to go through the Vercel AI Gateway.
 * - For the `cli` arm, the bundled CLI (`pnpm run bundle`) or
 *   SENTRY_CLI_BINARY.
 *
 * Usage:
 *   pnpm run bench:docs-agent                          # every task, both arms
 *   pnpm run bench:docs-agent -- --runs 3              # repeat to average out noise
 *   pnpm run bench:docs-agent -- --agent codex         # Codex instead of Claude Code
 *   pnpm run bench:docs-agent -- --tasks hono-cloudflare,php-plain
 *   pnpm run bench:docs-agent -- --json results.json   # save every run
 */

import { execFileSync, spawn } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

type Check = { readonly file: string; readonly pattern: string };

type AgentTask = {
  readonly id: string;
  readonly tier: "common" | "niche";
  readonly platform: string;
  readonly request: string;
  readonly files: Readonly<Record<string, string>>;
  readonly checks: readonly Check[];
};

type Arm = "web" | "cli";

type Agent = "claude" | "codex";

type DocsStep = { readonly tool: string; readonly target: string };

/** What one agent run reports, before grading. */
type AgentReport = {
  readonly seconds: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly turns: number;
  readonly docsSteps: readonly DocsStep[];
  readonly error?: string;
};

type RunResult = AgentReport & {
  readonly agent: Agent;
  readonly task: string;
  readonly tier: AgentTask["tier"];
  readonly arm: Arm;
  readonly run: number;
  readonly passed: boolean;
  readonly failedChecks: readonly string[];
};

const ARMS: readonly Arm[] = ["web", "cli"];

const DOCS_REMARK: Record<Arm, string> = {
  web: "For Sentry documentation, fetch docs from the web.",
  cli: "For Sentry documentation, use the `sentry docs` command.",
};

/**
 * Shared by both arms. The sandbox has no package managers, so the agent
 * edits manifests instead of installing, which also keeps grading on files.
 */
const SHARED_PROMPT =
  "You are working in a small repository. Package managers and builds are not available here, so add dependencies to the manifest files by hand. Assume the Sentry DSN comes from an environment variable.";

/**
 * Claude Code gets the same tools and permissions in both arms, including a
 * shell, as in a normal coding session; only the `cli` arm has `sentry` on
 * its PATH, and the `web` arm is also denied any `sentry` already installed.
 * Installs are denied so both arms edit manifests by hand. Codex has no
 * command deny list, so it relies on the shared prompt for installs.
 */
const TOOLS = "Read,Edit,Write,Glob,Grep,WebSearch,WebFetch,Bash";
const DENIED = [
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "pip",
  "pip3",
  "uv",
  "composer",
  "bundle",
  "gem",
  "mix",
  "go",
  "cargo",
  "dotnet",
  "gradle",
  "flutter",
  "dart",
]
  .map((command) => `Bash(${command}:*)`)
  .join(",");
const DENIED_BY_ARM: Record<Arm, string> = {
  web: `${DENIED},Bash(sentry:*)`,
  cli: DENIED,
};

/** A docs.sentry.io URL in a shell command, such as `curl https://docs.sentry.io/…`. */
const DOCS_URL_RE = /\bhttps?:\/\/docs\.sentry\.io(?=[/\s"'`]|$)/;

const { values } = parseArgs({
  // pnpm passes the `--` of `pnpm run bench:docs-agent -- --runs 3` through.
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    tasks: { type: "string" },
    arms: { type: "string", default: ARMS.join(",") },
    runs: { type: "string", default: "1" },
    agent: { type: "string", default: "claude" },
    model: { type: "string" },
    concurrency: { type: "string", default: "4" },
    "budget-usd": { type: "string", default: "2" },
    "timeout-s": { type: "string", default: "900" },
    json: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});

const allTasks = (
  JSON.parse(
    readFileSync(
      new URL("./docs-agent-benchmark.json", import.meta.url),
      "utf8",
    ),
  ) as { tasks: AgentTask[] }
).tasks;
const wanted = values.tasks?.split(",");
const tasks = wanted
  ? allTasks.filter((task) => wanted.includes(task.id))
  : allTasks;
const arms = (values.arms ?? "")
  .split(",")
  .filter((arm): arm is Arm => ARMS.includes(arm as Arm));
const runs = Number(values.runs);
const concurrency = Number(values.concurrency);
const timeoutMs = Number(values["timeout-s"]) * 1000;
const agent = values.agent as Agent;
const viaGateway = Boolean(process.env.AI_GATEWAY_API_KEY);
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1";

if (tasks.length === 0 || arms.length === 0) {
  throw new Error("No tasks or arms selected.");
}
if (agent !== "claude" && agent !== "codex") {
  throw new Error(`--agent must be claude or codex, not ${values.agent}.`);
}
if (
  agent === "claude" &&
  !(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
) {
  throw new Error(
    "Set ANTHROPIC_API_KEY, or ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN: each run uses a fresh Claude Code config directory, so a login does not carry over.",
  );
}
if (agent === "codex" && !(viaGateway || process.env.OPENAI_API_KEY)) {
  throw new Error(
    "Set OPENAI_API_KEY, or AI_GATEWAY_API_KEY for the Vercel AI Gateway: each run uses a fresh Codex home, so a login does not carry over.",
  );
}
const model =
  values.model ??
  (agent === "claude" ? "sonnet" : viaGateway ? "openai/gpt-5.5" : "gpt-5.5");

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The PATH for an arm: without any directory that has a `sentry`, and with
 * this checkout's `sentry` first for the `cli` arm.
 */
function pathFor(arm: Arm, binDir: string): string {
  const kept = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir && !isExecutable(join(dir, "sentry")));
  return (arm === "cli" ? [binDir, ...kept] : kept).join(delimiter);
}

/** A directory with a `sentry` that runs this checkout's CLI. */
function sentryBinDir(): string {
  const cli = process.env.SENTRY_CLI_BINARY
    ? resolve(process.env.SENTRY_CLI_BINARY)
    : resolve(dirname(new URL(import.meta.url).pathname), "../dist/bin.cjs");
  if (!existsSync(cli)) {
    throw new Error(
      `${cli} does not exist; run \`pnpm run bundle\` or set SENTRY_CLI_BINARY.`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "sentry-bin-"));
  const runner = cli.endsWith(".cjs") || cli.endsWith(".js") ? "node " : "";
  writeFileSync(
    join(dir, "sentry"),
    `#!/bin/sh\nexec ${runner}"${cli}" "$@"\n`,
  );
  chmodSync(join(dir, "sentry"), 0o755);
  return dir;
}

function writeRepo(task: AgentTask): string {
  const dir = mkdtempSync(join(tmpdir(), `docs-bench-${task.id}-`));
  for (const [path, content] of Object.entries(task.files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

/** The checks that no file in the repository satisfies. */
function failedChecks(task: AgentTask, dir: string): string[] {
  const files = listFiles(dir).map((path) => ({
    path: relative(dir, path),
    content: readFileSync(path, "utf8"),
  }));
  return task.checks
    .filter(({ file, pattern }) => {
      const fileRe = new RegExp(file);
      const contentRe = new RegExp(pattern, "m");
      return !files.some(
        (candidate) =>
          fileRe.test(candidate.path) && contentRe.test(candidate.content),
      );
    })
    .map(({ file, pattern }) => `${file || "*"} ~ ${pattern}`);
}

type StreamEvent = {
  type?: string;
  message?: {
    content?: {
      type?: string;
      name?: string;
      input?: Record<string, unknown>;
    }[];
  };
  is_error?: boolean;
  duration_ms?: number;
  total_cost_usd?: number;
  num_turns?: number;
  result?: string;
  usage?: Record<string, number | undefined>;
  modelUsage?: Record<string, Record<string, number | undefined>>;
};

/** A docs step from a tool call, or nothing for other tools. */
function docsStep(
  name: string,
  input: Record<string, unknown> = {},
): DocsStep | undefined {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  if (name === "WebFetch" || name === "WebSearch") {
    return { tool: name, target: text(input.url) || text(input.query) };
  }
  const command = text(input.command);
  if (name === "Bash" && command.includes("sentry docs")) {
    return { tool: "sentry docs", target: command };
  }
  if (name === "Bash" && DOCS_URL_RE.test(command)) {
    return { tool: "Bash fetch", target: command };
  }
  return;
}

/** Input and output tokens across every model the run used. */
function tokens(result: StreamEvent): { input: number; output: number } {
  const perModel = Object.values(result.modelUsage ?? {});
  const usages = perModel.length > 0 ? perModel : [result.usage ?? {}];
  let input = 0;
  let output = 0;
  for (const usage of usages) {
    input +=
      (usage.inputTokens ?? usage.input_tokens ?? 0) +
      (usage.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? 0) +
      (usage.cacheCreationInputTokens ??
        usage.cache_creation_input_tokens ??
        0);
    output += usage.outputTokens ?? usage.output_tokens ?? 0;
  }
  return { input, output };
}

type Spawned = { stdout: string; seconds: number; error?: string };

/** Run an agent CLI to completion, or until the timeout. */
function spawnAgent(
  bin: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Spawned> {
  const started = performance.now();
  return new Promise((done) => {
    // Agents in print mode wait for stdin to close, so give them none.
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    let finished = false;
    const finish = (error: string | undefined) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      done({ stdout, seconds: (performance.now() - started) / 1000, error });
    };
    // A missing or unstartable agent fails this run, not the benchmark.
    child.on("error", (error) =>
      finish(`could not start ${bin}: ${error.message}`),
    );
    child.on("close", (code) =>
      finish(code === 0 ? undefined : `exit ${code}: ${stderr.slice(-300)}`),
    );
  });
}

function jsonLines<T>(stdout: string): T[] {
  const events: T[] = [];
  for (const line of stdout.split("\n")) {
    try {
      events.push(JSON.parse(line) as T);
    } catch {
      // Not an event line.
    }
  }
  return events;
}

async function runClaude(
  arm: Arm,
  task: AgentTask,
  dir: string,
  binDir: string,
): Promise<AgentReport> {
  const args = [
    "-p",
    task.request,
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--model",
    model,
    "--max-budget-usd",
    values["budget-usd"] ?? "2",
    "--permission-mode",
    "acceptEdits",
    "--tools",
    TOOLS,
    "--allowedTools",
    TOOLS,
    "--disallowedTools",
    DENIED_BY_ARM[arm],
    "--append-system-prompt",
    `${SHARED_PROMPT} ${DOCS_REMARK[arm]}`,
  ];
  const configDir = mkdtempSync(join(tmpdir(), "docs-bench-claude-"));
  const { stdout, seconds, error } = await spawnAgent(
    process.env.CLAUDE_BIN ?? "claude",
    args,
    dir,
    {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
      SENTRY_CLI_NO_TELEMETRY: "1",
      PATH: pathFor(arm, binDir),
    },
  );
  rmSync(configDir, { recursive: true, force: true });
  const events = jsonLines<StreamEvent>(stdout);
  const docsSteps = events
    .filter((event) => event.type === "assistant")
    .flatMap((event) => event.message?.content ?? [])
    .filter((block) => block.type === "tool_use" && block.name)
    .flatMap((block) => docsStep(block.name ?? "", block.input) ?? []);
  const result = events.find((event) => event.type === "result") ?? {};
  const { input, output } = tokens(result);
  return {
    seconds: result.duration_ms ? result.duration_ms / 1000 : seconds,
    inputTokens: input,
    outputTokens: output,
    costUsd: result.total_cost_usd ?? 0,
    turns: result.num_turns ?? 0,
    docsSteps,
    error: error ?? (result.is_error ? result.result : undefined),
  };
}

type CodexEvent = {
  type?: string;
  item?: { type?: string; command?: string; query?: string };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  error?: { message?: string };
  message?: string;
};

/** USD per token from the AI Gateway's public model list. */
type Pricing = { input: number; cachedInput: number; output: number };

async function codexPricing(): Promise<Pricing | undefined> {
  const id = model.includes("/") ? model : `openai/${model}`;
  try {
    const response = await fetch(`${GATEWAY_URL}/models`);
    const { data } = (await response.json()) as {
      data: { id: string; pricing?: Record<string, unknown> }[];
    };
    const pricing = data.find((entry) => entry.id === id)?.pricing;
    if (!pricing) {
      return;
    }
    return {
      input: Number(pricing.input),
      cachedInput: Number(pricing.input_cache_read ?? pricing.input),
      output: Number(pricing.output),
    };
  } catch {
    return;
  }
}

/** Codex settings for one run: the model provider and the docs remark. */
function writeCodexHome(arm: Arm): string {
  const home = mkdtempSync(join(tmpdir(), "docs-bench-codex-"));
  const provider = viaGateway
    ? { url: GATEWAY_URL, key: "AI_GATEWAY_API_KEY" }
    : { url: "https://api.openai.com/v1", key: "OPENAI_API_KEY" };
  writeFileSync(
    join(home, "config.toml"),
    [
      `model = "${model}"`,
      'model_provider = "bench"',
      "",
      "[model_providers.bench]",
      'name = "bench"',
      `base_url = "${provider.url}"`,
      `env_key = "${provider.key}"`,
      'wire_api = "responses"',
      "",
    ].join("\n"),
  );
  // Codex reads user instructions from $CODEX_HOME/AGENTS.md.
  writeFileSync(
    join(home, "AGENTS.md"),
    `${SHARED_PROMPT} ${DOCS_REMARK[arm]}\n`,
  );
  return home;
}

async function runCodex(
  arm: Arm,
  task: AgentTask,
  dir: string,
  binDir: string,
  pricing: Pricing | undefined,
): Promise<AgentReport> {
  const home = writeCodexHome(arm);
  const { stdout, seconds, error } = await spawnAgent(
    process.env.CODEX_BIN ?? "codex",
    [
      // Live web search, as Claude Code's WebSearch; a top-level flag.
      "--search",
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      // Each run already gets a throwaway copy of the repository.
      "--dangerously-bypass-approvals-and-sandbox",
      task.request,
    ],
    dir,
    {
      ...process.env,
      CODEX_HOME: home,
      // Keep skills and settings under the real home out of the run.
      HOME: home,
      SENTRY_CLI_NO_TELEMETRY: "1",
      PATH: pathFor(arm, binDir),
    },
  );
  rmSync(home, { recursive: true, force: true });
  const events = jsonLines<CodexEvent>(stdout);
  const items = events
    .filter((event) => event.type === "item.completed" && event.item)
    .map((event) => event.item ?? {});
  const docsSteps = items.flatMap((item): DocsStep[] => {
    if (item.type === "web_search") {
      return [{ tool: "web_search", target: item.query ?? "" }];
    }
    const step =
      item.type === "command_execution"
        ? docsStep("Bash", { command: item.command })
        : undefined;
    return step ? [step] : [];
  });
  let input = 0;
  let cached = 0;
  let output = 0;
  for (const event of events) {
    if (event.type === "turn.completed") {
      input += event.usage?.input_tokens ?? 0;
      cached += event.usage?.cached_input_tokens ?? 0;
      output += event.usage?.output_tokens ?? 0;
    }
  }
  const failure = events.find(
    (event) => event.type === "turn.failed" || event.type === "error",
  );
  return {
    seconds,
    inputTokens: input,
    outputTokens: output,
    costUsd: pricing
      ? (input - cached) * pricing.input +
        cached * pricing.cachedInput +
        output * pricing.output
      : 0,
    // Codex does not count model turns; count its tool calls instead.
    turns: items.filter(
      (item) =>
        item.type === "command_execution" || item.type === "file_change",
    ).length,
    docsSteps,
    error:
      error ??
      (failure
        ? (failure.error?.message ?? failure.message ?? "turn failed")
        : undefined),
  };
}

async function runOne(
  task: AgentTask,
  arm: Arm,
  run: number,
  binDir: string,
  pricing: Pricing | undefined,
): Promise<RunResult> {
  const dir = writeRepo(task);
  try {
    const report =
      agent === "claude"
        ? await runClaude(arm, task, dir, binDir)
        : await runCodex(arm, task, dir, binDir, pricing);
    const failed = failedChecks(task, dir);
    return {
      ...report,
      agent,
      task: task.id,
      tier: task.tier,
      arm,
      run,
      passed: failed.length === 0 && !report.error,
      failedChecks: failed,
    };
  } finally {
    if (!values.keep) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function pool<T>(
  jobs: readonly (() => Promise<T>)[],
  size: number,
): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      if (job) {
        results.push(await job());
      }
    }
  }
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

function median(numbers: readonly number[]): number {
  const sorted = [...numbers].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return 0;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function kTokens(count: number): string {
  return `${(count / 1000).toFixed(1)}k`;
}

function summarize(results: readonly RunResult[]): string {
  const lines: string[] = [];
  const row = (label: string, rows: readonly RunResult[]) => {
    const passed = rows.filter((result) => result.passed).length;
    lines.push(
      [
        label.padEnd(14),
        `pass ${passed}/${rows.length}`.padEnd(11),
        `median ${median(rows.map((r) => r.seconds)).toFixed(0)}s`.padEnd(12),
        `in ${kTokens(median(rows.map((r) => r.inputTokens)))}`.padEnd(11),
        `out ${kTokens(median(rows.map((r) => r.outputTokens)))}`.padEnd(11),
        `docs steps ${median(rows.map((r) => r.docsSteps.length))}`.padEnd(14),
        `cost $${rows.reduce((sum, r) => sum + r.costUsd, 0).toFixed(2)}`,
      ].join(""),
    );
  };
  for (const tier of ["all", "common", "niche"] as const) {
    if (tier !== "all" && !results.some((result) => result.tier === tier)) {
      continue;
    }
    lines.push(`\n${tier === "all" ? "All tasks" : `${tier} tasks`}`);
    for (const arm of arms) {
      row(
        arm,
        results.filter(
          (result) =>
            result.arm === arm && (tier === "all" || result.tier === tier),
        ),
      );
    }
  }
  lines.push("\nPer task (median of runs): pass, seconds, input tokens");
  for (const task of tasks) {
    const cells = arms.map((arm) => {
      const rows = results.filter((r) => r.task === task.id && r.arm === arm);
      const passed = rows.filter((r) => r.passed).length;
      return `${arm} ${passed}/${rows.length} ${median(rows.map((r) => r.seconds)).toFixed(0)}s ${kTokens(median(rows.map((r) => r.inputTokens)))}`.padEnd(
        26,
      );
    });
    lines.push(`  ${task.id.padEnd(22)}${cells.join("")}`);
  }
  const failures = results.filter((result) => !result.passed);
  if (failures.length > 0) {
    lines.push("\nFailed runs");
    for (const failure of failures) {
      lines.push(
        `  ${failure.task} ${failure.arm}#${failure.run}: ${failure.error ?? failure.failedChecks.join("; ")}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

const binDir = arms.includes("cli") ? sentryBinDir() : "";
const pricing = agent === "codex" ? await codexPricing() : undefined;
if (binDir) {
  // Download the docs index once, so the first run does not pay for it.
  execFileSync(join(binDir, "sentry"), ["docs", "sentry", "-n", "1"], {
    env: { ...process.env, SENTRY_CLI_NO_TELEMETRY: "1" },
    stdio: "ignore",
  });
}

const jobs = tasks.flatMap((task) =>
  arms.flatMap((arm) =>
    Array.from({ length: runs }, (_, run) => async () => {
      const result = await runOne(task, arm, run + 1, binDir, pricing);
      process.stderr.write(
        `${result.passed ? "pass" : "FAIL"} ${task.id} ${arm}#${run + 1} ${result.seconds.toFixed(0)}s ${kTokens(result.inputTokens)} in\n`,
      );
      return result;
    }),
  ),
);
const results = await pool(jobs, concurrency);
if (binDir) {
  rmSync(binDir, { recursive: true, force: true });
}

process.stdout.write(
  `${agent} with ${model}, ${tasks.length} tasks x ${arms.length} arms x ${runs} runs\n${summarize(results)}`,
);
if (values.json) {
  writeFileSync(values.json, `${JSON.stringify({ results }, null, 2)}\n`);
}
