import { resolveEvalProvider } from "../../eval-common/anthropic-client.js";
import type { FeatureDoc, Platform } from "./platforms.js";
import type { WizardResult } from "./run-wizard.js";

/** Default judge model for init-eval (OpenRouter slug); override via EVAL_JUDGE_MODEL. */
const INIT_EVAL_JUDGE_MODEL = "anthropic/claude-sonnet-4.6";

export type JudgeCriterion = {
  name: string;
  /** true = pass, false = fail, "unknown" = judge can't determine */
  pass: boolean | "unknown";
  reason: string;
};

export type JudgeVerdict = {
  criteria: JudgeCriterion[];
  /** Score from 0-1, computed only over criteria that aren't "unknown" */
  score: number;
  summary: string;
};

/**
 * Use an LLM judge to evaluate whether a **single feature** was correctly set
 * up by the wizard. Returns null when no eval provider credential is set
 * (OPENROUTER_API_KEY or ANTHROPIC_API_KEY).
 *
 * `docsContent` is the pre-fetched plain-text documentation to include as
 * ground truth in the prompt.
 */
export async function judgeFeature(
  result: WizardResult,
  platform: Platform,
  feature: FeatureDoc,
  docsContent: string
): Promise<JudgeVerdict | null> {
  const provider = resolveEvalProvider();
  if (!provider) {
    console.log(
      `  [judge:${feature.feature}] Skipping LLM judge (no OPENROUTER_API_KEY or ANTHROPIC_API_KEY set)`
    );
    return null;
  }

  // Restore real fetch — test preload mocks it to catch accidental network
  // calls, but we need real HTTP for the eval provider's API.
  const realFetch = (globalThis as { __originalFetch?: typeof fetch })
    .__originalFetch;
  if (realFetch) {
    globalThis.fetch = realFetch;
  }

  const newFilesSection = Object.entries(result.newFiles)
    .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
    .join("\n\n");

  const prompt = `You are evaluating whether **${feature.feature}** was correctly set up in a **${platform.name}** project by a Sentry SDK wizard.

## Official Sentry documentation for ${feature.feature}
${docsContent}

## Changes made by wizard (git diff)
\`\`\`diff
${result.diff.slice(0, 20_000)}
\`\`\`

## New files created by wizard
${newFilesSection.slice(0, 20_000) || "(none)"}

## Wizard output
stdout: ${result.stdout.slice(0, 2000)}
stderr: ${result.stderr.slice(0, 2000)}

Score each criterion as true (pass), false (fail), or "unknown" (cannot determine from the available information):
1. **feature-initialized** — The ${feature.feature} feature is correctly initialized per the documentation
2. **correct-imports** — Correct imports and SDK packages used for ${feature.feature}
3. **no-syntax-errors** — No syntax errors or broken imports in ${feature.feature}-related code
4. **follows-docs** — ${feature.feature} configuration follows documentation recommendations

Return ONLY valid JSON with this structure:
{
  "criteria": [
    {"name": "feature-initialized", "pass": true, "reason": "..."},
    {"name": "correct-imports", "pass": true, "reason": "..."},
    {"name": "no-syntax-errors", "pass": true, "reason": "..."},
    {"name": "follows-docs", "pass": "unknown", "reason": "..."}
  ],
  "summary": "Brief overall assessment of ${feature.feature} setup"
}`;

  const text = await provider.chat(
    process.env.EVAL_JUDGE_MODEL ?? INIT_EVAL_JUDGE_MODEL,
    [{ role: "user", content: prompt }],
    1024
  );

  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.log(
      `  [judge:${feature.feature}] Failed to parse judge response:`,
      text.slice(0, 200)
    );
    return null;
  }

  let parsed: { criteria: JudgeCriterion[]; summary: string };
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    console.log(
      `  [judge:${feature.feature}] Invalid JSON in response:`,
      jsonMatch[0].slice(0, 200)
    );
    return null;
  }

  // Score: ignore "unknown" criteria, only count pass/fail
  const gradable = parsed.criteria.filter((c) => c.pass !== "unknown");
  const passing = gradable.filter((c) => c.pass === true).length;
  const total = gradable.length;
  const score = total > 0 ? passing / total : 0;

  const verdict: JudgeVerdict = {
    criteria: parsed.criteria,
    score,
    summary: parsed.summary,
  };

  // Log for visibility in test output
  console.log(
    `  [judge:${feature.feature}] Score: ${passing}/${total} (${(score * 100).toFixed(0)}%)`
  );
  for (const c of parsed.criteria) {
    let icon = "FAIL";
    if (c.pass === "unknown") icon = "SKIP";
    else if (c.pass === true) icon = "PASS";
    console.log(`    ${icon} ${c.name}: ${c.reason}`);
  }
  console.log(`  [judge:${feature.feature}] Summary: ${parsed.summary}`);

  return verdict;
}
