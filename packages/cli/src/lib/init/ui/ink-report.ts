import chalk from "chalk";
import { renderTextTable } from "../../formatters/text-table.js";
import { buildFileTree, flattenTree } from "./file-tree.js";
import type { WizardSummary } from "./types.js";

// Brand palette mirrored from `ink-app.tsx` so the post-dispose
// success/failure echo (rendered via chalk after Ink unmounts) feels
// like a continuation of the live screen.
const REPORT_MUTED = "#898294";
const REPORT_SUCCESS = "#83da90";
const REPORT_ERROR = "#fe4144";
const REPORT_WARN = "#FDB81B";

/** Splits on `: ` to separate error label from detail. */
const ERROR_SPLIT_RE = /:\s+/;

/**
 * Build the chalk-formatted failure report shown after alternate
 * screen exit. Includes up to 5 recent error log entries with
 * structured formatting for readability.
 */
export function formatFailureReport(
  message: string,
  logs: readonly { severity: string; text: string }[],
  feedbackHint?: string
): string {
  const icon = chalk.hex(REPORT_ERROR)("\u2716");
  const lines: string[] = [
    `\n${icon}  ${chalk.hex(REPORT_ERROR).bold(message)}`,
  ];
  const errorLogs = logs.filter(
    (entry) =>
      entry.severity === "error" &&
      entry.text !== message &&
      entry.text !== "Failed"
  );
  if (errorLogs.length > 0) {
    lines.push("");
  }
  for (const entry of errorLogs.slice(-5)) {
    formatErrorEntry(entry.text, lines);
  }
  appendFeedbackHint(lines, feedbackHint);
  return lines.join("\n");
}

export function formatSuccessReport(
  message: string,
  summary: WizardSummary | undefined,
  feedbackHint?: string
): string {
  const successIcon = chalk.hex(REPORT_SUCCESS)("✔");
  const lines: string[] = ["", `${successIcon}  ${chalk.bold(message)}`];
  if (summary && summary.fields.length > 0) {
    lines.push("");
    const labelWidth = Math.max(
      ...summary.fields.map((field) => field.label.length)
    );
    for (const field of summary.fields) {
      const label = chalk.hex(REPORT_MUTED)(field.label.padEnd(labelWidth));
      lines.push(`   ${label}  ${field.value}`);
    }
  }
  if (summary?.featureBlurbs && summary.featureBlurbs.length > 0) {
    lines.push("");
    lines.push(`   ${chalk.hex(REPORT_MUTED).bold("Here's what we set up")}`);
    const tableRows = summary.featureBlurbs.map(({ label, blurb }) => [
      chalk.bold(label),
      chalk.hex(REPORT_MUTED)(blurb),
    ]);
    const table = renderTextTable(["", ""], tableRows, {
      shrinkable: [false, true],
    });
    for (const line of table.trimEnd().split("\n")) {
      lines.push(`   ${line}`);
    }
  }
  if (summary?.changedFiles && summary.changedFiles.length > 0) {
    lines.push("");
    lines.push(`   ${chalk.hex(REPORT_MUTED).bold("Changed files")}`);
    const tree = buildFileTree(summary.changedFiles);
    for (const row of flattenTree(tree)) {
      lines.push(formatTreeRowChalk(row));
    }
  }
  appendFeedbackHint(lines, feedbackHint);
  return lines.join("\n");
}

/**
 * Compact success echo left in the user's scrollback after the completion
 * screen closes. The screen already showed everything; here we keep only a
 * warm confirmation plus the one thing that stays useful post-exit — the link
 * to your errors (no key hints, since there's nothing to press anymore).
 */
export function formatSuccessExitLine(
  summary: WizardSummary | undefined
): string {
  const completion = summary?.completion;
  const project = completion?.projectName ?? "your project";
  const icon = chalk.hex(REPORT_SUCCESS)("✔");
  const lines: string[] = [
    "",
    `${icon}  ${chalk.bold(`All set — Sentry is watching ${project}`)}`,
  ];
  const target = completion?.verification.eventUrl ?? completion?.issuesUrl;
  if (target) {
    const label = completion?.verification.received
      ? "View your first event"
      : "See your first error";
    lines.push(`   ${chalk.hex(REPORT_MUTED)(`${label} → ${target}`)}`);
  }
  return lines.join("\n");
}

function appendFeedbackHint(lines: string[], feedbackHint?: string): void {
  if (!feedbackHint) {
    return;
  }
  lines.push("");
  for (const line of feedbackHint.split("\n")) {
    lines.push(`   ${chalk.hex(REPORT_MUTED)(line)}`);
  }
  lines.push("");
}

/**
 * Format a single error log entry into indented report lines.
 * Splits on newlines first, then separates the first segment
 * (bold red) from subsequent detail (muted) on each line.
 */
function formatErrorEntry(text: string, out: string[]): void {
  const rawLines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (rawLines.length === 0) {
    return;
  }
  const first = rawLines[0] ?? "";
  const parts = first.split(ERROR_SPLIT_RE);
  out.push(`   ${chalk.hex(REPORT_ERROR).bold(parts[0] ?? "")}`);
  for (const part of parts.slice(1)) {
    out.push(`   ${chalk.hex(REPORT_MUTED)(part)}`);
  }
  for (const line of rawLines.slice(1)) {
    out.push(`   ${chalk.hex(REPORT_MUTED)(line)}`);
  }
}

/**
 * Colored glyph for a changed-files row in the post-dispose report.
 * The plain ASCII variant lives in `logging-ui.ts` for the
 * non-interactive CI path.
 */
function changedFileGlyphColored(action: string): string {
  if (action === "create") {
    return chalk.hex(REPORT_SUCCESS)("+");
  }
  if (action === "delete") {
    return chalk.hex(REPORT_ERROR)("−");
  }
  return chalk.hex(REPORT_WARN)("~");
}

/**
 * Render a single `FileTreeRow` for the post-dispose report.
 * Directories show only the box-drawing branch + label; files add
 * the action glyph (colored).
 */
function formatTreeRowChalk(row: {
  prefix: string;
  branch: string;
  kind: "file" | "directory";
  label: string;
  action?: string;
}): string {
  const branch = chalk.hex(REPORT_MUTED)(`${row.prefix}${row.branch}`);
  if (row.kind === "directory") {
    return `     ${branch} ${row.label}`;
  }
  const glyph = changedFileGlyphColored(row.action ?? "modify");
  return `     ${branch} ${glyph} ${row.label}`;
}
