/**
 * Human-readable report for `sentry debug-files wasm-upload`.
 *
 * One table per module, so a warning stays next to the module it belongs to.
 * A build directory can hold dozens of modules, and a flat list of lines makes
 * it easy to read a warning against the wrong path.
 */

import type {
  PrepareAction,
  PrepareCommandResult,
  PrepareResult,
} from "../wasm/prepare.js";
import {
  colorTag,
  escapeMarkdownCell,
  escapeMarkdownInline,
  mdKvTable,
  renderMarkdown,
  safeCodeSpan,
} from "./markdown.js";

/** What preparation did to a module, in the past tense. */
const ACTION_LABELS: Record<PrepareAction, string> = {
  split: "Split",
  "would-split": "Would split",
  "already-prepared": "Already prepared",
  skipped: colorTag("red", "Skipped"),
};

/**
 * One module as a heading plus a key-value table.
 *
 * The path is the heading, in full rather than as a basename: a build tree
 * routinely holds several same-named modules.
 */
function moduleSection(module: PrepareResult): string {
  const rows: [string, string][] = [
    ["Action", ACTION_LABELS[module.action]],
    ["Debug quality", module.quality],
  ];
  if (module.buildId) {
    rows.push(["Build ID", safeCodeSpan(module.buildId)]);
  }
  if (module.companion) {
    rows.push(["Companion", safeCodeSpan(module.companion)]);
  }
  if (module.warning) {
    rows.push([
      colorTag("yellow", "Warning"),
      escapeMarkdownCell(module.warning),
    ]);
  }
  if (module.recommendation) {
    rows.push([
      colorTag("cyan", "Recommendation"),
      escapeMarkdownCell(module.recommendation),
    ]);
  }
  return mdKvTable(rows, escapeMarkdownInline(module.path));
}

/**
 * Counts opening the report.
 *
 * Deliberately short: per-module facts belong in the tables below, so this only
 * states how much was scanned and, when relevant, how much was uploaded.
 */
function summaryLines(data: PrepareCommandResult): string[] {
  const scanned = data.modules.length;
  const lines = [
    `## Found ${scanned} ${scanned === 1 ? "wasm file" : "wasm files"}`,
  ];
  if (data.uploaded) {
    const uploaded = data.filesUploaded;
    const target =
      data.org && data.project ? ` to ${data.org}/${data.project}` : "";
    lines.push(
      "",
      `Uploaded ${uploaded} ${uploaded === 1 ? "debug file" : "debug files"}${target}.`,
    );
  }
  return lines;
}

/** Format human-readable output for the prepare result. */
export function formatPrepareResult(data: PrepareCommandResult): string {
  const lines = summaryLines(data);
  for (const module of data.modules) {
    lines.push("", moduleSection(module));
  }
  return renderMarkdown(lines.join("\n").trim());
}
