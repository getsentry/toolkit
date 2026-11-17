/**
 * Format and output eval results to console and JSON file.
 */

import { writeFile } from "node:fs/promises";
import type { CaseResult, EvalReport, ModelResult } from "./types.js";
import { logger } from "../../../src/lib/logger.js";

/** Format a single case result as console lines */
function formatCaseResult(c: CaseResult): string {
  const lines: string[] = [];
  const icon = c.passed ? "  ✓" : "  ✗";
  const scorePct = (c.score * 100).toFixed(0);
  lines.push(`${icon} ${c.caseId} (${scorePct}%)`);

  for (const cr of c.criteria) {
    const crIcon = cr.pass ? "    PASS" : "    FAIL";
    lines.push(`${crIcon} ${cr.name}: ${cr.reason}`);
  }
  return lines.join("\n");
}

/** Format a single model result as console lines */
function formatModelResult(model: ModelResult, threshold: number): string {
  const lines: string[] = [];
  const pct = (model.score * 100).toFixed(1);
  const status = model.score >= threshold ? "PASS" : "FAIL";
  lines.push(
    `${status} ${model.model}: ${model.totalPassed}/${model.totalCases} cases (${pct}%)`,
  );
  lines.push("");

  for (const c of model.cases) {
    lines.push(formatCaseResult(c));
    lines.push("");
  }
  return lines.join("\n");
}

/** Print a report of all model results */
export function printReport(report: EvalReport): void {
  const lines = [
    "Skill Eval Results",
    "══════════════════",
    `Threshold: ${(report.threshold * 100).toFixed(0)}%`,
    "",
  ];

  for (const model of report.models) {
    lines.push(formatModelResult(model, report.threshold));
  }

  // Summary
  lines.push("══════════════════");
  for (const model of report.models) {
    const pct = (model.score * 100).toFixed(1);
    const status = model.score >= report.threshold ? "PASS" : "FAIL";
    lines.push(`${status} ${model.model}: ${pct}%`);
  }
  logger.log(`\n${lines.join("\n")}\n`);
}

/** Write the full eval report to a JSON file */
export async function writeJsonReport(
  report: EvalReport,
  path: string,
): Promise<void> {
  await writeFile(path, JSON.stringify(report, null, 2));
  logger.success(`Results written to ${path}`);
}

/** Check if all models meet the threshold, return appropriate exit code */
export function getExitCode(report: EvalReport): number {
  const allPass = report.models.every((m) => m.score >= report.threshold);
  return allPass ? 0 : 1;
}
