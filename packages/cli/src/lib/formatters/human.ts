/**
 * Human-readable output formatters
 *
 * Centralized formatting utilities for consistent CLI output.
 * Detail views (issue, event, org, project) are built as markdown and rendered
 * via renderMarkdown(). List rows still use lightweight inline formatting for
 * performance, while list tables are rendered via writeTable() → renderMarkdown().
 */

// biome-ignore lint/performance/noNamespaceImport: Sentry SDK recommends namespace import
import * as Sentry from "@sentry/node-core/light";
import prettyMs from "pretty-ms";
import type {
  DashboardDetail,
  DashboardWidget,
} from "../../types/dashboard.js";
import type {
  BreadcrumbsEntry,
  ExceptionEntry,
  ExceptionValue,
  IssueStatus,
  RequestEntry,
  SentryEvent,
  SentryIssue,
  SentryOrganization,
  SentryProject,
  StackFrame,
  TraceSpan,
  Writer,
} from "../../types/index.js";
import { resolveOrgDisplayName } from "../api-client.js";
import { getReplayIdFromEvent } from "../replay-search.js";
import { withSerializeSpan } from "../telemetry.js";
import { type FixabilityTier, muted } from "./colors.js";
import {
  colorTag,
  escapeMarkdownCell,
  escapeMarkdownInline,
  isPlainOutput,
  mdKvTable,
  mdRow,
  mdTableHeader,
  renderMarkdown,
  safeCodeSpan,
} from "./markdown.js";
import { sparkline } from "./sparkline.js";
import { colorizeSql, isDbSpanOp } from "./sql.js";
import { type Column, writeTable } from "./table.js";
import { computeSpanDurationMs, formatRelativeTime } from "./time-utils.js";

// Color tag maps

/** Markdown color tags for Seer fixability tiers */
const FIXABILITY_TAGS: Record<FixabilityTier, Parameters<typeof colorTag>[0]> =
  {
    high: "green",
    med: "yellow",
    low: "red",
  };

// Status Formatting

const STATUS_ICONS: Record<IssueStatus, string> = {
  resolved: colorTag("green", "✓"),
  resolvedInNextRelease: colorTag("green", "✓"),
  unresolved: colorTag("yellow", "●"),
  ignored: colorTag("muted", "−"),
  muted: colorTag("muted", "−"),
};

const STATUS_LABELS: Record<IssueStatus, string> = {
  resolved: `${colorTag("green", "✓")} Resolved`,
  resolvedInNextRelease: `${colorTag("green", "✓")} Resolved in Next Release`,
  unresolved: `${colorTag("yellow", "●")} Unresolved`,
  ignored: `${colorTag("muted", "−")} Ignored`,
  muted: `${colorTag("muted", "−")} Muted`,
};

/** Maximum features to display before truncating with "... and N more" */
const MAX_DISPLAY_FEATURES = 10;

/**
 * Capitalize the first letter of a string
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Convert Seer fixability score to a tier label.
 *
 * Thresholds are simplified from Sentry core (sentry/seer/autofix/constants.py)
 * into 3 tiers for CLI display.
 *
 * @param score - Numeric fixability score (0-1)
 * @returns `"high"` | `"med"` | `"low"`
 */
export function getSeerFixabilityLabel(score: number): FixabilityTier {
  if (score > 0.66) {
    return "high";
  }
  if (score > 0.33) {
    return "med";
  }
  return "low";
}

/**
 * Format fixability score as "label(pct%)" for compact list display.
 *
 * @param score - Numeric fixability score, or null/undefined if unavailable
 * @returns Formatted string like `"med(50%)"`, or `""` when score is unavailable
 */
export function formatFixability(score: number | null | undefined): string {
  if (score === null || score === undefined) {
    return "";
  }
  const label = getSeerFixabilityLabel(score);
  const pct = Math.round(score * 100);
  return `${label}(${pct}%)`;
}

/**
 * Format fixability score for detail view: "Label (pct%)".
 *
 * Uses capitalized label with space before parens for readability
 * in the single-issue detail display.
 *
 * @param score - Numeric fixability score, or null/undefined if unavailable
 * @returns Formatted string like `"Med (50%)"`, or `""` when score is unavailable
 */
export function formatFixabilityDetail(
  score: number | null | undefined
): string {
  if (score === null || score === undefined) {
    return "";
  }
  const label = getSeerFixabilityLabel(score);
  const pct = Math.round(score * 100);
  return `${capitalize(label)} (${pct}%)`;
}

/** Map of entry type strings to their TypeScript types */
type EntryTypeMap = {
  exception: ExceptionEntry;
  breadcrumbs: BreadcrumbsEntry;
  request: RequestEntry;
};

/**
 * Extract a typed entry from event entries by type
 * @returns The entry if found, null otherwise
 */
function extractEntry<T extends keyof EntryTypeMap>(
  event: SentryEvent,
  type: T
): EntryTypeMap[T] | null {
  if (!event.entries) {
    return null;
  }
  for (const entry of event.entries) {
    if (
      entry &&
      typeof entry === "object" &&
      "type" in entry &&
      entry.type === type
    ) {
      return entry as EntryTypeMap[T];
    }
  }
  return null;
}

/** Regex to extract base URL from a permalink */
const BASE_URL_REGEX = /^(https?:\/\/[^/]+)/;

/**
 * Format a features list as a markdown bullet list.
 *
 * @param features - Array of feature names (may be undefined)
 * @returns Markdown string, or empty string if no features
 */
function formatFeaturesMarkdown(features: string[] | undefined): string {
  if (!features || features.length === 0) {
    return "";
  }

  const displayFeatures = features.slice(0, MAX_DISPLAY_FEATURES);
  const items = displayFeatures.map((f) => `- ${f}`).join("\n");
  const more =
    features.length > MAX_DISPLAY_FEATURES
      ? `\n*... and ${features.length - MAX_DISPLAY_FEATURES} more*`
      : "";

  return `\n**Features** (${features.length}):\n\n${items}${more}`;
}

/**
 * Get status icon for an issue status
 */
export function formatStatusIcon(status: string | undefined): string {
  return STATUS_ICONS[status as IssueStatus] ?? colorTag("yellow", "●");
}

/**
 * Get full status label for an issue status
 */
export function formatStatusLabel(status: string | undefined): string {
  return (
    STATUS_LABELS[status as IssueStatus] ?? `${colorTag("yellow", "●")} Unknown`
  );
}

// Issue Formatting

/** Quantifier suffixes indexed by groups of 3 digits (K=10^3, M=10^6, …, E=10^18) */
const QUANTIFIERS = ["", "K", "M", "B", "T", "P", "E"];

/**
 * Abbreviate large numbers with K/M/B/T/P/E suffixes (up to 10^18).
 *
 * The decimal is only shown when the rounded value is < 100 (e.g. "12.3K",
 * "1.5M" but not "100M").
 *
 * @param raw - Stringified count
 * @returns Abbreviated string without padding
 */
function abbreviateCount(raw: string): string {
  const n = Number(raw);
  if (Number.isNaN(n)) {
    Sentry.logger.warn(`Unexpected non-numeric issue count: ${raw}`);
    return "?";
  }
  if (n < 1000) {
    return raw;
  }
  const tier = Math.min(Math.floor(Math.log10(n) / 3), QUANTIFIERS.length - 1);
  const suffix = QUANTIFIERS[tier] ?? "";
  const scaled = n / 10 ** (tier * 3);
  const rounded1dp = Number(scaled.toFixed(1));
  if (rounded1dp < 100) {
    return `${rounded1dp.toFixed(1)}${suffix}`;
  }
  const rounded = Math.round(scaled);
  if (rounded >= 1000 && tier < QUANTIFIERS.length - 1) {
    const nextSuffix = QUANTIFIERS[tier + 1] ?? "";
    return `${(rounded / 1000).toFixed(1)}${nextSuffix}`;
  }
  return `${Math.min(rounded, 999)}${suffix}`;
}

/**
 * Options for formatting short IDs with alias highlighting.
 */
export type FormatShortIdOptions = {
  /** Project slug to determine the prefix for suffix highlighting */
  projectSlug?: string;
  /** Project alias (e.g., "e", "w", "o1:d") for multi-project display */
  projectAlias?: string;
  /** Whether in multi-project mode (highlights alias chars in short ID) */
  isMultiProject?: boolean;
};

/**
 * Format short ID for multi-project mode by highlighting the alias characters.
 * Only highlights the specific characters that form the alias:
 * - CLI-25 with alias "c" → **C**LI-**25**
 *
 * @returns Formatted string with ANSI highlights, or null if no match found
 */
function formatShortIdWithAlias(
  shortId: string,
  projectAlias: string
): string | null {
  // Extract the project part of the alias — cross-org collision aliases use
  // the format "o1/d" where only "d" should match against the short ID parts.
  const aliasPart = projectAlias.includes("/")
    ? (projectAlias.split("/").pop() ?? projectAlias)
    : projectAlias;

  const aliasUpper = aliasPart.toUpperCase();
  const aliasLen = aliasUpper.length;

  const parts = shortId.split("-");
  const issueSuffix = parts.pop() ?? "";
  const projectParts = parts;

  if (!aliasUpper.includes("-")) {
    for (let i = projectParts.length - 1; i >= 0; i--) {
      const part = projectParts[i];
      if (part?.startsWith(aliasUpper)) {
        const result = projectParts.map((p, idx) => {
          if (idx === i) {
            return `${colorTag("bu", p.slice(0, aliasLen))}${p.slice(aliasLen)}`;
          }
          return p;
        });
        return `${result.join("-")}-${colorTag("bu", issueSuffix)}`;
      }
    }
  }

  const projectPortion = projectParts.join("-");
  if (projectPortion.startsWith(aliasUpper)) {
    const highlighted = colorTag("bu", projectPortion.slice(0, aliasLen));
    const rest = projectPortion.slice(aliasLen);
    return `${highlighted}${rest}-${colorTag("bu", issueSuffix)}`;
  }

  return null;
}

/**
 * Format a short ID with highlighting to show what the user can type as shorthand.
 *
 * - Single project: CLI-25 → CLI-**25** (suffix highlighted)
 * - Multi-project: CLI-WEBSITE-4 with alias "w" → CLI-**W**EBSITE-**4** (alias chars highlighted)
 *
 * @param shortId - Full short ID (e.g., "CLI-25", "CLI-WEBSITE-4")
 * @param options - Formatting options (projectSlug and/or projectAlias)
 * @returns Formatted short ID with highlights
 */
export function formatShortId(
  shortId: string,
  options?: FormatShortIdOptions | string
): string {
  const opts: FormatShortIdOptions =
    typeof options === "string" ? { projectSlug: options } : (options ?? {});

  const { projectSlug, projectAlias, isMultiProject } = opts;
  const upperShortId = shortId.toUpperCase();

  if (isMultiProject && projectAlias) {
    const formatted = formatShortIdWithAlias(upperShortId, projectAlias);
    if (formatted) {
      return formatted;
    }
  }

  if (projectSlug) {
    const prefix = `${projectSlug.toUpperCase()}-`;
    if (upperShortId.startsWith(prefix)) {
      const suffix = shortId.slice(prefix.length);
      return `${prefix}${colorTag("bu", suffix.toUpperCase())}`;
    }
  }

  return upperShortId;
}

/**
 * Compute the alias shorthand for an issue (e.g., "o1:d-a3", "w-2a").
 * This is what users type to reference the issue.
 *
 * @param shortId - Full short ID (e.g., "DASHBOARD-A3")
 * @param projectAlias - Project alias (e.g., "o1:d", "w")
 * @returns Alias shorthand (e.g., "o1:d-a3", "w-2a") or empty string if no alias
 */
function computeAliasShorthand(shortId: string, projectAlias?: string): string {
  if (!projectAlias) {
    return "";
  }
  const suffix = shortId.split("-").pop()?.toLowerCase() ?? "";
  return `${projectAlias}-${suffix}`;
}

// Issue Table Helpers

/** Minimum terminal width to show the TREND sparkline column. */
export const TREND_MIN_TERM_WIDTH = 100;

/**
 * Whether the TREND sparkline column will be rendered in the issue table.
 *
 * Returns `true` when the terminal is wide enough (≥ {@link TREND_MIN_TERM_WIDTH}).
 * Non-TTY output defaults to 80 columns, which is below the threshold.
 *
 * Display-only — the issue list command always requests seen-stats data from
 * the API regardless of this value so SEEN/AGE/EVENTS/USERS stay populated
 * when output is piped. See #1219.
 */
export function willShowTrend(): boolean {
  const termWidth = process.stdout.columns || 80;
  return termWidth >= TREND_MIN_TERM_WIDTH;
}

/** Lines per issue row in non-compact mode (2-line content + separator). */
const LINES_PER_DEFAULT_ROW = 3;

/**
 * Fixed line overhead for the rendered table.
 *
 * Top border (1) + header row (1) + header separator (1) + bottom border (1) = 4,
 * minus 1 because the last data row has no trailing separator (row separators
 * are drawn between data rows only: `r > 0 && r < allRows.length - 1`).
 * Net overhead = 3.
 */
const TABLE_LINE_OVERHEAD = 3;

/**
 * Determine whether auto-compact should activate based on terminal height.
 *
 * Returns `true` when the estimated non-compact table height exceeds the
 * terminal's row count, meaning compact mode would keep output on-screen.
 *
 * Returns `false` when terminal height is unknown (non-TTY/piped output)
 * to prefer full output for downstream parsing.
 *
 * @param rowCount - Number of issue rows to render
 * @returns Whether compact mode should be used
 */
export function shouldAutoCompact(rowCount: number): boolean {
  const termHeight = process.stdout.rows;
  if (!termHeight) {
    return false;
  }
  const estimatedHeight =
    rowCount * LINES_PER_DEFAULT_ROW + TABLE_LINE_OVERHEAD;
  return estimatedHeight > termHeight;
}

/**
 * Substatus label for the TREND column's second line.
 * Matches Sentry web UI visual indicators.
 */
export function substatusLabel(substatus?: string | null): string {
  switch (substatus) {
    case "regressed":
      return colorTag("red", "Regressed");
    case "escalating":
      return colorTag("yellow", "Escalating");
    case "new":
      return colorTag("green", "New");
    case "ongoing":
      return colorTag("muted", "Ongoing");
    default:
      return "";
  }
}

/**
 * Build issue subtitle from metadata for the ISSUE column.
 *
 * Prefers `metadata.value` (error message), falling back to
 * `metadata.type` + `metadata.function` for structured metadata.
 *
 * The result is a single line — truncation to the available column
 * width is handled by the table renderer's word-wrapping/truncation.
 *
 * @param metadata - Issue metadata from the API
 * @returns Subtitle string, or empty string if no relevant metadata
 */
export function formatIssueSubtitle(
  metadata?: SentryIssue["metadata"]
): string {
  if (!metadata) {
    return "";
  }
  if (metadata.value) {
    return collapseWhitespace(metadata.value);
  }
  const parts: string[] = [];
  if (metadata.type) {
    parts.push(metadata.type);
  }
  if (metadata.function) {
    parts.push(`in ${metadata.function}`);
  }
  return parts.join(" ");
}

/**
 * Collapse runs of whitespace (including newlines) into single spaces
 * and trim the result. Prevents multi-line metadata values from blowing
 * up the ISSUE cell height.
 */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Extract sparkline data points from the issue stats object.
 *
 * Stats keys depend on `groupStatsPeriod` ("24h", "14d", "auto", etc.).
 * Each entry in the time-series is `[timestamp, count]`.
 * Takes the first available key since the API returns one key matching
 * the requested period.
 *
 * @param stats - Issue stats object from the API
 * @returns Array of numeric counts for each time bucket
 */
export function extractStatsPoints(stats?: Record<string, unknown>): number[] {
  if (!stats) {
    return [];
  }
  const key = Object.keys(stats)[0];
  if (!key) {
    return [];
  }
  const buckets = stats[key];
  if (!Array.isArray(buckets)) {
    return [];
  }
  return buckets.map((b: unknown) =>
    Array.isArray(b) && b.length >= 2 ? Number(b[1]) || 0 : 0
  );
}

/** Row data prepared for the issue table */
export type IssueTableRow = {
  issue: SentryIssue;
  /** Org slug — used as project key in trimWithProjectGuarantee and similar utilities. */
  orgSlug: string;
  formatOptions: FormatShortIdOptions;
};

/**
 * Format the SHORT ID cell with optional alias.
 *
 * Default (2-line): linked short ID on line 1, muted alias on line 2.
 * Compact (single-line): alias appended as a suffix on the same line.
 *
 * @param issue - The Sentry issue
 * @param formatOptions - Formatting options with alias info
 * @param compact - Whether to use single-line layout
 * @returns Cell string
 */
function formatIdCell(
  issue: SentryIssue,
  formatOptions: FormatShortIdOptions,
  compact = false
): string {
  const formatted = formatShortId(issue.shortId, formatOptions);
  const linked = issue.permalink
    ? `[${formatted}](${issue.permalink})`
    : formatted;
  const alias = computeAliasShorthand(
    issue.shortId,
    formatOptions.projectAlias
  );
  if (alias) {
    const sep = compact ? " " : "\n";
    return `${linked}${sep}${colorTag("muted", alias)}`;
  }
  return linked;
}

/**
 * Format the ISSUE cell.
 *
 * Default (2-line): bold title on line 1, muted subtitle on line 2.
 * Compact (single-line): bold title only — truncated with "…" by the renderer.
 *
 * @param issue - The Sentry issue
 * @param compact - Whether to use single-line layout
 * @returns Cell string
 */
function formatIssueCell(issue: SentryIssue, compact = false): string {
  const title = `**${escapeMarkdownInline(issue.title)}**`;
  if (compact) {
    return title;
  }
  const subtitle = formatIssueSubtitle(issue.metadata);
  if (subtitle) {
    return `${title}\n${colorTag("muted", escapeMarkdownInline(subtitle))}`;
  }
  return title;
}

/**
 * Format the TREND cell with sparkline and substatus label.
 *
 * Default (2-line): sparkline on line 1, substatus label on line 2.
 * Compact (single-line): sparkline + substatus on the same line.
 *
 * @param issue - The Sentry issue
 * @param compact - Whether to use single-line layout
 * @returns Cell string
 */
function formatTrendCell(issue: SentryIssue, compact = false): string {
  const points = extractStatsPoints(
    issue.stats as Record<string, unknown> | undefined
  );
  const graph = points.length > 0 ? colorTag("muted", sparkline(points)) : "";
  const status = substatusLabel(issue.substatus);
  const parts = [graph, status].filter(Boolean);
  const sep = compact ? " " : "\n";
  return parts.join(sep);
}

/**
 * Write an issue list as a Unicode-bordered markdown table.
 *
 * Columns match the Sentry web UI issue stream layout:
 *
 * | SHORT ID (+ alias) | ISSUE | SEEN | AGE | TREND | EVENTS | USERS | TRIAGE |
 *
 * Default mode: 2-line rows (title + subtitle, sparkline + substatus, etc.)
 * for maximum information density. Row separators drawn between rows.
 *
 * Compact mode (`--compact`): single-line rows for quick scanning. All cells
 * collapsed to one line, long titles truncated with "…".
 *
 * Callers should resolve auto-compact (via {@link shouldAutoCompact}) before
 * passing `compact` — this function treats `undefined` as `false`.
 *
 * @param stdout - Output writer
 * @param rows - Issues with formatting options
 * @param options - Display options
 */
export function writeIssueTable(
  stdout: Writer,
  rows: IssueTableRow[],
  options?: { compact?: boolean }
): void {
  const compact = options?.compact ?? false;
  const showTrend = willShowTrend();

  const columns: Column<IssueTableRow>[] = [
    // SHORT ID — primary identifier (+ alias), never shrink
    {
      header: "SHORT ID",
      shrinkable: false,
      value: ({ issue, formatOptions }) =>
        formatIdCell(issue, formatOptions, compact),
    },
    // ISSUE — title (+ subtitle in default mode)
    {
      header: "ISSUE",
      value: ({ issue }) => formatIssueCell(issue, compact),
    },
    // SEEN — lastSeen
    {
      header: "SEEN",
      value: ({ issue }) => formatRelativeTime(issue.lastSeen ?? undefined),
    },
    // AGE — firstSeen
    {
      header: "AGE",
      value: ({ issue }) => formatRelativeTime(issue.firstSeen ?? undefined),
    },
  ];

  // TREND — sparkline + substatus (2-line), auto-hidden on narrow terminals
  if (showTrend) {
    columns.push({
      header: "TREND",
      value: ({ issue }) => formatTrendCell(issue, compact),
      shrinkable: false,
    });
  }

  columns.push(
    // EVENTS — period-scoped count
    {
      header: "EVENTS",
      value: ({ issue }) => abbreviateCount(`${issue.count}`),
      align: "right",
    },
    // USERS — affected user count
    {
      header: "USERS",
      value: ({ issue }) => abbreviateCount(`${issue.userCount ?? 0}`),
      align: "right",
    },
    // TRIAGE — combined priority + fixability for actionability
    {
      header: "TRIAGE",
      value: ({ issue }) =>
        formatTriageCell(issue.priority, issue.seerFixabilityScore),
    }
  );

  // Row separators colored with the muted palette color (#898294 → RGB 137,130,148)
  // so they're lighter than the solid outer borders.
  const mutedAnsi = "\x1b[38;2;137;130;148m";
  writeTable(stdout, rows, columns, {
    rowSeparator: mutedAnsi,
    truncate: true,
  });
}

/** Weight assigned to each priority level for composite triage scoring. */
const PRIORITY_WEIGHTS: Record<string, number> = {
  critical: 1.0,
  high: 0.75,
  medium: 0.5,
  low: 0.25,
};

/** Default impact weight when priority is unknown. */
const DEFAULT_IMPACT_WEIGHT = 0.5;

/** How much impact (priority) contributes to the composite score. */
const IMPACT_RATIO = 0.6;

/**
 * Compute composite triage score from priority and fixability.
 *
 * The score blends impact (from priority) and fixability (from Seer)
 * using a weighted average: `impact × 0.6 + fixability × 0.4`.
 * Higher scores mean "fix this first" — high impact AND easy to fix.
 *
 * @param priority - Priority string from the API
 * @param fixabilityScore - Seer fixability score (0–1)
 * @returns Composite score (0–1), or null if neither dimension is available
 */
function computeTriageScore(
  priority?: string | null,
  fixabilityScore?: number | null
): number | null {
  const hasPriority = Boolean(priority);
  const hasFix = fixabilityScore !== null && fixabilityScore !== undefined;

  if (!(hasPriority || hasFix)) {
    return null;
  }

  const impact = hasPriority
    ? (PRIORITY_WEIGHTS[priority?.toLowerCase() ?? ""] ?? DEFAULT_IMPACT_WEIGHT)
    : DEFAULT_IMPACT_WEIGHT;

  const fix = hasFix ? fixabilityScore : DEFAULT_IMPACT_WEIGHT;

  return impact * IMPACT_RATIO + fix * (1 - IMPACT_RATIO);
}

/**
 * Format the TRIAGE cell as a single-line composite score.
 *
 * Combines priority (impact) and Seer fixability into a single percentage
 * that answers "should I fix this now?". The score is colored by tier:
 * green (≥67%), yellow (34–66%), red (≤33%).
 *
 * Displays:
 * - Both available: `"High 82%"` — priority label + composite score
 * - Priority only: `"High"` — just the label (no score without fixability)
 * - Fixability only: `"78%"` — composite score alone
 * - Neither: empty
 *
 * @param priority - Priority string from the API
 * @param fixabilityScore - Seer AI fixability score (0–1)
 * @returns Single-line cell string
 */
function formatTriageCell(
  priority?: string | null,
  fixabilityScore?: number | null
): string {
  const hasFix = fixabilityScore !== null && fixabilityScore !== undefined;
  const label = formatPriorityLabel(priority);
  const score = computeTriageScore(priority, fixabilityScore);

  // No data at all
  if (score === null) {
    return "";
  }

  // Priority without fixability — show label only (no fake %)
  if (!hasFix) {
    return label;
  }

  // Format the composite percentage
  const pct = Math.round(score * 100);
  const tier = getSeerFixabilityLabel(score);
  const tag = FIXABILITY_TAGS[tier];
  const pctStr = colorTag(tag, `${pct}%`);

  return label ? `${label} ${pctStr}` : pctStr;
}

/**
 * Format priority as a colored label.
 *
 * @param priority - Priority string from the API
 * @returns Colored label or empty string
 */
function formatPriorityLabel(priority?: string | null): string {
  if (!priority) {
    return "";
  }
  switch (priority.toLowerCase()) {
    case "critical":
      return colorTag("red", "Critical");
    case "high":
      return colorTag("red", "High");
    case "medium":
      return colorTag("yellow", "Med ");
    case "low":
      return colorTag("muted", "Low ");
    default:
      return priority;
  }
}

/**
 * Format detailed issue information as rendered markdown.
 *
 * @param issue - The Sentry issue to format
 * @returns Rendered terminal string
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: issue formatting logic
export function formatIssueDetails(issue: SentryIssue): string {
  const lines: string[] = [];

  lines.push(`## ${issue.shortId}: ${escapeMarkdownInline(issue.title ?? "")}`);
  lines.push("");

  // Key-value details as a table
  const kvRows: [string, string][] = [];

  kvRows.push([
    "Status",
    `${formatStatusLabel(issue.status)}${issue.substatus ? ` (${capitalize(issue.substatus)})` : ""}`,
  ]);

  if (issue.priority) {
    kvRows.push(["Priority", capitalize(issue.priority)]);
  }

  if (
    issue.seerFixabilityScore !== null &&
    issue.seerFixabilityScore !== undefined
  ) {
    const tier = getSeerFixabilityLabel(issue.seerFixabilityScore);
    const fixDetail = formatFixabilityDetail(issue.seerFixabilityScore);
    kvRows.push(["Fixability", colorTag(FIXABILITY_TAGS[tier], fixDetail)]);
  }

  let levelLine = issue.level ?? "unknown";
  if (issue.isUnhandled) {
    levelLine += " (unhandled)";
  }
  kvRows.push(["Level", levelLine]);
  kvRows.push(["Platform", issue.platform ?? "unknown"]);
  kvRows.push(["Type", issue.type ?? "unknown"]);
  kvRows.push([
    "Assignee",
    escapeMarkdownInline(String(issue.assignedTo?.name ?? "Unassigned")),
  ]);

  if (issue.project) {
    kvRows.push([
      "Project",
      `${escapeMarkdownInline(issue.project.name ?? "(unknown)")} (${safeCodeSpan(issue.project.slug ?? "")})`,
    ]);
  }

  const firstReleaseVersion = issue.firstRelease?.shortVersion;
  const lastReleaseVersion = issue.lastRelease?.shortVersion;
  if (firstReleaseVersion || lastReleaseVersion) {
    const first = escapeMarkdownInline(String(firstReleaseVersion ?? ""));
    const last = escapeMarkdownInline(String(lastReleaseVersion ?? ""));
    if (firstReleaseVersion && lastReleaseVersion) {
      if (firstReleaseVersion === lastReleaseVersion) {
        kvRows.push(["Release", first]);
      } else {
        kvRows.push(["Releases", `${first} → ${last}`]);
      }
    } else if (lastReleaseVersion) {
      kvRows.push(["Release", last]);
    } else if (firstReleaseVersion) {
      kvRows.push(["Release", first]);
    }
  }

  kvRows.push(["Events", String(issue.count ?? 0)]);
  kvRows.push(["Users", String(issue.userCount ?? 0)]);

  if (issue.firstSeen) {
    let firstSeenLine = new Date(issue.firstSeen).toLocaleString();
    if (firstReleaseVersion) {
      firstSeenLine += ` (in ${escapeMarkdownCell(String(firstReleaseVersion))})`;
    }
    kvRows.push(["First seen", firstSeenLine]);
  }
  if (issue.lastSeen) {
    let lastSeenLine = new Date(issue.lastSeen).toLocaleString();
    if (lastReleaseVersion && lastReleaseVersion !== firstReleaseVersion) {
      lastSeenLine += ` (in ${escapeMarkdownCell(String(lastReleaseVersion))})`;
    }
    kvRows.push(["Last seen", lastSeenLine]);
  }

  if (issue.culprit) {
    kvRows.push(["Culprit", safeCodeSpan(issue.culprit)]);
  }

  kvRows.push(["Link", issue.permalink ?? ""]);

  lines.push(mdKvTable(kvRows));

  if (issue.metadata?.value) {
    lines.push("");
    lines.push("**Message:**");
    lines.push("");
    lines.push(
      `> ${escapeMarkdownInline(issue.metadata.value).replace(/\n/g, "\n> ")}`
    );
  }

  if (issue.metadata?.filename) {
    lines.push("");
    lines.push(`**File:** \`${issue.metadata.filename}\``);
  }
  if (issue.metadata?.function) {
    lines.push(`**Function:** \`${issue.metadata.function}\``);
  }

  return renderMarkdown(lines.join("\n"));
}

// Stack Trace Formatting

/**
 * Format a single stack frame as markdown.
 */
function formatStackFrameMarkdown(frame: StackFrame): string {
  const lines: string[] = [];
  const fn = frame.function || "<anonymous>";
  const file = frame.filename || frame.absPath || "<unknown>";
  const line = frame.lineNo ?? "?";
  const col = frame.colNo ?? "?";
  const inAppTag = frame.inApp ? " `[in-app]`" : "";

  lines.push(`${safeCodeSpan(`at ${fn} (${file}:${line}:${col})`)}${inAppTag}`);

  if (frame.context && frame.context.length > 0) {
    lines.push("");
    lines.push("```");
    for (const [lineNo, code] of frame.context) {
      const isCurrentLine = lineNo === frame.lineNo;
      const prefix = isCurrentLine ? ">" : " ";
      lines.push(`${prefix} ${String(lineNo).padStart(6)} | ${code}`);
    }
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format an exception value (type, message, stack trace) as markdown.
 */
function formatExceptionValueMarkdown(exception: ExceptionValue): string {
  const lines: string[] = [];

  const type = exception.type || "Error";
  const value = exception.value || "";
  lines.push(`**${safeCodeSpan(`${type}: ${value}`)}**`);

  if (exception.mechanism) {
    const handled = exception.mechanism.handled ? "handled" : "unhandled";
    const mechType = exception.mechanism.type || "unknown";
    lines.push(`*mechanism: ${mechType} (${handled})*`);
  }
  lines.push("");

  const frames = exception.stacktrace?.frames ?? [];
  const reversedFrames = [...frames].reverse();
  for (const frame of reversedFrames) {
    lines.push(formatStackFrameMarkdown(frame));
  }

  return lines.join("\n");
}

/**
 * Build the stack trace section as markdown.
 */
function buildStackTraceMarkdown(exceptionEntry: ExceptionEntry): string {
  const lines: string[] = [];
  lines.push("### Stack Trace");
  lines.push("");

  const values = exceptionEntry.data.values ?? [];
  for (const exception of values) {
    lines.push(formatExceptionValueMarkdown(exception));
  }

  return lines.join("\n");
}

// Breadcrumbs Formatting

/**
 * Build the breadcrumbs section as a markdown table.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: breadcrumb formatting logic
function buildBreadcrumbsMarkdown(breadcrumbsEntry: BreadcrumbsEntry): string {
  const breadcrumbs = breadcrumbsEntry.data.values ?? [];
  if (breadcrumbs.length === 0) {
    return "";
  }

  const lines: string[] = [];
  lines.push("### Breadcrumbs");
  lines.push("");
  lines.push(mdTableHeader(["Time", "Level", "Category", "Message"]).trimEnd());

  for (const breadcrumb of breadcrumbs) {
    const timestamp = breadcrumb.timestamp
      ? new Date(breadcrumb.timestamp).toLocaleTimeString()
      : "??:??:??";

    const level = breadcrumb.level ?? "info";

    let message = breadcrumb.message ?? "";
    if (!message && breadcrumb.data) {
      const data = breadcrumb.data as Record<string, unknown>;
      if (data.url && data.method) {
        const status = data.status_code ? ` → ${data.status_code}` : "";
        message = `${data.method} ${data.url}${status}`;
      } else if (data.from && data.to) {
        message = `${data.from} → ${data.to}`;
      } else if (data.arguments && Array.isArray(data.arguments)) {
        message = String(data.arguments[0] || "").slice(0, 60);
      }
    }

    if (message.length > 80) {
      message = `${message.slice(0, 77)}...`;
    }

    // Escape special markdown characters that would break the table cell
    const safeMessage = escapeMarkdownCell(message);
    const safeCategory = escapeMarkdownCell(breadcrumb.category ?? "default");

    lines.push(mdRow([timestamp, level, safeCategory, safeMessage]).trimEnd());
  }

  return lines.join("\n");
}

// Request Formatting

/**
 * Build the HTTP request section as markdown.
 */
function buildRequestMarkdown(requestEntry: RequestEntry): string {
  const data = requestEntry.data;
  if (!data.url) {
    return "";
  }

  const lines: string[] = [];
  lines.push("### Request");
  lines.push("");
  const method = data.method || "GET";
  lines.push(`\`${method} ${data.url}\``);

  if (data.headers) {
    const headerEntries = Array.isArray(data.headers)
      ? data.headers
      : Object.entries(data.headers);
    for (const [key, value] of headerEntries) {
      if (key.toLowerCase() === "user-agent") {
        const truncatedUA =
          value.length > 100 ? `${value.slice(0, 97)}...` : value;
        lines.push(`**User-Agent:** ${truncatedUA}`);
        break;
      }
    }
  }

  return lines.join("\n");
}

// Span Tree Formatting

/**
 * Apply muted styling only in TTY/colored mode.
 *
 * Tree output uses box-drawing characters and indentation that can't go
 * through full `renderMarkdown()`. This helper ensures no raw ANSI escapes
 * leak when `NO_COLOR` is set, output is piped, or `isPlainOutput()` is true.
 */
export function plainSafeMuted(text: string): string {
  return isPlainOutput() ? text : muted(text);
}

type FormatSpanOptions = {
  lines: string[];
  prefix: string;
  isLast: boolean;
  currentDepth: number;
  maxDepth: number;
};

/**
 * Recursively format a span and its children as simple tree lines.
 * Uses "op — description (duration)" format.
 * Duration is omitted when unavailable.
 */
function formatSpanSimple(span: TraceSpan, opts: FormatSpanOptions): void {
  const { lines, prefix, isLast, currentDepth, maxDepth } = opts;
  const op = span.op || span["transaction.op"] || "unknown";
  const desc = span.description || span.transaction || "(no description)";

  const branch = isLast ? "└─" : "├─";
  const childPrefix = prefix + (isLast ? "   " : "│  ");

  const colorizedDesc = isDbSpanOp(op) ? colorizeSql(desc) : desc;
  let line = `${prefix}${branch} ${plainSafeMuted(op)} — ${colorizedDesc}`;

  const durationMs = computeSpanDurationMs(span);
  if (durationMs !== undefined) {
    line += `  ${plainSafeMuted(`(${prettyMs(durationMs)})`)}`;
  }

  line += `  ${plainSafeMuted(span.span_id ?? "")}`;

  lines.push(line);

  if (currentDepth < maxDepth) {
    const children = span.children ?? [];
    const childCount = children.length;
    children.forEach((child, i) => {
      formatSpanSimple(child, {
        lines,
        prefix: childPrefix,
        isLast: i === childCount - 1,
        currentDepth: currentDepth + 1,
        maxDepth,
      });
    });
  }
}

/**
 * Maximum number of root-level spans to display before truncating.
 * Prevents overwhelming output when traces have thousands of flat root spans
 * (common in projects with very high span volume or flat hierarchies).
 */
const MAX_ROOT_SPANS = 50;

/** Options for {@link formatSimpleSpanTree}. */
type SpanTreeOptions = {
  /**
   * When true, the tree was produced by a project-filtered API call.
   * Root spans with `parent_span_id` are annotated as having a parent
   * in another project. Without this flag the annotation is suppressed
   * because root spans in unfiltered traces can legitimately have
   * `parent_span_id` at service boundaries.
   */
  projectFiltered?: boolean;
};

/**
 * Format trace as a simple tree with "op — description (duration)" per span.
 * Durations are shown when available, omitted otherwise.
 *
 * Root spans are capped at {@link MAX_ROOT_SPANS} to prevent terminal flooding
 * when traces contain thousands of flat spans.
 *
 * @param traceId - The trace ID for the header
 * @param spans - Root-level spans from the /trace/ API
 * @param maxDepth - Maximum nesting depth to display (default: unlimited). 0 = disabled, Infinity = unlimited.
 * @param options - Optional display options (e.g., project filter indicator)
 * @returns Array of formatted lines ready for display
 */
export function formatSimpleSpanTree(
  traceId: string,
  spans: TraceSpan[],
  maxDepth = Number.MAX_SAFE_INTEGER,
  options: SpanTreeOptions = {}
): string[] {
  return withSerializeSpan("formatSimpleSpanTree", () => {
    // maxDepth = 0 means disabled (caller should skip, but handle gracefully)
    if (maxDepth === 0 || spans.length === 0) {
      return [];
    }

    // Infinity or large numbers = unlimited depth
    const effectiveMaxDepth = Number.isFinite(maxDepth)
      ? maxDepth
      : Number.MAX_SAFE_INTEGER;

    const lines: string[] = [];
    lines.push("");
    lines.push(plainSafeMuted("─── Span Tree ───"));
    lines.push("");
    lines.push(`${plainSafeMuted("Trace —")} ${traceId}`);

    // When API filters by project, root spans may have a parent_span_id
    // pointing to a span in another project that wasn't returned.
    // Only show this annotation when a project filter is active — in
    // unfiltered traces, root spans at service boundaries legitimately
    // have parent_span_id without implying missing data.
    if (options.projectFiltered && spans.some((s) => s.parent_span_id)) {
      lines.push(plainSafeMuted("⤴ parent span in another project"));
    }

    const totalRootSpans = spans.length;
    const truncated = totalRootSpans > MAX_ROOT_SPANS;
    const displaySpans = truncated ? spans.slice(0, MAX_ROOT_SPANS) : spans;
    const displayCount = displaySpans.length;

    displaySpans.forEach((span, i) => {
      formatSpanSimple(span, {
        lines,
        prefix: "",
        isLast: !truncated && i === displayCount - 1,
        currentDepth: 1,
        maxDepth: effectiveMaxDepth,
      });
    });

    if (truncated) {
      const remaining = totalRootSpans - MAX_ROOT_SPANS;
      lines.push(
        `└─ ${plainSafeMuted(`... ${remaining} more root span${remaining === 1 ? "" : "s"} (${totalRootSpans} total). Use --json to see all.`)}`
      );
    }

    return lines;
  });
}

// Environment Context Formatting

/**
 * Build environment context section (browser, OS, device) as markdown.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: context formatting logic
function buildEnvironmentMarkdown(event: SentryEvent): string {
  const contexts = event.contexts;
  if (!contexts) {
    return "";
  }

  const kvRows: [string, string][] = [];

  if (contexts.browser) {
    const name = contexts.browser.name || "Unknown Browser";
    const version = contexts.browser.version || "";
    kvRows.push(["Browser", `${name}${version ? ` ${version}` : ""}`]);
  }

  if (contexts.os) {
    const name = contexts.os.name || "Unknown OS";
    const version = contexts.os.version || "";
    kvRows.push(["OS", `${name}${version ? ` ${version}` : ""}`]);
  }

  if (contexts.device) {
    const family = contexts.device.family || contexts.device.model || "";
    const brand = contexts.device.brand || "";
    if (family || brand) {
      const device = brand ? `${family} (${brand})` : family;
      kvRows.push(["Device", device]);
    }
  }

  if (kvRows.length === 0) {
    return "";
  }

  return mdKvTable(kvRows, "Environment");
}

/**
 * Build user information section as markdown.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: user formatting logic
function buildUserMarkdown(event: SentryEvent): string {
  const user = event.user;
  if (!user) {
    return "";
  }

  const hasUserData =
    user.email ||
    user.username ||
    user.id ||
    user.ip_address ||
    user.name ||
    user.geo;

  if (!hasUserData) {
    return "";
  }

  const kvRows: [string, string][] = [];

  if (user.name) {
    kvRows.push(["Name", user.name]);
  }
  if (user.email) {
    kvRows.push(["Email", user.email]);
  }
  if (user.username) {
    kvRows.push(["Username", user.username]);
  }
  if (user.id) {
    kvRows.push(["ID", user.id]);
  }
  if (user.ip_address) {
    kvRows.push(["IP", user.ip_address]);
  }

  if (user.geo) {
    const geo = user.geo;
    const parts: string[] = [];
    if (geo.city) {
      parts.push(geo.city);
    }
    if (geo.region && geo.region !== geo.city) {
      parts.push(geo.region);
    }
    if (geo.country_code) {
      parts.push(`(${geo.country_code})`);
    }
    if (parts.length > 0) {
      kvRows.push(["Location", parts.join(", ")]);
    }
  }

  return mdKvTable(kvRows, "User");
}

/**
 * Build replay link section as markdown.
 */
function buildReplayMarkdown(
  event: SentryEvent,
  issuePermalink?: string
): string {
  const replayId = getReplayIdFromEvent(event);
  if (!replayId) {
    return "";
  }

  const lines: string[] = [];
  lines.push("### Replay");
  lines.push("");
  lines.push(`**ID:** \`${replayId}\``);

  if (issuePermalink) {
    const match = BASE_URL_REGEX.exec(issuePermalink);
    if (match?.[1]) {
      lines.push(`**Link:** ${match[1]}/explore/replays/${replayId}/`);
    }
  }

  return lines.join("\n");
}

// Event Formatting

/**
 * Format event details for display as rendered markdown.
 *
 * @param event - The Sentry event to format
 * @param header - Optional header text (defaults to "Latest Event")
 * @param issuePermalink - Optional issue permalink for constructing replay links
 * @returns Rendered terminal string
 */
export function formatEventDetails(
  event: SentryEvent,
  header = "Latest Event",
  issuePermalink?: string
): string {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Event formatting requires multiple conditional sections
  return withSerializeSpan("formatEventDetails", () => {
    const sections: string[] = [];

    // The heading is copy-pasted into `event view`. A short prefix is not
    // searchable, so include the full ID unless the caller already did.
    const heading = header.includes(event.eventID)
      ? `## ${escapeMarkdownInline(header)}`
      : `## ${escapeMarkdownInline(header)} (\`${event.eventID}\`)`;
    sections.push(heading);
    sections.push("");

    // Basic info table
    const infoKvRows: [string, string][] = [];
    infoKvRows.push(["Event ID", `\`${event.eventID}\``]);
    if (event.dateReceived) {
      infoKvRows.push([
        "Received",
        new Date(event.dateReceived).toLocaleString(),
      ]);
    }
    if (event.location) {
      infoKvRows.push(["Location", safeCodeSpan(event.location)]);
    }

    const traceCtx = event.contexts?.trace;
    if (traceCtx?.trace_id) {
      infoKvRows.push(["Trace", safeCodeSpan(traceCtx.trace_id)]);
    }

    if (event.sdk?.name || event.sdk?.version) {
      // Wrap in backtick code span — SDK names like sentry.python.aws_lambda
      // contain underscores that markdown would otherwise render as emphasis.
      const sdkName = event.sdk.name ?? "unknown";
      const sdkVersion = event.sdk.version ?? "";
      const sdkInfo = `${sdkName}${sdkVersion ? ` ${sdkVersion}` : ""}`;
      infoKvRows.push(["SDK", `\`${sdkInfo}\``]);
    }

    if (event.release?.shortVersion) {
      infoKvRows.push(["Release", String(event.release.shortVersion)]);
    }

    if (infoKvRows.length > 0) {
      sections.push(mdKvTable(infoKvRows));
    }

    // User section
    const userSection = buildUserMarkdown(event);
    if (userSection) {
      sections.push("");
      sections.push(userSection);
    }

    // Environment section
    const envSection = buildEnvironmentMarkdown(event);
    if (envSection) {
      sections.push("");
      sections.push(envSection);
    }

    // HTTP Request section
    const requestEntry = extractEntry(event, "request");
    if (requestEntry) {
      const requestSection = buildRequestMarkdown(requestEntry);
      if (requestSection) {
        sections.push("");
        sections.push(requestSection);
      }
    }

    // Stack Trace
    const exceptionEntry = extractEntry(event, "exception");
    if (exceptionEntry) {
      sections.push("");
      sections.push(buildStackTraceMarkdown(exceptionEntry));
    }

    // Breadcrumbs
    const breadcrumbsEntry = extractEntry(event, "breadcrumbs");
    if (breadcrumbsEntry) {
      const breadcrumbSection = buildBreadcrumbsMarkdown(breadcrumbsEntry);
      if (breadcrumbSection) {
        sections.push("");
        sections.push(breadcrumbSection);
      }
    }

    // Replay link
    const replaySection = buildReplayMarkdown(event, issuePermalink);
    if (replaySection) {
      sections.push("");
      sections.push(replaySection);
    }

    // Tags
    if (event.tags?.length) {
      sections.push("");
      sections.push("### Tags");
      sections.push("");
      sections.push(mdTableHeader(["Key", "Value"]).trimEnd());
      for (const tag of event.tags) {
        sections.push(
          mdRow([
            `\`${tag.key}\``,
            escapeMarkdownCell(String(tag.value)),
          ]).trimEnd()
        );
      }
    }

    return renderMarkdown(sections.join("\n"));
  });
}

// Organization Formatting

/**
 * Format detailed organization information as rendered markdown.
 *
 * @param org - The Sentry organization to format
 * @returns Rendered terminal string
 */
export function formatOrgDetails(org: SentryOrganization): string {
  const lines: string[] = [];

  lines.push(
    `## ${escapeMarkdownInline(org.slug)}: ${escapeMarkdownInline(org.name || "(unnamed)")}`
  );
  lines.push("");

  const kvRows: [string, string][] = [];
  kvRows.push(["Slug", `\`${org.slug || "(none)"}\``]);
  kvRows.push(["Name", escapeMarkdownInline(org.name || "(unnamed)")]);
  kvRows.push(["ID", String(org.id)]);
  if (org.dateCreated) {
    kvRows.push(["Created", new Date(org.dateCreated).toLocaleString()]);
  }
  kvRows.push(["2FA", org.require2FA ? "Required" : "Not required"]);
  kvRows.push(["Early Adopter", org.isEarlyAdopter ? "Yes" : "No"]);
  // orgRole is returned by the detail API but not yet typed in the SDK
  const orgRole = (org as Record<string, unknown>).orgRole as
    | string
    | undefined;
  if (orgRole) {
    kvRows.push(["Your Role", orgRole]);
  }

  lines.push(mdKvTable(kvRows));

  const featuresSection = formatFeaturesMarkdown(org.features);
  if (featuresSection) {
    lines.push(featuresSection);
  }

  return renderMarkdown(lines.join("\n"));
}

/**
 * Format detailed project information as rendered markdown.
 *
 * @param project - The Sentry project to format
 * @param dsn - Optional DSN string to display
 * @returns Rendered terminal string
 */
export function formatProjectDetails(
  project: SentryProject,
  dsn?: string | null
): string {
  const lines: string[] = [];

  lines.push(
    `## ${escapeMarkdownInline(project.slug)}: ${escapeMarkdownInline(project.name || "(unnamed)")}`
  );
  lines.push("");

  const kvRows: [string, string][] = [];
  kvRows.push(["Slug", `\`${project.slug || "(none)"}\``]);
  kvRows.push(["Name", escapeMarkdownInline(project.name || "(unnamed)")]);
  kvRows.push(["ID", String(project.id)]);
  kvRows.push(["Platform", project.platform || "Not set"]);
  kvRows.push(["DSN", `\`${dsn || "No DSN available"}\``]);
  kvRows.push(["Status", project.status ?? "unknown"]);
  if (project.dateCreated) {
    kvRows.push(["Created", new Date(project.dateCreated).toLocaleString()]);
  }
  if (project.organization) {
    const orgName = resolveOrgDisplayName(
      project.organization.slug,
      project.organization.name
    );
    kvRows.push([
      "Organization",
      `${escapeMarkdownInline(orgName)} (${safeCodeSpan(project.organization.slug)})`,
    ]);
  }
  if (project.firstEvent) {
    kvRows.push(["First Event", new Date(project.firstEvent).toLocaleString()]);
  } else {
    kvRows.push(["First Event", "No events yet"]);
  }

  kvRows.push(["Sessions", project.hasSessions ? "Yes" : "No"]);
  kvRows.push(["Replays", project.hasReplays ? "Yes" : "No"]);
  kvRows.push(["Profiles", project.hasProfiles ? "Yes" : "No"]);
  kvRows.push(["Monitors", project.hasMonitors ? "Yes" : "No"]);

  lines.push(mdKvTable(kvRows));

  const featuresSection = formatFeaturesMarkdown(project.features);
  if (featuresSection) {
    lines.push(featuresSection);
  }

  return renderMarkdown(lines.join("\n"));
}

// User Identity Formatting

/**
 * User identity fields for display formatting.
 * Accepts both UserInfo (userId) and token response user (id) shapes.
 */
type UserIdentityInput = {
  /** User ID (from token response) */
  id?: string;
  /** User ID (from stored UserInfo) */
  userId?: string;
  email?: string;
  username?: string;
  /** Display name (different from username) */
  name?: string;
};

/**
 * Format user identity for display.
 * Prefers name over username, handles missing fields gracefully.
 *
 * @param user - User identity object (supports both id and userId fields)
 * @returns Formatted string like "Name <email>" or fallback to available fields
 */
export function formatUserIdentity(user: UserIdentityInput): string {
  const { name, username, email, id, userId } = user;
  const displayName = name ?? username;
  const finalId = id ?? userId;

  if (displayName && email) {
    return `${displayName} <${email}>`;
  }
  if (displayName) {
    return displayName;
  }
  if (email) {
    return email;
  }
  // Fallback to user ID if no name/username/email
  return `user ${finalId}`;
}

/** Data shape yielded by `whoami` for `sntrys_` org auth tokens. */
export type OrgTokenIdentity = {
  type: "org-auth-token";
  organization?: string;
  url: string;
  regionUrl?: string;
};

/**
 * Format org-auth-token identity for `sentry auth whoami`.
 * Renders "Organization: <slug> (<url>)" or just the URL when slug is unknown.
 */
export function formatOrgTokenIdentity(data: OrgTokenIdentity): string {
  const rows: Array<readonly [string, string]> = [];
  rows.push(["Token type", "Organization auth token"]);
  if (data.organization) {
    rows.push(["Organization", data.organization]);
  }
  rows.push(["Instance", data.url]);
  if (data.regionUrl) {
    rows.push(["Region", data.regionUrl]);
  }
  return renderMarkdown(mdKvTable(rows));
}

// Token Formatting

/**
 * Mask a token for display
 */
export function maskToken(token: string): string {
  if (token.length <= 12) {
    return "****";
  }
  return `${token.substring(0, 8)}...${token.substring(token.length - 4)}`;
}

/**
 * Format a duration in seconds as a human-readable string.
 *
 * @param seconds - Duration in seconds
 * @returns Human-readable duration (e.g., "5 minutes", "2 hours", "1 hour and 30 minutes")
 */
/** Format a count with its unit, handling singular/plural */
function pluralUnit(count: number, unit: string): string {
  return `${count} ${unit}${count !== 1 ? "s" : ""}`;
}

/** Format a major + minor unit pair, omitting minor when zero */
function durationPair(
  major: number,
  majorUnit: string,
  minor: number,
  minorUnit: string
): string {
  if (minor === 0) {
    return pluralUnit(major, majorUnit);
  }
  return `${pluralUnit(major, majorUnit)} and ${pluralUnit(minor, minorUnit)}`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return pluralUnit(minutes, "minute");
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return durationPair(hours, "hour", minutes % 60, "minute");
  }

  const days = Math.floor(hours / 24);

  if (days < 7) {
    return durationPair(days, "day", hours % 24, "hour");
  }

  return durationPair(Math.floor(days / 7), "week", days % 7, "day");
}

/**
 * Format token expiration info
 */
export function formatExpiration(expiresAt: number): string {
  const expiresDate = new Date(expiresAt);
  const now = new Date();

  if (expiresDate <= now) {
    return "Expired";
  }

  const secondsRemaining = Math.round(
    (expiresDate.getTime() - now.getTime()) / 1000
  );
  return `${expiresDate.toLocaleString()} (${formatDuration(secondsRemaining)} remaining)`;
}

// Feedback Formatting

/** Structured feedback result (imported from the command module) */
type FeedbackResult = import("../../commands/cli/feedback.js").FeedbackResult;

/**
 * Format feedback submission result as rendered markdown.
 *
 * @param data - Structured feedback result from the command
 * @returns Rendered terminal string
 */
export function formatFeedbackResult(data: FeedbackResult): string {
  if (data.sent) {
    return renderMarkdown(
      `${colorTag("green", "✓")} Feedback submitted. Thank you!`
    );
  }
  return renderMarkdown(
    `${colorTag("yellow", "⚠")} Feedback may not have been sent (network timeout).`
  );
}

// Auth Logout Formatting

/** Structured logout result data (imported from the command module) */
type LogoutResult = import("../../commands/auth/logout.js").LogoutResult;

/**
 * Format logout result as rendered markdown.
 *
 * @param data - Structured logout result from the command
 * @returns Rendered terminal string
 */
export function formatLogoutResult(data: LogoutResult): string {
  if (!data.loggedOut) {
    return renderMarkdown(data.message ?? "Not currently authenticated.");
  }
  const lines: string[] = [];
  lines.push(`${colorTag("green", "✓")} Logged out successfully.`);
  if (data.configPath) {
    lines.push(`Credentials removed from: ${safeCodeSpan(data.configPath)}`);
  }
  return renderMarkdown(lines.join("\n\n"));
}

// Auth Status Formatting

/** Structured auth status data shape (re-imported from the command module) */
type AuthStatusData = import("../../commands/auth/status.js").AuthStatusData;

/**
 * Build the markdown header line based on auth source.
 */
function formatAuthHeader(source: string): string {
  if (source.startsWith("env:")) {
    const varName = source.slice("env:".length);
    return `## ${colorTag("green", "✓")} Authenticated via ${escapeMarkdownInline(varName)} environment variable`;
  }
  return `## ${colorTag("green", "✓")} Authenticated`;
}

/** Select a precise credential label for the auth status table. */
function authTokenLabel(isEnv: boolean, isOAuthAccessToken: boolean): string {
  if (isEnv) {
    return "Token";
  }
  if (isOAuthAccessToken) {
    return "Access token";
  }
  return "API token";
}

/**
 * Build the key-value rows for the main auth details section.
 */
function buildAuthDetailRows(data: AuthStatusData): [string, string][] {
  const rows: [string, string][] = [];
  const isEnv = data.source.startsWith("env:");

  if (data.configPath) {
    rows.push(["Config", safeCodeSpan(data.configPath)]);
  }
  if (data.user) {
    rows.push(["User", formatUserIdentity(data.user)]);
  }
  if (data.token) {
    // Stored credentials do not retain an explicit auth method, so managed
    // expiry or refresh capability identifies OAuth access tokens.
    const isOAuthAccessToken =
      data.token.refreshEnabled || data.token.expiresAt !== undefined;
    const tokenLabel = authTokenLabel(isEnv, isOAuthAccessToken);
    rows.push([tokenLabel, safeCodeSpan(data.token.display)]);
    if (data.token.expiresAt) {
      rows.push([
        "Access token expires",
        formatExpiration(data.token.expiresAt),
      ]);
    }
    if (isOAuthAccessToken) {
      rows.push([
        "Automatic refresh",
        data.token.refreshEnabled ? "enabled" : "disabled (no refresh token)",
      ]);
    }
  }
  return rows;
}

/**
 * Build the defaults section markdown (heading + kv table).
 * Returns empty string when no defaults are set.
 */
function formatDefaultsSection(
  defaults: NonNullable<AuthStatusData["defaults"]>
): string {
  const rows: [string, string][] = [];
  if (defaults.organization) {
    rows.push(["Organization", safeCodeSpan(defaults.organization)]);
  }
  if (defaults.project) {
    rows.push(["Project", safeCodeSpan(defaults.project)]);
  }
  if (rows.length === 0) {
    return "";
  }
  return `\n${mdKvTable(rows, "Defaults")}`;
}

/** Maximum orgs to display in the verification list before truncating */
const MAX_VERIFY_DISPLAY = 5;

/**
 * Build the credential verification section markdown.
 */
function formatVerificationSection(
  verification: NonNullable<AuthStatusData["verification"]>
): string {
  const lines: string[] = [""];

  if (verification.success) {
    const orgs = verification.organizations ?? [];
    lines.push(
      `### ${colorTag("green", "✓")} Access verified — ${orgs.length} organization(s)`
    );
    if (orgs.length > 0) {
      lines.push("");
      for (const org of orgs.slice(0, MAX_VERIFY_DISPLAY)) {
        lines.push(
          `- ${escapeMarkdownInline(org.name)} (${safeCodeSpan(org.slug)})`
        );
      }
      if (orgs.length > MAX_VERIFY_DISPLAY) {
        lines.push(`- *… and ${orgs.length - MAX_VERIFY_DISPLAY} more*`);
      }
    }
  } else {
    lines.push(`### ${colorTag("red", "✗")} Could not verify credentials`);
    if (verification.error) {
      lines.push("");
      lines.push(escapeMarkdownInline(verification.error));
    }
  }

  return lines.join("\n");
}

/**
 * Format auth status data as rendered markdown.
 *
 * Produces sections for authentication source, user identity, token info,
 * defaults, and credential verification. Designed as the `human` formatter
 * for the `auth status` command's {@link OutputConfig}.
 *
 * @param data - Structured auth status data collected by the command
 * @returns Rendered terminal string
 */
export function formatAuthStatus(data: AuthStatusData): string {
  const lines: string[] = [];

  lines.push(formatAuthHeader(data.source));
  lines.push("");

  const authRows = buildAuthDetailRows(data);
  if (authRows.length > 0) {
    lines.push(mdKvTable(authRows));
  }

  if (data.envToken) {
    lines.push(formatEnvTokenSection(data.envToken));
  }

  if (data.defaults) {
    lines.push(formatDefaultsSection(data.defaults));
  }

  if (data.verification) {
    lines.push(formatVerificationSection(data.verification));
  }

  return renderMarkdown(lines.join("\n"));
}

/**
 * Format the env token status section.
 * Shows whether the env token is active or bypassed, and how many endpoints
 * have been marked insufficient.
 */
function formatEnvTokenSection(
  envToken: NonNullable<AuthStatusData["envToken"]>
): string {
  const status = envToken.active
    ? "active"
    : "set but not used (using OAuth credentials)";
  const rows: [string, string][] = [
    ["Env var", safeCodeSpan(envToken.envVar)],
    ["Status", status],
  ];
  return `\n${mdKvTable(rows, "Environment Token")}`;
}

// Project Creation Formatting

/** Input for the project-created success formatter */
export type ProjectCreatedResult = {
  /** The created project */
  project: SentryProject;
  /** Organization slug the project was created in */
  orgSlug: string;
  /** Team slug the project was assigned to */
  teamSlug: string;
  /** How the team was resolved */
  teamSource: "explicit" | "auto-selected" | "auto-created";
  /** The platform the user requested via CLI argument (used as fallback display) */
  requestedPlatform: string;
  /** Primary DSN, if fetched successfully */
  dsn: string | null;
  /** Sentry web URL for the project settings page */
  url: string;
  /** Whether Sentry assigned a different slug than expected */
  slugDiverged: boolean;
  /** The slug the user expected (derived from the project name) */
  expectedSlug: string;
  /** When true, nothing was actually created — output uses tentative wording */
  dryRun?: boolean;
};

/**
 * Format a successful project creation as rendered markdown.
 *
 * Includes a heading, contextual notes (slug divergence, team auto-selection),
 * a key-value detail table, and a tip footer.
 *
 * @param result - Project creation context
 * @returns Rendered terminal string
 */
export function formatProjectCreated(result: ProjectCreatedResult): string {
  const lines: string[] = [];
  const dry = result.dryRun === true;
  const nameEsc = escapeMarkdownInline(result.project.name);
  const orgEsc = escapeMarkdownInline(result.orgSlug);

  // Heading
  if (dry) {
    lines.push(`## <muted>Dry run</muted> — project '${nameEsc}' in ${orgEsc}`);
  } else {
    lines.push(`## Created project '${nameEsc}' in ${orgEsc}`);
  }
  lines.push("");

  // Slug divergence note (never applies in dry-run — we can't predict server renames)
  if (result.slugDiverged) {
    lines.push(
      `> **Note:** Slug \`${result.project.slug}\` was assigned because \`${result.expectedSlug}\` is already taken.`
    );
    lines.push("");
  }

  // Team source notes — tentative wording in dry-run
  if (result.teamSource === "auto-created") {
    lines.push(
      dry
        ? `> **Note:** Would create team '${escapeMarkdownInline(result.teamSlug)}' (org has no teams).`
        : `> **Note:** Created team '${escapeMarkdownInline(result.teamSlug)}' (org had no teams).`
    );
    lines.push("");
  } else if (result.teamSource === "auto-selected") {
    lines.push(
      dry
        ? `> **Note:** Would use team '${escapeMarkdownInline(result.teamSlug)}'. See all teams: \`sentry team list\``
        : `> **Note:** Using team '${escapeMarkdownInline(result.teamSlug)}'. See all teams: \`sentry team list\``
    );
    lines.push("");
  }

  const kvRows: [string, string][] = [
    ["Project", nameEsc],
    ["Slug", safeCodeSpan(result.project.slug)],
    ["Org", safeCodeSpan(result.orgSlug)],
    ["Team", safeCodeSpan(result.teamSlug)],
    ["Platform", result.project.platform || result.requestedPlatform],
  ];
  if (result.dsn) {
    kvRows.push(["DSN", safeCodeSpan(result.dsn)]);
  }
  if (result.url) {
    kvRows.push(["URL", result.url]);
  }

  lines.push(mdKvTable(kvRows));

  // Tip footer — only when a real project exists to view
  if (!dry) {
    lines.push("");
    lines.push(
      `*Tip: Use \`sentry project view ${result.orgSlug}/${result.project.slug}\` for details*`
    );
  }

  return renderMarkdown(lines.join("\n"));
}

/** Output contract for one project creation or a multi-project batch. */
export type ProjectCreateOutput = ProjectCreatedResult | ProjectCreatedResult[];

/** Format one project creation or every result in a batch. */
export function formatProjectCreateOutput(output: ProjectCreateOutput): string {
  const results = Array.isArray(output) ? output : [output];
  return results.map(formatProjectCreated).join("\n");
}

// Project Deletion Formatting

/**
 * Result of a project deletion (or dry-run).
 *
 * Contains the minimum context needed for both human and JSON output.
 * When `dryRun` is true, no deletion occurred — output uses tentative wording.
 */
export type ProjectDeleteResult = {
  /** Organization slug */
  orgSlug: string;
  /** Project slug */
  projectSlug: string;
  /** Human-readable project name */
  projectName: string;
  /** Sentry web URL for the project */
  url: string;
  /** When true, nothing was actually deleted — output uses tentative wording */
  dryRun?: boolean;
};

/**
 * Format a project deletion result as rendered markdown.
 *
 * @param result - Deletion context
 * @returns Rendered terminal string
 */
export function formatProjectDeleted(result: ProjectDeleteResult): string {
  const nameEsc = escapeMarkdownInline(result.projectName);
  const qualifiedSlug = `${result.orgSlug}/${result.projectSlug}`;

  if (result.dryRun) {
    return renderMarkdown(
      `Would delete project '${nameEsc}' (${safeCodeSpan(qualifiedSlug)}).\n\n` +
        `URL: ${result.url}`
    );
  }

  return renderMarkdown(
    `Deleted project '${nameEsc}' (${safeCodeSpan(qualifiedSlug)}).`
  );
}

// CLI Fix Formatting

/** Structured fix result (imported from the command module) */
type FixResult = import("../../commands/cli/fix.js").FixResult;

/** Structured fix issue (imported from the command module) */
type FixIssue = import("../../commands/cli/fix.js").FixIssue;

/** Status marker for a fix issue bullet point */
function issueMarker(issue: FixIssue): string {
  if (issue.repaired === true) {
    return colorTag("green", "✓");
  }
  if (issue.repaired === false) {
    return colorTag("red", "✗");
  }
  return "•";
}

/**
 * Build a section for a specific issue category.
 * Returns empty string if there are no issues in this category.
 */
function formatFixCategory(issues: FixIssue[], heading: string): string {
  if (issues.length === 0) {
    return "";
  }

  const lines: string[] = [];
  lines.push(`### ${heading}`);
  lines.push("");
  lines.push(`Found ${issues.length} issue(s):`);
  lines.push("");

  for (const issue of issues) {
    const marker = issueMarker(issue);
    const desc = escapeMarkdownInline(issue.description);
    if (issue.repairMessage && issue.repaired !== undefined) {
      lines.push(`- ${marker} ${escapeMarkdownInline(issue.repairMessage)}`);
    } else {
      lines.push(`- ${marker} ${desc}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format fix command result as rendered markdown.
 *
 * Produces sections for each issue category (ownership, permissions, schema)
 * with status markers for each issue. Designed as the `human` formatter
 * for the `cli fix` command's {@link OutputConfig}.
 *
 * @param data - Structured fix result collected by the command
 * @returns Rendered terminal string
 */
export function formatFixResult(data: FixResult): string {
  const lines: string[] = [];

  // Header
  lines.push(`## Database: ${safeCodeSpan(data.dbPath)}`);
  lines.push("");
  lines.push(`Schema version: ${data.schemaVersion}`);

  if (data.dryRun) {
    lines.push("");
    lines.push(`*${colorTag("muted", "Dry run — no changes will be made")}*`);
  }

  // Category sections
  const ownershipIssues = data.issues.filter((i) => i.category === "ownership");
  const permissionIssues = data.issues.filter(
    (i) => i.category === "permission"
  );
  const schemaIssues = data.issues.filter((i) => i.category === "schema");

  const ownershipSection = formatFixCategory(ownershipIssues, "Ownership");
  const permissionSection = formatFixCategory(permissionIssues, "Permissions");
  const schemaSection = formatFixCategory(schemaIssues, "Schema");

  if (ownershipSection) {
    lines.push("");
    lines.push(ownershipSection);
  }
  if (permissionSection) {
    lines.push("");
    lines.push(permissionSection);
  }
  if (schemaSection) {
    lines.push("");
    lines.push(schemaSection);
  }

  // Instructions block (manual steps when automatic repair isn't possible)
  if (data.instructions) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(escapeMarkdownInline(data.instructions));
  }

  // Summary
  lines.push("");
  if (data.issues.length === 0 && !data.repairFailed) {
    lines.push(
      `${colorTag("green", "✓")} No issues found. Database schema and permissions are correct.`
    );
  } else if (data.dryRun && data.issues.length > 0 && !data.repairFailed) {
    lines.push("Run `sentry cli fix` to apply fixes.");
  } else if (!data.repairFailed) {
    lines.push(`${colorTag("green", "✓")} All issues repaired successfully.`);
  }

  return renderMarkdown(lines.join("\n"));
}

// CLI Upgrade Formatting

/** Structured upgrade result (imported from the command module) */
type UpgradeResult = import("../../commands/cli/upgrade.js").UpgradeResult;

/** Category → markdown heading for changelog sections */
type ChangeCategory = import("../release-notes.js").ChangeCategory;

/** Heading text for each changelog category */
const CATEGORY_HEADINGS: Record<ChangeCategory, string> = {
  features: "#### New Features ✨",
  fixes: "#### Bug Fixes 🐛",
  performance: "#### Performance ⚡",
};

/**
 * Max terminal height multiplier for changelog clamping.
 *
 * When the total rendered changelog would exceed this fraction of the
 * terminal height, items are truncated to keep output scannable.
 */
const CHANGELOG_HEIGHT_FACTOR = 1.3;

/** Lines consumed by the upgrade status header/metadata above the changelog */
const CHANGELOG_HEADER_OVERHEAD = 6;

/** Minimum rendered changelog lines to show even on tiny terminals */
const MIN_CHANGELOG_LINES = 5;

/** Default max rendered lines for non-TTY output (no terminal height available) */
const DEFAULT_MAX_CHANGELOG_LINES = 30;

/**
 * Compute the maximum number of changelog lines based on terminal height.
 *
 * Uses ~1.3x the terminal height minus header overhead. Returns a generous
 * default for non-TTY output where terminal height is unknown.
 */
function getMaxChangelogLines(): number {
  // process.stdout.rows is allowed in formatters (not in command files)
  const termHeight = process.stdout.rows;
  if (!termHeight) {
    return DEFAULT_MAX_CHANGELOG_LINES;
  }
  return Math.max(
    MIN_CHANGELOG_LINES,
    Math.floor(termHeight * CHANGELOG_HEIGHT_FACTOR) - CHANGELOG_HEADER_OVERHEAD
  );
}

/**
 * Format the changelog section as markdown for rendering.
 *
 * Re-serializes the filtered section markdown with category headings so
 * that `renderMarkdown()` applies consistent heading/list styling.
 * Clamps the rendered output to fit ~1.3x the terminal height.
 *
 * @param data - Upgrade result with changelog
 * @returns Rendered changelog string, or empty string if no changelog
 */
function formatChangelog(data: UpgradeResult): string {
  if (!data.changelog || data.changelog.sections.length === 0) {
    return "";
  }

  const { changelog } = data;
  const lines: string[] = [""];

  for (const section of changelog.sections) {
    lines.push(CATEGORY_HEADINGS[section.category]);
    lines.push(section.markdown);
  }

  if (changelog.truncated) {
    const more = changelog.originalCount - changelog.totalItems;
    lines.push(
      `<muted>...and ${more} more changes — https://github.com/getsentry/cli/releases</muted>`
    );
  }

  // Render through the markdown pipeline, then clamp to terminal height
  const rendered = renderMarkdown(lines.join("\n"));
  const renderedLines = rendered.split("\n");
  const maxLines = getMaxChangelogLines();

  if (renderedLines.length <= maxLines) {
    return rendered;
  }

  // Truncate and add a "more" indicator
  const clamped = renderedLines.slice(0, maxLines);
  const remaining = changelog.originalCount - changelog.totalItems;
  const moreText =
    remaining > 0
      ? "...and more — https://github.com/getsentry/cli/releases"
      : "...truncated — https://github.com/getsentry/cli/releases";
  clamped.push(isPlainOutput() ? moreText : muted(moreText));
  return clamped.join("\n");
}

/** Action descriptions for human-readable output */
const ACTION_DESCRIPTIONS: Record<UpgradeResult["action"], string> = {
  upgraded: "Upgraded",
  downgraded: "Downgraded",
  "up-to-date": "Already up to date",
  checked: "Update check complete",
};

/**
 * Format upgrade result as rendered markdown.
 *
 * Produces a concise summary: action line, compact metadata, and any
 * warnings (e.g., PATH shadowing from old package manager install).
 * Designed as the `human` formatter for the `cli upgrade` command's
 * {@link OutputConfig}.
 *
 * @param data - Structured upgrade result collected by the command
 * @returns Rendered terminal string
 */
export function formatUpgradeResult(data: UpgradeResult): string {
  const lines: string[] = [];

  switch (data.action) {
    case "upgraded":
    case "downgraded": {
      const verb = ACTION_DESCRIPTIONS[data.action];
      if (data.offline) {
        lines.push(
          `${colorTag("green", "✓")} ${verb} to ${safeCodeSpan(data.targetVersion)}${escapeMarkdownInline(" (offline, from cache)")}`
        );
      } else if (data.currentVersion !== data.targetVersion) {
        lines.push(
          `${colorTag("green", "✓")} ${verb} to ${safeCodeSpan(data.targetVersion)} ${escapeMarkdownInline(`(from ${data.currentVersion})`)}`
        );
      } else {
        lines.push(
          `${colorTag("green", "✓")} ${verb} to ${safeCodeSpan(data.targetVersion)}`
        );
      }
      break;
    }
    case "up-to-date":
      lines.push(
        `${colorTag("green", "✓")} Already up to date (${safeCodeSpan(data.currentVersion)})`
      );
      break;
    case "checked": {
      if (data.currentVersion === data.targetVersion) {
        lines.push(
          `${colorTag("green", "✓")} You are already on the target version (${safeCodeSpan(data.currentVersion)})`
        );
      } else {
        lines.push(
          `Latest: ${safeCodeSpan(data.targetVersion)} (current: ${safeCodeSpan(data.currentVersion)})`
        );
      }
      break;
    }
    default: {
      // Exhaustive check — all action types should be handled above
      const _: never = data.action;
      lines.push(
        `${ACTION_DESCRIPTIONS[_ as UpgradeResult["action"]] ?? "Done"}`
      );
    }
  }

  // Compact metadata line instead of a full table — method and channel
  // are lightweight diagnostics that don't warrant box-drawing borders.
  const meta = `Method: ${data.method} · Channel: ${data.channel}`;
  lines.push(`  ${colorTag("muted", escapeMarkdownInline(meta))}`);

  // Append warnings with ⚠ markers
  if (data.warnings && data.warnings.length > 0) {
    for (const warning of data.warnings) {
      lines.push(`${colorTag("yellow", "⚠")} ${escapeMarkdownInline(warning)}`);
    }
  }

  const result = renderMarkdown(lines.join("\n"));

  // Append changelog if available
  const changelogOutput = formatChangelog(data);
  if (changelogOutput) {
    return `${result}\n\n${changelogOutput}\n`;
  }

  return result;
}

// Dashboard formatters

/**
 * Format a created dashboard for human-readable output.
 */
export function formatDashboardCreated(result: {
  id: string;
  title: string;
  url: string;
}): string {
  const lines: string[] = [
    `Created dashboard '${escapeMarkdownInline(result.title)}' (ID: ${result.id})`,
    "",
    `URL: ${result.url}`,
  ];
  return renderMarkdown(lines.join("\n"));
}

/**
 * Format a widget add result for human-readable output.
 */
export function formatWidgetAdded(result: {
  dashboard: DashboardDetail;
  widget: DashboardWidget;
  url: string;
}): string {
  const widgetCount = result.dashboard.widgets?.length ?? 0;
  const lines: string[] = [
    `Added widget '${escapeMarkdownInline(result.widget.title)}' to dashboard (now ${widgetCount} widgets)`,
  ];
  const layoutLine = formatWidgetLayoutLine(result.widget);
  if (layoutLine) {
    lines.push("", layoutLine);
  }
  lines.push("", `URL: ${result.url}`);
  return renderMarkdown(lines.join("\n"));
}

/**
 * Format a widget deletion result for human-readable output.
 * Supports dry-run mode — shows what would be removed without removing it.
 */
export function formatWidgetDeleted(result: {
  dashboard: DashboardDetail;
  widgetTitle: string;
  url: string;
  dryRun?: boolean;
}): string {
  const widgetCount = result.dashboard.widgets?.length ?? 0;
  if (result.dryRun) {
    const lines: string[] = [
      `Would remove widget '${escapeMarkdownInline(result.widgetTitle)}' from dashboard (currently ${widgetCount} widgets)`,
      "",
      `URL: ${result.url}`,
    ];
    return renderMarkdown(lines.join("\n"));
  }
  const lines: string[] = [
    `Removed widget '${escapeMarkdownInline(result.widgetTitle)}' from dashboard (now ${widgetCount} widgets)`,
    "",
    `URL: ${result.url}`,
  ];
  return renderMarkdown(lines.join("\n"));
}

/**
 * Format widget layout as a compact "position (x,y) size w×h" string.
 * Returns empty string if the widget has no layout.
 */
function formatWidgetLayoutLine(widget: DashboardWidget): string {
  if (!widget.layout) {
    return "";
  }
  const { x, y, w, h } = widget.layout;
  return `Layout: position (${x},${y}), size ${w}×${h}`;
}

/**
 * Format a widget edit result for human-readable output.
 */
export function formatWidgetEdited(result: {
  dashboard: DashboardDetail;
  widget: DashboardWidget;
  url: string;
}): string {
  const lines: string[] = [
    `Updated widget '${escapeMarkdownInline(result.widget.title)}' in dashboard ${result.dashboard.id}`,
  ];
  const layoutLine = formatWidgetLayoutLine(result.widget);
  if (layoutLine) {
    lines.push("", layoutLine);
  }
  lines.push("", `URL: ${result.url}`);
  return renderMarkdown(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// CLI Defaults Formatting
// ---------------------------------------------------------------------------

/** Structured defaults command result (imported from the command module) */
type DefaultsResult = import("../../commands/cli/defaults.js").DefaultsResult;

/** Display labels for each default key */
const DEFAULT_LABELS: Record<string, string> = {
  organization: "Organization",
  project: "Project",
  telemetry: "Telemetry",
  "agent-skills": "Agent Skills",
  graphics: "Graphics",
  url: "URL",
  headers: "Headers",
  "ca-cert": "CA Certificate",
};

/**
 * Describe the effective telemetry source for display.
 * Shows when an env var overrides the stored preference.
 */
function telemetryOverrideNote(
  effective: DefaultsResult["telemetryEffective"]
): string {
  if (!effective?.source.startsWith("env:")) {
    return "";
  }
  const envVar = effective.source.slice("env:".length);
  return ` ${colorTag("muted", `(overridden: disabled via ${envVar})`)}`;
}

/** Build the rows for the "show" mode of the defaults command. */
function buildDefaultsShowRows(data: DefaultsResult): [string, string][] {
  const d = data.defaults;
  const notSet = colorTag("muted", "not set");
  const telLabel = d.telemetry ?? "on (default)";
  const agentSkillsLabel = d["agent-skills"] ?? "on (default)";
  const graphicsLabel = d.graphics ?? "on (default)";

  return [
    ["Organization", d.organization ? safeCodeSpan(d.organization) : notSet],
    ["Project", d.project ? safeCodeSpan(d.project) : notSet],
    [
      "Telemetry",
      `${escapeMarkdownInline(String(telLabel))}${telemetryOverrideNote(data.telemetryEffective)}`,
    ],
    ["Agent Skills", escapeMarkdownInline(String(agentSkillsLabel))],
    ["Graphics", escapeMarkdownInline(String(graphicsLabel))],
    ["URL", d.url ? safeCodeSpan(d.url) : notSet],
    ["Headers", d.headers ? safeCodeSpan(d.headers) : notSet],
    ["CA Certificate", d["ca-cert"] ? safeCodeSpan(d["ca-cert"]) : notSet],
  ];
}

/**
 * Format defaults command result as rendered markdown.
 */
export function formatDefaultsResult(data: DefaultsResult): string {
  switch (data.action) {
    case "show":
      return renderMarkdown(mdKvTable(buildDefaultsShowRows(data), "Defaults"));

    case "set": {
      const label =
        DEFAULT_LABELS[data.changed?.key ?? ""] ?? data.changed?.key;
      return renderMarkdown(
        `${colorTag("green", "✓")} Default ${escapeMarkdownInline(label ?? "setting")} set to ${safeCodeSpan(String(data.changed?.newValue))}`
      );
    }

    case "clear": {
      const label =
        DEFAULT_LABELS[data.changed?.key ?? ""] ?? data.changed?.key;
      return renderMarkdown(
        `${colorTag("green", "✓")} Default ${escapeMarkdownInline(label ?? "setting")} cleared`
      );
    }

    case "clear-all":
      return renderMarkdown(`${colorTag("green", "✓")} All defaults cleared`);

    default:
      return "";
  }
}

// Sentry Service Status Formatting

/** Structured service status data shape (re-imported from the API module) */
type SentryStatus = import("../api/status-page.js").SentryStatus;
type StatusComponent = import("../api/status-page.js").StatusComponent;

/** Color tag for the overall status indicator. */
const STATUS_INDICATOR_TAGS: Record<string, Parameters<typeof colorTag>[0]> = {
  none: "green",
  minor: "yellow",
  major: "red",
  critical: "red",
  maintenance: "blue",
};

/** Color tag for a component's operational status. */
const COMPONENT_STATUS_TAGS: Record<string, Parameters<typeof colorTag>[0]> = {
  operational: "green",
  degraded_performance: "yellow",
  partial_outage: "yellow",
  major_outage: "red",
  under_maintenance: "blue",
};

/** Human-readable label for a component's operational status. */
const COMPONENT_STATUS_LABELS: Record<string, string> = {
  operational: "Operational",
  degraded_performance: "Degraded Performance",
  partial_outage: "Partial Outage",
  major_outage: "Major Outage",
  under_maintenance: "Under Maintenance",
};

/** Render one component row: a colored dot, its name, and status label. */
function formatComponentLine(component: StatusComponent): string {
  const tag = COMPONENT_STATUS_TAGS[component.status] ?? "yellow";
  const label =
    COMPONENT_STATUS_LABELS[component.status] ?? capitalize(component.status);
  return `${colorTag(tag, "●")} ${escapeMarkdownInline(component.name)} — ${label}`;
}

/**
 * Format Sentry service status as rendered markdown: an overall header, any
 * active incidents, and the per-component breakdown.
 */
export function formatSentryStatus(data: SentryStatus): string {
  const lines: string[] = [];

  const indicatorTag = STATUS_INDICATOR_TAGS[data.indicator] ?? "yellow";
  const icon = data.indicator === "none" ? "✓" : "●";
  lines.push(
    `## ${colorTag(indicatorTag, icon)} ${escapeMarkdownInline(data.description)}`
  );
  lines.push("");

  if (data.incidents.length > 0) {
    lines.push("### Active Incidents");
    lines.push("");
    for (const incident of data.incidents) {
      lines.push(
        `- **${escapeMarkdownInline(incident.name)}** (${escapeMarkdownInline(incident.impact)} impact, ${escapeMarkdownInline(incident.status)})`
      );
      lines.push(`  ${safeCodeSpan(incident.shortlink)}`);
    }
    lines.push("");
  }

  if (data.components.length > 0) {
    // Only surface components that aren't fully operational to keep the output
    // focused during an outage; fall back to the full list when all is well.
    const impacted = data.components.filter((c) => c.status !== "operational");
    const shown = impacted.length > 0 ? impacted : data.components;
    lines.push("### Components");
    lines.push("");
    for (const component of shown) {
      lines.push(formatComponentLine(component));
    }
    lines.push("");
  }

  lines.push(`See ${safeCodeSpan(data.url)} for full details.`);

  return renderMarkdown(lines.join("\n"));
}
