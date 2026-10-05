/**
 * Phase 1: Send SKILL.md + user prompt to the agent model.
 *
 * The agent is framed as an AI coding assistant with terminal access.
 * It must plan which CLI commands to run, outputting structured JSON.
 */

import type { LLMClient } from "./llm-client.js";
import { chatCompletion } from "./llm-client.js";
import type { AgentPlan } from "./types.js";

/**
 * Build the system prompt that frames the LLM as an agent with the skill loaded.
 * The SKILL.md content is injected directly so the model plans based on it.
 */
function buildSystemPrompt(skillContent: string): string {
  return `You are an AI coding agent helping a developer. You have access to a terminal where you can run CLI commands.

The developer is working in a project that uses Sentry for error tracking and monitoring. The Sentry CLI is installed. Here is your guide for using it:

<skill>
${skillContent}
</skill>

When the developer asks you to do something, plan which CLI commands you would run.
Output your plan as JSON with this exact structure:
{
  "thinking": "Brief reasoning about what the user wants and how to accomplish it",
  "commands": [
    {
      "command": "the exact CLI command you would run",
      "purpose": "why you are running this command"
    }
  ],
  "notes": "Any caveats or follow-up suggestions for the user"
}

Rules:
- Output ONLY the JSON object, no markdown fencing, no extra text
- List commands in the order you would execute them
- Be specific with flag values — use actual values, not placeholders
- If the skill guide says something works automatically (auth, org/project detection), trust it
- Do NOT run commands just to gather information you don't need for the task`;
}

/**
 * Generate a command plan from an agent model given a user prompt.
 * Returns the parsed plan, or null if parsing fails.
 */
export async function generatePlan(
  client: LLMClient,
  model: string,
  skillContent: string,
  userPrompt: string
): Promise<AgentPlan | null> {
  const systemPrompt = buildSystemPrompt(skillContent);

  let text: string;
  try {
    text = await chatCompletion(client, model, [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);
  } catch (err) {
    console.error(
      `  [planner] API error: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  // Extract JSON from response (handle potential markdown fencing)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error("  [planner] Failed to extract JSON from response");
    console.error(`  Response: ${text.slice(0, 300)}`);
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as AgentPlan;
    // Normalize: ensure commands is an array
    if (!Array.isArray(parsed.commands)) {
      parsed.commands = [];
    }
    return parsed;
  } catch {
    console.error(`  [planner] Invalid JSON: ${jsonMatch[0].slice(0, 300)}`);
    return null;
  }
}
