#!/usr/bin/env tsx
/**
 * Agent benchmark for `sentry docs`: time and tokens to finish real tasks.
 *
 * Each task in `docs-agent-benchmark.json` is a small repository and a
 * request phrased the way a person asks a coding agent ("Report errors from
 * this Phoenix app to Sentry"). Claude Code runs every task twice, in a fresh
 * copy of the repository, with the same tools. The only difference is one
 * line about where Sentry documentation comes from:
 *
 * - `web`: "For Sentry documentation, fetch docs from the web."
 * - `cli`: "For Sentry documentation, use the `sentry docs` command."
 *
 * The agent decides when it knows enough. Afterwards the repository is graded
 * with the task's checks (the right package, init call, or config), and the
 * run's wall time, tokens, and cost come from Claude Code's own report.
 * Tokens include every page the agent read along the way, so a detour
 * through the wrong pages shows up as cost even when the result is right.
 *
 * Runs are isolated from the machine's Claude Code setup: a fresh config
 * directory per run (no CLAUDE.md, memory, or login), no settings files, no
 * MCP servers, and no skills, so nothing such as a Sentry docs MCP server
 * or the sentry-cli skill leaks into either arm.
 *
 * Requirements: Claude Code (`claude`, or CLAUDE_BIN) and ANTHROPIC_API_KEY.
 * The `cli` arm needs the bundled CLI (`pnpm run bundle`) or
 * SENTRY_CLI_BINARY.
 *
 * Usage:
 *   pnpm run bench:docs-agent                          # every task, both arms
 *   pnpm run bench:docs-agent -- --runs 3              # repeat to average out noise
 *   pnpm run bench:docs-agent -- --tasks hono-cloudflare,php-plain
 *   pnpm run bench:docs-agent -- --json results.json   # save every run
 */

import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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

type DocsStep = { readonly tool: string; readonly target: string };

type RunResult = {
  readonly task: string;
  readonly tier: AgentTask["tier"];
  readonly arm: Arm;
  readonly run: number;
  readonly passed: boolean;
  readonly failedChecks: readonly string[];
  readonly seconds: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly turns: number;
  readonly docsSteps: readonly DocsStep[];
  readonly error?: string;
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

/** The same tools for both arms; only `sentry docs` differs. */
const TOOLS = "Read,Edit,Write,Glob,Grep,WebSearch,WebFetch,Bash";
const ALLOWED: Record<Arm, string> = {
  web: "Read,Edit,Write,Glob,Grep,WebSearch,WebFetch",
  cli: "Read,Edit,Write,Glob,Grep,WebSearch,WebFetch,Bash(sentry docs:*)",
};

const { values } = parseArgs({
  // pnpm passes the `--` of `pnpm run bench:docs-agent -- --runs 3` through.
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    tasks: { type: "string" },
    arms: { type: "string", default: ARMS.join(",") },
    runs: { type: "string", default: "1" },
    model: { type: "string", default: "sonnet" },
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
const claudeBin = process.env.CLAUDE_BIN ?? "claude";

if (tasks.length === 0 || arms.length === 0) {
  throw new Error("No tasks or arms selected.");
}
if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error(
    "Set ANTHROPIC_API_KEY: each run uses a fresh Claude Code config directory, so a login does not carry over.",
  );
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

function runClaude(
  task: AgentTask,
  arm: Arm,
  dir: string,
  binDir: string | undefined,
): Promise<{ events: StreamEvent[]; seconds: number; error?: string }> {
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
    values.model ?? "sonnet",
    "--max-budget-usd",
    values["budget-usd"] ?? "2",
    "--permission-mode",
    "acceptEdits",
    "--tools",
    TOOLS,
    "--allowedTools",
    ALLOWED[arm],
    "--append-system-prompt",
    `${SHARED_PROMPT} ${DOCS_REMARK[arm]}`,
  ];
  const configDir = mkdtempSync(join(tmpdir(), "docs-bench-claude-"));
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configDir,
    SENTRY_CLI_NO_TELEMETRY: "1",
    PATH: binDir ? `${binDir}:${process.env.PATH}` : process.env.PATH,
  };
  const started = performance.now();
  return new Promise((done) => {
    const child = spawn(claudeBin, args, { cwd: dir, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(configDir, { recursive: true, force: true });
      const events: StreamEvent[] = [];
      for (const line of stdout.split("\n")) {
        try {
          events.push(JSON.parse(line) as StreamEvent);
        } catch {
          // Not an event line.
        }
      }
      done({
        events,
        seconds: (performance.now() - started) / 1000,
        error: code === 0 ? undefined : `exit ${code}: ${stderr.slice(-300)}`,
      });
    });
  });
}

async function runOne(
  task: AgentTask,
  arm: Arm,
  run: number,
  binDir: string,
): Promise<RunResult> {
  const dir = writeRepo(task);
  try {
    const { events, seconds, error } = await runClaude(
      task,
      arm,
      dir,
      arm === "cli" ? binDir : undefined,
    );
    const docsSteps = events
      .filter((event) => event.type === "assistant")
      .flatMap((event) => event.message?.content ?? [])
      .filter((block) => block.type === "tool_use" && block.name)
      .flatMap((block) => docsStep(block.name ?? "", block.input) ?? []);
    const result = events.find((event) => event.type === "result") ?? {};
    const { input, output } = tokens(result);
    const failed = failedChecks(task, dir);
    return {
      task: task.id,
      tier: task.tier,
      arm,
      run,
      passed: failed.length === 0 && !error,
      failedChecks: failed,
      seconds: result.duration_ms ? result.duration_ms / 1000 : seconds,
      inputTokens: input,
      outputTokens: output,
      costUsd: result.total_cost_usd ?? 0,
      turns: result.num_turns ?? 0,
      docsSteps,
      error: error ?? (result.is_error ? result.result : undefined),
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
      const result = await runOne(task, arm, run + 1, binDir);
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
  `Model ${values.model}, ${tasks.length} tasks x ${arms.length} arms x ${runs} runs\n${summarize(results)}`,
);
if (values.json) {
  writeFileSync(values.json, `${JSON.stringify({ results }, null, 2)}\n`);
}
