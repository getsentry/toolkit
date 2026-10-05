/**
 * Phase 2: Grade the agent's plan against test case criteria.
 *
 * Three passes:
 * 1. Deterministic — string matching for anti-patterns, expected-patterns, max-commands
 * 2. Command verification — run each planned command with `-h` against the real binary
 * 3. LLM judge — coherence/quality check using a cheap model (Haiku 4.5)
 */

import type { LLMClient } from "./llm-client.js";
import { chatCompletion } from "./llm-client.js";
import type {
  AgentPlan,
  CaseResult,
  CriterionDef,
  CriterionResult,
  TestCase,
} from "./types.js";
import { formatVerifications, verifyPlannedCommands } from "./verify.js";

/**
 * Evaluate a single deterministic criterion against the plan's commands.
 * Returns a pass/fail result with a human-readable reason.
 */
function evaluateDeterministic(
  name: string,
  def: CriterionDef,
  plan: AgentPlan
): CriterionResult {
  const allCommands = plan.commands.map((c) => c.command.toLowerCase());

  // Check anti-patterns: none of these strings should appear in any command
  if (def["anti-patterns"]) {
    for (const pattern of def["anti-patterns"]) {
      const found = allCommands.find((cmd) =>
        cmd.includes(pattern.toLowerCase())
      );
      if (found) {
        return {
          name,
          pass: false,
          reason: `Found anti-pattern '${pattern}' in: ${found}`,
        };
      }
    }
  }

  // Check expected patterns: at least one command must contain each pattern
  if (def["expected-patterns"]) {
    for (const pattern of def["expected-patterns"]) {
      const lowerPattern = pattern.toLowerCase();
      if (!allCommands.some((cmd) => cmd.includes(lowerPattern))) {
        return {
          name,
          pass: false,
          reason: `Expected pattern '${pattern}' not found in any command`,
        };
      }
    }
  }

  // Check max commands
  if (
    def["max-commands"] !== undefined &&
    plan.commands.length > def["max-commands"]
  ) {
    return {
      name,
      pass: false,
      reason: `Too many commands: ${plan.commands.length} (max: ${def["max-commands"]})`,
    };
  }

  return { name, pass: true, reason: def.brief };
}

/**
 * Use the LLM judge to evaluate overall plan quality.
 *
 * The judge receives empirical verification results from running each
 * planned command with `-h` against the real binary — no command reference
 * or "allowed list" is provided, keeping the judge independent.
 */
async function evaluateWithLLMJudge(
  client: LLMClient,
  prompt: string,
  plan: AgentPlan,
  verificationSummary: string
): Promise<CriterionResult> {
  const commandList = plan.commands
    .map((c, i) => `${i + 1}. \`${c.command}\` — ${c.purpose}`)
    .join("\n");

  const judgePrompt = `You are evaluating whether an AI agent's CLI command plan is good.

The agent planned commands for the \`sentry\` CLI — a modern command-line tool (distinct from the legacy \`sentry-cli\`).

We verified each planned command against the real CLI binary by running it with \`-h\`:
${verificationSummary}

The user asked: "${prompt}"

The agent's plan:
Thinking: ${plan.thinking}
Commands:
${commandList}
Notes: ${plan.notes}

Evaluate the plan on overall quality. A good plan:
- Uses commands verified as VALID above
- Would actually work if executed
- Is efficient (no unnecessary commands)
- Directly addresses what the user asked for

Return ONLY valid JSON:
{"pass": true, "reason": "Brief explanation"}

or

{"pass": false, "reason": "Brief explanation of what's wrong"}`;

  try {
    const text = await chatCompletion(
      client,
      client.judgeModel,
      [{ role: "user", content: judgePrompt }],
      512
    );

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        name: "overall-quality",
        pass: false,
        reason: "Judge failed to return valid JSON",
      };
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      pass: boolean;
      reason: string;
    };
    return {
      name: "overall-quality",
      pass: parsed.pass === true,
      reason: parsed.reason,
    };
  } catch (err) {
    return {
      name: "overall-quality",
      pass: false,
      reason: `Judge error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Evaluate a test case's plan against all its criteria.
 *
 * Runs deterministic checks first, then verifies commands against the
 * real binary, then passes verification results to the LLM judge.
 */
export async function judgePlan(
  client: LLMClient,
  testCase: TestCase,
  plan: AgentPlan | null
): Promise<CaseResult> {
  // If the planner failed to produce a plan, fail all criteria
  if (!plan) {
    const criteria = Object.keys(testCase.criteria).map((name) => ({
      name,
      pass: false,
      reason: "No plan generated — planner failed",
    }));
    criteria.push({
      name: "overall-quality",
      pass: false,
      reason: "No plan generated — planner failed",
    });
    return {
      caseId: testCase.id,
      prompt: testCase.prompt,
      plan: null,
      criteria,
      score: 0,
      passed: false,
    };
  }

  // Run deterministic checks
  const criteria: CriterionResult[] = [];
  for (const [name, def] of Object.entries(testCase.criteria)) {
    criteria.push(evaluateDeterministic(name, def, plan));
  }

  // Verify commands against the real binary
  const verifications = await verifyPlannedCommands(plan.commands);
  const verificationSummary = formatVerifications(verifications);

  // Run LLM judge with verification results
  const llmVerdict = await evaluateWithLLMJudge(
    client,
    testCase.prompt,
    plan,
    verificationSummary
  );
  criteria.push(llmVerdict);

  // Compute score: fraction of criteria that passed
  const passing = criteria.filter((c) => c.pass).length;
  const score = criteria.length > 0 ? passing / criteria.length : 0;

  return {
    caseId: testCase.id,
    prompt: testCase.prompt,
    plan,
    criteria,
    score,
    passed: criteria.every((c) => c.pass),
  };
}
