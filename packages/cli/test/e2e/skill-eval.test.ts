/**
 * SKILL.md Effectiveness Evaluation (E2E)
 *
 * Tests whether SKILL.md effectively guides LLMs to plan correct CLI commands.
 * Uses the real CLI binary (via SENTRY_CLI_BINARY or dev mode) to verify
 * that planned commands actually exist.
 *
 * Skips automatically when no eval provider credential is set (neither
 * OPENROUTER_API_KEY nor ANTHROPIC_API_KEY). In CI, the key is only passed
 * when skill-related files change.
 */

import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { resolveEvalProvider } from "../eval-common/anthropic-client.js";
import cases from "../skill-eval/cases.json";
import { judgePlan } from "../skill-eval/helpers/judge.js";
import { createClient } from "../skill-eval/helpers/llm-client.js";
import { generatePlan } from "../skill-eval/helpers/planner.js";
import type { CaseResult, TestCase } from "../skill-eval/helpers/types.js";

const SKILL_PATH = "plugins/sentry-cli/skills/sentry-cli/SKILL.md";
const DEFAULT_THRESHOLD = 0.75;

/** Models under test — env-overridable, defaults to sonnet-5 + gpt-5.6-luna. */
const AGENT_MODELS = process.env.EVAL_AGENT_MODELS
  ? process.env.EVAL_AGENT_MODELS.split(",").map((m) => m.trim())
  : ["anthropic/claude-sonnet-5", "openai/gpt-5.6-luna"];

const provider = resolveEvalProvider();

/**
 * The test preload mocks globalThis.fetch to block external network calls.
 * This test needs real fetch for the eval provider's API, so we restore it
 * during the describe block and put the mock back when done.
 */
const originalFetch = (globalThis as { __originalFetch?: typeof fetch })
  .__originalFetch;

describe.skipIf(!provider)("skill eval", () => {
  const savedFetch = globalThis.fetch;

  beforeAll(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
  });

  afterAll(() => {
    globalThis.fetch = savedFetch;
  });
  const testCases = cases as unknown as TestCase[];
  const threshold = process.env.EVAL_THRESHOLD
    ? Number.parseFloat(process.env.EVAL_THRESHOLD)
    : DEFAULT_THRESHOLD;

  /**
   * Run the full eval for a single model and assert it meets the threshold.
   * Each model gets its own test so failures are attributed clearly.
   */
  async function runEvalForModel(model: string): Promise<void> {
    if (!provider) {
      throw new Error("eval provider unavailable");
    }
    const client = createClient(provider);
    const skillContent = await readFile(SKILL_PATH, "utf-8");

    const results: CaseResult[] = [];
    for (const testCase of testCases) {
      const plan = await generatePlan(
        client,
        model,
        skillContent,
        testCase.prompt
      );
      const result = await judgePlan(client, testCase, plan);
      results.push(result);
    }

    const passed = results.filter((r) => r.passed).length;
    const score = passed / testCases.length;
    // biome-ignore lint/suspicious/noMisplacedAssertion: called from test() via helper
    expect(score).toBeGreaterThanOrEqual(threshold);
  }

  for (const model of AGENT_MODELS) {
    test(`${model} meets threshold`, { timeout: 120_000 }, () =>
      runEvalForModel(model)
    );
  }
});
