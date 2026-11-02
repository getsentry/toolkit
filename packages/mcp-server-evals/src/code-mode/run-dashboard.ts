/**
 * HTTP Code Mode experiment: a client writes programs, workerd executes them,
 * and an independent stateful API fixture decides whether the task succeeded.
 * Only synthetic data and a dummy token are used. Production MCP is untouched.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { unstable_dev } from "wrangler";
import { z } from "zod";
import { createAlertFixture } from "./alert-fixture";
import { runClaudeAgent } from "./claude-agent";
import { runCodexAgent } from "./codex-agent";
import { createDashboardFixture } from "./dashboard-fixture";
import { createMonitorFixture } from "./monitor-fixture";
import { createReleaseFixture } from "./release-fixture";
import { createReleaseRecoveryFixture } from "./release-recovery-fixture";
import { writeEvalReport } from "./report";
import { createRepositoriesDeniedFixture } from "./repositories-denied-fixture";
import { createRepositoriesFixture } from "./repositories-fixture";
import { createRepositoriesRetryFixture } from "./repositories-retry-fixture";

const fixtures = {
  dashboard: createDashboardFixture,
  release: createReleaseFixture,
  repositories: createRepositoriesFixture,
  alert: createAlertFixture,
  monitor: createMonitorFixture,
  "release-recovery": createReleaseRecoveryFixture,
  "repositories-retry": createRepositoriesRetryFixture,
  "repositories-denied": createRepositoriesDeniedFixture,
};
type Task = keyof typeof fixtures;

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const EVAL_WORKER = "packages/mcp-cloudflare/src/code-mode/eval-worker.ts";
const EVAL_WORKER_CONFIG =
  "packages/mcp-server-evals/src/code-mode/wrangler.jsonc";
/** Each surface is a connection grant on the eval worker; see eval-worker.ts. */
const SURFACE_ROUTES: Record<string, string> = {
  "catalog-and-code": "/mcp",
  catalog: "/catalog/mcp",
  "code-mode": "/code-mode/mcp",
};
const systemPrompt =
  "Complete the user's task using only the sentry_code_mode MCP tools search_sentry_api and execute_sentry_code. Do not use shell, files, web, resources, or other tools. Discover the API as needed, execute the necessary operations, and report the actual result. Do not claim success without evidence. The requested writes are authorized.";

/** Run repetitions against fresh fixture state and persist reproducible evidence. */
async function main() {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: "3" },
      task: { type: "string", multiple: true, default: ["dashboard"] },
      client: { type: "string", default: "codex" },
      model: { type: "string" },
      surface: { type: "string", default: "code-mode" },
      report: { type: "string" },
    },
  });
  const repetitions = Number(values.runs);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
    throw new Error("--runs must be an integer from 1 to 10");
  }
  if (!["codex", "claude"].includes(values.client))
    throw new Error("--client must be codex or claude");
  if (values.client === "codex" && !values.model)
    throw new Error("Pass --model with a model available to your Codex login.");
  if (!["code-mode", "catalog", "catalog-and-code"].includes(values.surface))
    throw new Error(
      "--surface must be code-mode, catalog, or catalog-and-code",
    );
  const discovery = values.surface !== "code-mode";
  if (discovery && values.client !== "claude")
    throw new Error(
      "Natural discovery evaluations currently require --client claude",
    );
  const tasks = values.task.map((value) =>
    z
      .enum([
        "dashboard",
        "release",
        "repositories",
        "alert",
        "monitor",
        "release-recovery",
        "repositories-retry",
        "repositories-denied",
      ])
      .parse(value),
  );
  if (values.report && tasks.length !== 1)
    throw new Error("--report requires exactly one --task");
  if (!discovery && tasks.some((task) => task !== "dashboard"))
    throw new Error("CLI flows require a natural discovery surface");
  for (const task of tasks) await runTask(task, values, repetitions);
}

/** Each task gets a fresh API fixture and Worker, with the same client settings. */
async function runTask(
  task: Task,
  values: { client: string; surface: string; model?: string; report?: string },
  repetitions: number,
) {
  const discovery = values.surface !== "code-mode";
  const instructions = discovery ? undefined : systemPrompt;
  const require = createRequire(import.meta.url);
  const requireWrangler = createRequire(
    require.resolve("wrangler/package.json"),
  );
  const packageSchema = z.object({ version: z.string() });
  const runtime = {
    wrangler: packageSchema.parse(require("wrangler/package.json")).version,
    workerd: packageSchema.parse(requireWrangler("workerd/package.json"))
      .version,
  };
  const directory = await mkdtemp(
    path.join(tmpdir(), "sentry-code-mode-eval-"),
  );
  const accessToken = "code-mode-eval-token";
  const fixture = await fixtures[task]({ accessToken });
  let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined;
  const runs = [];
  try {
    // The hosted Code Mode registration and policy, against the loopback fixture.
    worker = await unstable_dev(path.join(root, EVAL_WORKER), {
      config: path.join(root, EVAL_WORKER_CONFIG),
      ip: "127.0.0.1",
      port: 0,
      local: true,
      persist: false,
      logLevel: "error",
      vars: { API_BASE_URL: `${fixture.baseUrl}/api/0` },
      experimental: {
        disableExperimentalWarning: true,
        disableDevRegistry: true,
        watch: false,
      },
    });
    const mcpUrl = `http://${worker.address}:${worker.port}${SURFACE_ROUTES[values.surface]}`;
    const client = new Client({ name: "eval-inventory", version: "1.0.0" });
    let inventory: Tool[];
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(mcpUrl), {
          requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
        }),
      );
      inventory = (await client.listTools()).tools;
    } finally {
      await client.close();
    }
    for (let index = 0; index < repetitions; index++) {
      fixture.reset();
      console.log(
        `HTTP ${task} eval ${index + 1}/${repetitions}: starting ${values.client}`,
      );
      const agent =
        values.client === "claude"
          ? await runClaudeAgent(
              directory,
              mcpUrl,
              accessToken,
              fixture.prompt,
              {
                model: values.model,
                systemPrompt: instructions,
                serverName: discovery ? "sentry" : "sentry_code_mode",
                toolNames: inventory.map((tool) => tool.name),
              },
            )
          : await runCodexAgent(
              directory,
              mcpUrl,
              accessToken,
              fixture.prompt,
              { model: values.model!, systemPrompt },
            );
      let verification: {
        success: boolean;
        dashboardIds?: string[];
        error?: string;
      };
      try {
        if (agent.error) throw new Error(agent.error);
        verification = fixture.verify(agent.text);
      } catch (error) {
        verification = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const snapshot = fixture.snapshot();
      const selection = {
        catalogSearches: agent.mcpCalls.filter(
          (call) => call.name === "search_sentry_tools",
        ).length,
        apiSearches: agent.mcpCalls.filter(
          (call) => call.name === "search_sentry_api",
        ).length,
        codeExecutions: agent.mcpCalls.filter(
          (call) => call.name === "execute_sentry_code",
        ).length,
        sequence: agent.mcpCalls.map((call) => call.name),
      };
      const apiRequests = snapshot.requests.filter((request) =>
        request.path.startsWith("/api/0/"),
      );
      const { requests: _requests, ...state } = snapshot;
      runs.push({
        run: index + 1,
        verification,
        selection,
        agent,
        apiRequests,
        ...state,
      });
      console.log(
        JSON.stringify({
          run: index + 1,
          ...verification,
          selection,
          model: agent.model,
          mcpCalls: agent.mcpCalls.length,
          apiCalls: apiRequests.length,
          apiErrors: apiRequests.filter((request) => request.status >= 400)
            .length,
          durationMs: agent.durationMs,
          usage: agent.usage,
        }),
      );
    }
    const successes = runs.filter((run) => run.verification.success).length;
    const specSource = z
      .object({ version: z.string() })
      .parse(
        JSON.parse(
          await readFile(
            path.join(
              root,
              "packages/mcp-cloudflare/src/code-mode/generated/source.json",
            ),
            "utf8",
          ),
        ),
      );
    const reportPath = await writeEvalReport(
      {
        root,
        task,
        client: values.client,
        surface: values.surface,
        reportPath: values.report,
      },
      {
        variant: "http",
        surface: values.surface,
        task,
        expectedOutcome:
          "expectedOutcome" in fixture ? fixture.expectedOutcome : "completed",
        cliCommands: "cliCommands" in fixture ? fixture.cliCommands : [],
        provenance: "provenance" in fixture ? fixture.provenance : undefined,
        timestamp: new Date().toISOString(),
        revision: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        uncommittedImplementation: true,
        client: values.client,
        clientVersion: execFileSync(values.client, ["--version"], {
          encoding: "utf8",
        }).trim(),
        runtime,
        clientIsolation:
          values.client === "claude"
            ? `Empty temporary working directory; ${discovery ? "default Claude Code system prompt" : "custom system prompt"}; settings sources, hooks, skills, session persistence and built-in tools disabled; strict MCP config and allowlist for every tool advertised by this MCP server.`
            : "User config, project docs, hooks, skills and optional features disabled. Global AGENTS.md and some built-in tools can still be advertised; runs using other tools are rejected.",
        codeHashes: Object.fromEntries(
          await Promise.all(
            [
              EVAL_WORKER,
              EVAL_WORKER_CONFIG,
              "packages/mcp-cloudflare/src/code-mode/tools.ts",
              "packages/mcp-cloudflare/src/code-mode/authorization.ts",
              "packages/mcp-cloudflare/src/code-mode/access.ts",
              "packages/mcp-cloudflare/src/code-mode/broker.ts",
              "packages/mcp-cloudflare/src/code-mode/sandbox.ts",
              "packages/mcp-cloudflare/src/code-mode/generated/source.json",
              "packages/mcp-core/src/code-mode.ts",
              "packages/mcp-core/src/server.ts",
              "packages/mcp-core/src/toolDefinitions.json",
              `packages/mcp-server-evals/src/code-mode/${task}-fixture.ts`,
              ...(task === "release-recovery"
                ? ["packages/mcp-server-evals/src/code-mode/release-fixture.ts"]
                : task === "repositories-retry" ||
                    task === "repositories-denied"
                  ? [
                      "packages/mcp-server-evals/src/code-mode/repositories-fixture.ts",
                    ]
                  : []),
              ...(task === "dashboard"
                ? [
                    "packages/mcp-server-evals/src/code-mode/dashboard-fixture-data.json",
                  ]
                : [
                    "packages/mcp-server-evals/src/code-mode/api-fixture.ts",
                    "packages/mcp-server-evals/src/code-mode/json-answer.ts",
                  ]),
              "packages/mcp-server-evals/src/code-mode/run-dashboard.ts",
              "packages/mcp-server-evals/src/code-mode/report.ts",
              "packages/mcp-server-evals/src/code-mode/claude-agent.ts",
              "packages/mcp-server-evals/src/code-mode/codex-agent.ts",
            ].map(async (file) => [
              file,
              createHash("sha256")
                .update(await readFile(path.join(root, file)))
                .digest("hex"),
            ]),
          ),
        ),
        discovery: `Shipped OpenAPI document of @sentry/api ${specSource.version}, enforced by the hosted ApiAuthorization; only fixture API endpoints are executable`,
        inventory,
        prompt: fixture.prompt,
        systemPrompt: instructions ?? null,
        requestedModel: values.model ?? null,
        reasoningEffort: "medium",
        successes,
        repetitions,
        runs,
      },
    );
    console.log(`Result: ${successes}/${repetitions}. Evidence: ${reportPath}`);
    if (successes !== repetitions) process.exitCode = 1;
  } finally {
    await worker?.stop();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
