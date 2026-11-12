#!/usr/bin/env tsx
/**
 * Evaluate SKILL.md effectiveness by testing LLM command planning.
 *
 * Sends test prompts to agent models (Sonnet 5 + GPT-5.6 Luna) with SKILL.md
 * as context, then grades the planned commands on efficiency criteria.
 * Commands are verified against the real CLI binary (via `-h`) to ground
 * the LLM judge with empirical results.
 *
 * Requires an eval provider credential: OPENROUTER_API_KEY (preferred) or
 * ANTHROPIC_API_KEY. OpenRouter is used when its key is set; default model IDs
 * are OpenRouter slugs (e.g. `anthropic/claude-sonnet-5`).
 *
 * Usage:
 *   tsx script/eval-skill.ts
 *   EVAL_AGENT_MODELS=anthropic/claude-sonnet-5 tsx script/eval-skill.ts
 *
 * Environment variables:
 *   OPENROUTER_API_KEY  - OpenRouter API key (preferred)
 *   ANTHROPIC_API_KEY   - Anthropic API key (fallback when no OpenRouter key)
 *   EVAL_AGENT_MODELS   - Comma-separated model IDs (default: sonnet-5, gpt-5.6-luna)
 *   EVAL_JUDGE_MODEL    - Judge model ID (default: haiku-4.5)
 *   EVAL_THRESHOLD      - Minimum pass rate 0-1 (default: 0.75)
 *   SENTRY_CLI_BINARY   - Path to pre-built binary (falls back to tsx src/bin.ts)
 */

import { readFile } from "node:fs/promises";
import { resolveEvalProvider } from "../test/eval-common/anthropic-client.js";
import cases from "../test/skill-eval/cases.json";
import { judgePlan } from "../test/skill-eval/helpers/judge.js";
import { createClient } from "../test/skill-eval/helpers/llm-client.js";
import { generatePlan } from "../test/skill-eval/helpers/planner.js";
import {
  getExitCode,
  printReport,
  writeJsonReport,
} from "../test/skill-eval/helpers/report.js";
import type {
  CaseResult,
  EvalReport,
  ModelResult,
  TestCase,
} from "../test/skill-eval/helpers/types.js";
import { logger } from "../src/lib/logger.js";

const SKILL_PATH = "plugins/sentry-cli/skills/sentry-cli/SKILL.md";
const RESULTS_PATH = "test/skill-eval/results.json";
const VERSION_RE = /^version:\s*(.+)$/m;

/**
 * Default pass threshold — set from baseline run (2026-03-30).
 * Baseline: openai/gpt-4.1 scored 100% (8/8 cases).
 * Set to 75% to allow for LLM non-determinism while catching regressions.
 */
const DEFAULT_THRESHOLD = 0.75;

/** Run all eval cases against a single model */
async function evalModel(
  client: Awaited<ReturnType<typeof createClient>>,
  model: string,
  skillContent: string,
  testCases: TestCase[],
): Promise<ModelResult> {
  logger.start(`Evaluating: ${model}`);

  const results: CaseResult[] = [];

  for (const testCase of testCases) {
    logger.start(`${testCase.id}...`);

    const plan = await generatePlan(
      client,
      model,
      skillContent,
      testCase.prompt,
    );
    const result = await judgePlan(client, testCase, plan);
    results.push(result);

    const icon = result.passed ? "✓" : "✗";
    logger.log(
      `  ${testCase.id}: ${icon} (${(result.score * 100).toFixed(0)}%)`,
    );
  }

  const totalPassed = results.filter((r) => r.passed).length;
  const score = results.length > 0 ? totalPassed / results.length : 0;

  return {
    model,
    cases: results,
    totalPassed,
    totalCases: results.length,
    score,
  };
}

async function main(): Promise<void> {
  const provider = resolveEvalProvider();
  if (!provider) {
    logger.error(
      [
        "An eval provider credential is required for the skill eval.",
        "Set OPENROUTER_API_KEY (preferred) or ANTHROPIC_API_KEY, e.g.:",
        "  export OPENROUTER_API_KEY=<your-key>",
      ].join("\n"),
    );
    process.exit(1);
  }

  const client = createClient(provider);
  const skillContent = await readFile(SKILL_PATH, "utf-8");
  const testCases = cases as unknown as TestCase[];
  const threshold = process.env.EVAL_THRESHOLD
    ? Number.parseFloat(process.env.EVAL_THRESHOLD)
    : DEFAULT_THRESHOLD;

  logger.info(
    [
      `Skill eval: ${testCases.length} cases × ${client.agentModels.length} models`,
      `Provider: ${provider.provider}`,
      `Agent models: ${client.agentModels.join(", ")}`,
      `Judge model: ${client.judgeModel}`,
      `Threshold: ${(threshold * 100).toFixed(0)}%`,
    ].join("\n"),
  );

  // Extract skill version from YAML frontmatter
  const versionMatch = skillContent.match(VERSION_RE);
  const skillVersion = versionMatch?.[1]?.trim() ?? "unknown";

  const models: ModelResult[] = [];
  for (const model of client.agentModels) {
    const result = await evalModel(client, model, skillContent, testCases);
    models.push(result);
  }

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    skillVersion,
    threshold,
    models,
  };

  printReport(report);
  await writeJsonReport(report, RESULTS_PATH);

  process.exit(getExitCode(report));
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
