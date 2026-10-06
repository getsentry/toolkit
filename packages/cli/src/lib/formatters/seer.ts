/**
 * Seer Output Formatters
 *
 * Formatting utilities for Seer Autofix command output. All human-readable
 * output is built as markdown and rendered via renderMarkdown().
 */

import type {
  AutofixState,
  RootCause,
  SolutionArtifact,
} from "../../types/seer.js";
import { ApiError, SeerError } from "../errors.js";
import { cyan } from "./colors.js";
import { filterFields } from "./json.js";
import { escapeMarkdownInline, renderMarkdown } from "./markdown.js";

// Spinner Frames

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Get a spinner frame for the given tick count.
 *
 * @param tick - Current animation tick (cycles through frames)
 * @returns Single spinner character for display
 */
export function getSpinnerFrame(tick: number): string {
  const index = tick % SPINNER_FRAMES.length;
  // biome-ignore lint/style/noNonNullAssertion: index is always valid due to modulo
  return SPINNER_FRAMES[index]!;
}

// Progress Formatting

/** Maximum length for progress messages to fit in a single terminal line */
const MAX_PROGRESS_LENGTH = 300;

/**
 * Truncate a progress message to fit in a single terminal line.
 *
 * @param message - Progress message to truncate
 * @returns Truncated message with ellipsis if needed
 */
export function truncateProgressMessage(message: string): string {
  if (message.length <= MAX_PROGRESS_LENGTH) {
    return message;
  }
  return `${message.slice(0, MAX_PROGRESS_LENGTH - 3)}...`;
}

/**
 * Format a progress message with spinner.
 *
 * @param message - Progress message to display
 * @param tick - Spinner tick count
 * @returns Formatted progress line
 */
export function formatProgressLine(message: string, tick: number): string {
  const spinner = cyan(getSpinnerFrame(tick));
  return `${spinner} ${message}`;
}

/** Agent block with optional message content */
type BlockWithMessage = { message?: { content?: string | null } };

/**
 * Extract the first line of the latest block's message content.
 * Returns undefined if no block message is available.
 */
function getBlockProgressMessage(
  blocks: BlockWithMessage[]
): string | undefined {
  const lastBlock = blocks.at(-1);
  if (!lastBlock?.message?.content) {
    return;
  }
  return lastBlock.message.content.split("\n")[0] || undefined;
}

/**
 * Extract the latest progress message from autofix state.
 *
 * Handles both response formats:
 * - Agent: message content from the last block's `message.content`
 * - Legacy: progress messages from the last step's `progress[]` array
 *
 * @param state - Current autofix state
 * @returns Latest progress message or default
 */
export function getProgressMessage(state: AutofixState): string {
  const stateWithBlocks = state as AutofixState & {
    blocks?: BlockWithMessage[];
  };
  if (stateWithBlocks.blocks && stateWithBlocks.blocks.length > 0) {
    const msg = getBlockProgressMessage(stateWithBlocks.blocks);
    if (msg) {
      return msg;
    }
  }

  if (state.steps && state.steps.length > 0) {
    const currentStep = state.steps.at(-1);
    if (currentStep?.progress && currentStep.progress.length > 0) {
      const lastProgress = currentStep.progress.at(-1);
      if (lastProgress?.message) {
        return lastProgress.message;
      }
    }
  }

  switch (state.status) {
    case "PROCESSING":
      return "Analyzing issue...";
    case "COMPLETED":
      return "Analysis complete";
    case "ERROR":
      return "Analysis failed";
    default:
      return "Processing...";
  }
}

// Root Cause Formatting

/** Root-cause output for one requested issue. */
export type IssueExplainResult = {
  /** Issue identifier as supplied by the caller. */
  issue: string;
  /** Resolved organization slug. */
  org: string;
  /** Resolved numeric issue identifier. */
  issueId: string;
  /** Root causes returned by Seer. */
  rootCauses: RootCause[];
};

/** Aggregate root-cause output for single- and multi-issue invocations. */
export type IssueExplainData = {
  /** Successful issue analyses in request order. */
  results: IssueExplainResult[];
  /** Number of distinct issues requested before partial failures. */
  requestedCount: number;
};

/**
 * Build a markdown document for a single root cause.
 *
 * @param cause - Root cause to format
 * @param index - Index for display (used as cause ID)
 * @returns Markdown string for this cause
 */
function buildRootCauseMarkdown(cause: RootCause, index: number): string {
  const lines: string[] = [];

  lines.push(
    `### Cause #${index}: ${escapeMarkdownInline(cause.description ?? "")}`
  );
  lines.push("");

  if (cause.relevant_repos && cause.relevant_repos.length > 0) {
    lines.push(`**Repository:** ${cause.relevant_repos.join(", ")}`);
    lines.push("");
  }

  if (
    cause.root_cause_reproduction &&
    cause.root_cause_reproduction.length > 0
  ) {
    lines.push("**Reproduction steps:**");
    lines.push("");
    for (const step of cause.root_cause_reproduction) {
      lines.push(`**${escapeMarkdownInline(step.title)}**`);
      lines.push("");
      // code_snippet_and_analysis may itself contain markdown (code fences,
      // inline code, etc.) — pass it through as-is so marked renders it.
      lines.push(step.code_snippet_and_analysis);
      lines.push("");
    }
  }

  return lines.join("\n");
}

function buildRootCauseListMarkdown(causes: RootCause[]): string {
  const lines = ["## Root Cause Analysis Complete", ""];

  if (causes.length === 0) {
    lines.push("*No root causes identified.*");
  } else {
    for (let index = 0; index < causes.length; index++) {
      const cause = causes[index];
      if (cause) {
        lines.push(buildRootCauseMarkdown(cause, index));
      }
    }
  }

  return lines.join("\n");
}

/**
 * Format all root causes as rendered terminal output.
 *
 * @param causes - Array of root causes
 * @returns Rendered terminal string
 */
export function formatRootCauseList(causes: RootCause[]): string {
  return renderMarkdown(buildRootCauseListMarkdown(causes));
}

/**
 * Format one or more issue analyses for terminal output.
 *
 * @param data - Aggregate issue analysis output
 * @returns The historical single-issue output or labeled issue sections
 */
export function formatIssueExplain(data: IssueExplainData): string {
  if (data.requestedCount <= 1) {
    return data.results[0]
      ? formatRootCauseList(data.results[0].rootCauses)
      : "";
  }

  const sections = data.results.map(
    (result) =>
      `# ${escapeMarkdownInline(result.issue)}\n\n${buildRootCauseListMarkdown(result.rootCauses)}`
  );
  return renderMarkdown(sections.join("\n\n---\n\n"));
}

/**
 * Transform issue analyses for JSON output.
 *
 * A single requested issue preserves the historical array of root causes.
 * Multiple issues return labeled envelopes so each cause remains attributable
 * to its issue. Field filtering applies to each root-cause object.
 *
 * @param data - Aggregate issue analysis output
 * @param fields - Optional root-cause fields to retain
 * @returns Root causes for one issue, otherwise labeled result envelopes
 */
export function jsonTransformIssueExplain(
  data: IssueExplainData,
  fields?: string[]
): unknown {
  const filterRootCauses = (rootCauses: RootCause[]): unknown =>
    fields && fields.length > 0 ? filterFields(rootCauses, fields) : rootCauses;

  if (data.requestedCount <= 1) {
    return data.results[0] ? filterRootCauses(data.results[0].rootCauses) : [];
  }

  return data.results.map((result) => ({
    issue: result.issue,
    org: result.org,
    issueId: result.issueId,
    rootCauses: filterRootCauses(result.rootCauses),
  }));
}

// Error Messages

/**
 * Create a SeerError from an API error status code and detail.
 *
 * @param status - HTTP status code
 * @param detail - Error detail from API
 * @param orgSlug - Organization slug for constructing settings URLs
 * @returns SeerError if the status code indicates a Seer-specific error, null otherwise
 */
export function createSeerError(
  status: number,
  detail?: string,
  orgSlug?: string
): SeerError | null {
  if (status === 402) {
    return new SeerError("no_budget", orgSlug);
  }
  if (status === 403) {
    if (detail?.includes("not enabled")) {
      return new SeerError("not_enabled", orgSlug);
    }
    if (detail?.includes("AI features")) {
      return new SeerError("ai_disabled", orgSlug);
    }
    // Unrecognized 403 - return null to preserve original error detail
    // (could be permission denied, rate limiting, etc.)
    return null;
  }
  return null;
}

/**
 * Convert an API error to a Seer-specific error or an ApiError.
 *
 * Returns a SeerError for known Seer issues (402/403 with specific detail),
 * or preserves the error as an ApiError for other failures. Previously
 * returned a plain Error which lost the status code and endpoint — causing
 * CLI-N (84 users) where unrecognized 403s became untyped errors.
 *
 * @param status - HTTP status code
 * @param detail - Error detail from API
 * @param orgSlug - Organization slug for constructing settings URLs
 * @returns SeerError for Seer-specific errors, or ApiError for other API errors
 */
export function handleSeerApiError(
  status: number,
  detail?: string,
  orgSlug?: string
): Error {
  const seerError = createSeerError(status, detail, orgSlug);
  if (seerError) {
    return seerError;
  }
  return new ApiError(formatAutofixError(status, detail), status, detail);
}

/**
 * Format an error message for non-Seer autofix errors.
 *
 * Note: Seer-specific errors (402, 403) are handled by SeerError which
 * provides actionable suggestions. This function handles other API errors.
 *
 * @param status - HTTP status code
 * @param detail - Error detail from API
 * @returns User-friendly error message
 */
export function formatAutofixError(status: number, detail?: string): string {
  switch (status) {
    case 404:
      return "Issue not found.";
    default:
      return detail ?? "An error occurred with the autofix request.";
  }
}

// Solution Formatting

/**
 * Format a solution artifact as rendered terminal output.
 *
 * Renders a markdown document:
 *
 * ## Solution
 *
 * **Summary:** {one_line_summary}
 *
 * ### Steps to implement
 *
 * 1. **{title}**
 *
 *    {description}
 *
 * @param solution - Solution artifact from autofix
 * @returns Rendered terminal string
 */
export function formatSolution(solution: SolutionArtifact): string {
  const lines: string[] = [];

  lines.push("## Solution");
  lines.push("");

  lines.push(
    `**Summary:** ${escapeMarkdownInline(solution.data.one_line_summary ?? "")}`
  );
  lines.push("");

  if (solution.data.steps.length > 0) {
    lines.push("### Steps to implement");
    lines.push("");
    for (let i = 0; i < solution.data.steps.length; i++) {
      const step = solution.data.steps[i];
      if (step) {
        lines.push(`${i + 1}. **${escapeMarkdownInline(step.title)}**`);
        lines.push("");
        // step.description may contain markdown — pass it through as-is
        lines.push(`   ${step.description.split("\n").join("\n   ")}`);
        lines.push("");
      }
    }
  }

  return renderMarkdown(lines.join("\n"));
}
