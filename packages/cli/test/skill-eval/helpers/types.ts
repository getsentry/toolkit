/**
 * Shared types for the skill evaluation framework.
 *
 * The eval tests whether SKILL.md effectively guides an LLM to use the
 * Sentry CLI efficiently — no pre-auth, no org lookup, correct fields,
 * minimal tool calls.
 */

/** A single planned CLI command from the agent under test */
export type PlannedCommand = {
  command: string;
  purpose: string;
};

/** Structured plan output from the agent under test */
export type AgentPlan = {
  thinking: string;
  commands: PlannedCommand[];
  notes: string;
};

/** Criterion definition from cases.json */
export type CriterionDef = {
  brief: string;
  /** Strings that must NOT appear in any command */
  "anti-patterns"?: string[];
  /** Strings that MUST appear in at least one command */
  "expected-patterns"?: string[];
  /** Maximum number of commands allowed */
  "max-commands"?: number;
};

/** Test case definition from cases.json */
export type TestCase = {
  id: string;
  prompt: string;
  description: string;
  criteria: Record<string, CriterionDef>;
};

/** Result of evaluating a single criterion */
export type CriterionResult = {
  name: string;
  pass: boolean;
  reason: string;
};

/** Result of evaluating one test case against one model */
export type CaseResult = {
  caseId: string;
  prompt: string;
  plan: AgentPlan | null;
  criteria: CriterionResult[];
  score: number;
  passed: boolean;
};

/** Results for all cases run against one model */
export type ModelResult = {
  model: string;
  cases: CaseResult[];
  totalPassed: number;
  totalCases: number;
  score: number;
};

/** Full eval report written to results.json */
export type EvalReport = {
  timestamp: string;
  skillVersion: string;
  threshold: number;
  models: ModelResult[];
};
