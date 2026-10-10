import type { SentryApiService, Trace, TraceSpan } from "../../api-client";
import { UserInputError } from "../../errors";
import { hasAgentProvider } from "../../internal/agents/provider-factory";
import {
  type AIConversationReference,
  formatAIConversationActionInstructions,
} from "../../internal/tool-helpers/ai-conversation-actions";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { resolveRegionUrlForOrganization } from "../../internal/tool-helpers/resolve-region-url";
import { formatToolCallInstruction } from "../../internal/tool-helpers/tool-call-formatting";
import {
  ParamOrganizationSlug,
  ParamRegionUrl,
  ParamSpanId,
  ParamTraceId,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { formatSemanticSpanDisplay } from "../support/traces/semantic-display.js";

// Constants for span filtering and tree rendering
const MAX_TRACE_FETCH_LIMIT = 1000;
const MAX_FOCUSED_TRACE_FETCH_LIMIT = 10000;
const MIN_TRACE_FETCH_LIMIT = 50;
const MAX_DEPTH = 8;
const MAX_ROOT_SPANS = 12;
const MAX_OVERVIEW_SPANS = 96;
const MAX_FOCUSED_CHILD_SPANS = 40;
const MAX_QUEUED_CHILDREN_PER_PARENT = 24;
const MINIMUM_DURATION_THRESHOLD_MS = 10;
const MIN_AVG_DURATION_MS = 5;
const MAX_AI_CONVERSATION_REFERENCES = 3;

interface TraceSummary {
  spanCount: number;
  errors: number;
  performanceIssues: number | null;
  logs: number | null;
}

interface TraceFetchState {
  fetchedSpanCount: number;
  isComplete: boolean;
}

interface SpanBranchStats {
  interesting: boolean;
  score: number;
  maxDuration: number;
  descendantCount: number;
}

interface SpanExpansionCandidate {
  span: TraceSpan;
  parent: SelectedSpan;
  level: number;
  score: number;
}

export default defineTool({
  name: "get_trace_details",
  skills: ["inspect"], // Only available in inspect skill
  requiredScopes: ["event:read"],
  requiredCapabilities: ["traces"],
  description: [
    "Get detailed information about a specific Sentry trace by ID.",
    "",
    "USE THIS TOOL WHEN USERS:",
    "- Provide a specific trace ID (e.g., 'a4d1aae7216b47ff8117cf4e09ce9d0a')",
    "- Ask to 'show me trace [TRACE-ID]', 'explain trace [TRACE-ID]'",
    "- Want high-level overview and link to view trace details in Sentry",
    "- Need trace statistics and span breakdown",
    "- Want an overview first, then a guided pivot into additional spans or events",
    "",
    "DO NOT USE for:",
    "- General searching for traces (use search_traces)",
    "- Complete span enumeration or branch-by-branch reconstruction (use search_traces scoped to the trace)",
    "",
    "TRIGGER PATTERNS:",
    "- 'Show me trace abc123' → use get_trace_details",
    "- 'Explain trace a4d1aae7216b47ff8117cf4e09ce9d0a' → use get_trace_details",
    "- 'What is trace [trace-id]' → use get_trace_details",
    "",
    "<examples>",
    "### Get trace overview",
    "```",
    "get_trace_details(organizationSlug='my-organization', traceId='a4d1aae7216b47ff8117cf4e09ce9d0a')",
    "```",
    "",
    "### Focus a single span",
    "```",
    "get_trace_details(organizationSlug='my-organization', traceId='a4d1aae7216b47ff8117cf4e09ce9d0a', spanId='aa8e7f3384ef4ff5')",
    "```",
    "</examples>",
    "",
    "<hints>",
    "- Trace IDs are 32-character hexadecimal strings",
    "- This returns a condensed trace overview, not a full span dump",
    "- Provide `spanId` to focus on a single span within the trace",
    "- If the response says it shows a subset of spans, use search_traces to inspect the rest of the trace",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    traceId: ParamTraceId,
    spanId: ParamSpanId.optional(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    // Validate trace ID format
    if (!/^[0-9a-fA-F]{32}$/.test(params.traceId)) {
      throw new UserInputError(
        "Trace ID must be a 32-character hexadecimal string",
      );
    }

    const regionUrl = await resolveRegionUrlForOrganization({
      context,
      organizationSlug: params.organizationSlug,
      regionUrl: params.regionUrl,
    });

    const apiService = apiServiceFromContext(context, {
      regionUrl: regionUrl ?? undefined,
    });

    setTargetTagsAndAttributes({
      organizationSlug: params.organizationSlug,
      projectSlug: context.constraints.projectSlug,
      traceId: params.traceId,
      spanId: params.spanId,
    });

    // Get trace metadata for overview
    const traceMeta = await apiService.getTraceMeta({
      organizationSlug: params.organizationSlug,
      traceId: params.traceId,
      statsPeriod: "14d", // Fixed stats period
    });

    const traceFetchLimit = getTraceFetchLimit(
      traceMeta.span_count,
      traceMeta.errors,
      params.spanId ? MAX_FOCUSED_TRACE_FETCH_LIMIT : MAX_TRACE_FETCH_LIMIT,
    );

    // Fetch as much of the trace as we can so the overview and operation
    // breakdown are based on the real trace tree instead of a tiny sample.
    // Sentry's organization trace endpoint ignores incoming `project` filters
    // and paginates internally, so trace/span lookups remain org-scoped even
    // when the session carries a project constraint.
    const trace = await apiService.getTrace({
      organizationSlug: params.organizationSlug,
      traceId: params.traceId,
      limit: traceFetchLimit,
      statsPeriod: "14d", // Fixed stats period
    });

    const summary = {
      spanCount: traceMeta.span_count,
      errors: traceMeta.errors,
      performanceIssues: traceMeta.performance_issues,
      logs: traceMeta.logs,
    };
    const traceFetchState = buildTraceFetchState({
      trace,
      totalSpanCount: traceMeta.span_count,
    });

    const aiConversations = collectAIConversationReferencesFromTrace(trace);
    const markdown = formatTraceOutput({
      organizationSlug: params.organizationSlug,
      traceId: params.traceId,
      spanId: params.spanId,
      summary,
      trace,
      traceFetchState,
      apiService,
      experimentalMode: context.experimentalMode,
      availableToolNames: context.availableToolNames,
      directToolNames: context.directToolNames,
      aiConversations,
    });
    return markdown;
  },
});

function isTraceSpanNode(node: unknown): node is TraceSpan {
  if (node === null || typeof node !== "object") {
    return false;
  }

  const candidate = node as Partial<TraceSpan>;
  return (
    typeof candidate.event_id === "string" &&
    typeof candidate.duration === "number" &&
    Array.isArray(candidate.children)
  );
}

function getTraceSpans(trace: Trace): TraceSpan[] {
  return trace.filter(isTraceSpanNode);
}

function getTraceSpanChildren(span: TraceSpan): TraceSpan[] {
  return span.children.filter(isTraceSpanNode);
}

function getTraceFetchLimit(
  totalSpanCount: number,
  errorCount = 0,
  maxFetchLimit = MAX_TRACE_FETCH_LIMIT,
): number {
  return Math.min(
    Math.max(totalSpanCount + errorCount, MIN_TRACE_FETCH_LIMIT),
    maxFetchLimit,
  );
}

interface SelectedSpan {
  id: string;
  op: string;
  displayName: string;
  metadata: string[];
  duration: number;
  is_transaction: boolean;
  children: SelectedSpan[];
  level: number;
}

/**
 * Selects a subset of "interesting" spans from a trace for display in the overview.
 *
 * Creates a fake root span representing the entire trace, with selected interesting
 * spans as children. This provides a unified tree view of the trace.
 *
 * The goal is to provide a meaningful sample of the trace that highlights the most
 * important operations while staying within display limits. Selection prioritizes:
 *
 * 1. **Transactions** - Top-level operations that represent complete user requests
 * 2. **Error spans** - Any spans that contain errors (critical for debugging)
 * 3. **Long-running spans** - Operations >= 10ms duration (performance bottlenecks)
 * 4. **Hierarchical context** - Maintains parent-child relationships for understanding
 *
 * Span inclusion rules:
 * - Root spans are ranked by branch score, not just root duration
 * - Spans with errors or long descendants stay in consideration
 * - The tree expands best-first across the whole trace, not one branch at a time
 * - Children are recursively added up to MAX_DEPTH levels deep
 * - Total output is capped at maxSpans to prevent overwhelming display
 *
 * @param trace - Complete array of trace spans with nested children
 * @param traceId - Trace ID to display in the fake root span
 * @param maxSpans - Maximum number of spans to include in output
 * @returns Single-element array containing fake root span with selected spans as children
 */
function selectInterestingSpans(
  trace: Trace,
  traceId: string,
  maxSpans = MAX_OVERVIEW_SPANS,
): SelectedSpan[] {
  const getBranchStats = createBranchStatsGetter();

  const sortedRoots = getTraceSpans(trace)
    .map((root) => ({
      root,
      stats: getBranchStats(root),
    }))
    .sort((a, b) => b.stats.score - a.stats.score)
    .slice(0, MAX_ROOT_SPANS);

  const fakeRoot = fakeRootTemplate(traceId);
  const expansionQueue: SpanExpansionCandidate[] = [];
  let spanCount = 0;

  for (const { root } of sortedRoots) {
    if (spanCount >= maxSpans) {
      break;
    }

    fakeRoot.children.push(createSelectedSpan(root, 0));
    const selectedRoot = fakeRoot.children[fakeRoot.children.length - 1];
    spanCount += 1;
    enqueueSelectedChildren(
      root,
      selectedRoot,
      1,
      expansionQueue,
      getBranchStats,
    );
  }

  while (expansionQueue.length > 0 && spanCount < maxSpans) {
    expansionQueue.sort((a, b) => b.score - a.score);
    const candidate = expansionQueue.shift();

    if (!candidate || candidate.level > MAX_DEPTH) {
      continue;
    }

    const selectedChild = createSelectedSpan(candidate.span, candidate.level);
    candidate.parent.children.push(selectedChild);
    spanCount += 1;
    enqueueSelectedChildren(
      candidate.span,
      selectedChild,
      candidate.level + 1,
      expansionQueue,
      getBranchStats,
    );
  }

  return [fakeRoot];
}

function selectInterestingSpanSubtree(
  span: TraceSpan,
  maxDescendantSpans = MAX_FOCUSED_CHILD_SPANS,
): SelectedSpan {
  const getBranchStats = createBranchStatsGetter();
  const selectedRoot = createSelectedSpan(span, 0);
  const expansionQueue: SpanExpansionCandidate[] = [];
  let descendantCount = 0;

  enqueueSelectedChildren(
    span,
    selectedRoot,
    1,
    expansionQueue,
    getBranchStats,
  );

  while (expansionQueue.length > 0 && descendantCount < maxDescendantSpans) {
    expansionQueue.sort((a, b) => b.score - a.score);
    const candidate = expansionQueue.shift();

    if (!candidate || candidate.level > MAX_DEPTH) {
      continue;
    }

    const selectedChild = createSelectedSpan(candidate.span, candidate.level);
    candidate.parent.children.push(selectedChild);
    descendantCount += 1;
    enqueueSelectedChildren(
      candidate.span,
      selectedChild,
      candidate.level + 1,
      expansionQueue,
      getBranchStats,
    );
  }

  return selectedRoot;
}

function normalizeSpanId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  return undefined;
}

function getTraceSpanId(span: TraceSpan): string {
  return (
    normalizeSpanId(span.span_id) ||
    normalizeSpanId(span.additional_attributes?.span_id) ||
    span.event_id
  );
}

function createBranchStatsGetter(): (span: TraceSpan) => SpanBranchStats {
  const branchStatsBySpan = new Map<string, SpanBranchStats>();

  function getBranchStats(span: TraceSpan): SpanBranchStats {
    const spanId = getTraceSpanId(span);
    const cached = branchStatsBySpan.get(spanId);
    if (cached) {
      return cached;
    }

    const duration = span.duration || 0;
    const hasErrors = Array.isArray(span.errors) && span.errors.length > 0;

    let maxDuration = duration;
    let descendantCount = 1;
    let childScore = 0;
    let hasInterestingDescendant = false;

    for (const child of getTraceSpanChildren(span)) {
      const childStats = getBranchStats(child);
      maxDuration = Math.max(maxDuration, childStats.maxDuration);
      descendantCount += childStats.descendantCount;
      childScore = Math.max(childScore, childStats.score);
      hasInterestingDescendant ||= childStats.interesting;
    }

    const interesting =
      Boolean(span.is_transaction) ||
      hasErrors ||
      duration >= MINIMUM_DURATION_THRESHOLD_MS ||
      hasInterestingDescendant;

    const score =
      duration +
      maxDuration * 0.75 +
      descendantCount * 4 +
      (span.is_transaction ? 250 : 0) +
      (hasErrors ? 1000 : 0) +
      childScore * 0.25;

    const stats = {
      interesting,
      score,
      maxDuration,
      descendantCount,
    };

    branchStatsBySpan.set(spanId, stats);
    return stats;
  }

  return getBranchStats;
}

function createSelectedSpan(span: TraceSpan, level: number): SelectedSpan {
  const display = formatSemanticSpanDisplay(span);

  return {
    id: getTraceSpanId(span),
    op: span.op || "unknown",
    displayName: display.label,
    metadata: display.metadata,
    duration: span.duration || 0,
    is_transaction: Boolean(span.is_transaction),
    children: [],
    level,
  };
}

function enqueueSelectedChildren(
  span: TraceSpan,
  parent: SelectedSpan,
  level: number,
  queue: SpanExpansionCandidate[],
  getBranchStats: (span: TraceSpan) => SpanBranchStats,
): void {
  if (level > MAX_DEPTH) {
    return;
  }

  const childCandidates = getTraceSpanChildren(span)
    .map((child) => ({
      child,
      stats: getBranchStats(child),
    }))
    .sort((a, b) => b.stats.score - a.stats.score)
    .slice(0, MAX_QUEUED_CHILDREN_PER_PARENT);

  for (const { child, stats } of childCandidates) {
    queue.push({
      span: child,
      parent,
      level,
      score: stats.score,
    });
  }
}

// Create fake root span representing the entire trace (no duration - traces are unbounded)
const fakeRootTemplate = (traceId: string): SelectedSpan => ({
  id: traceId,
  op: "trace",
  displayName: "trace",
  metadata: [],
  duration: 0, // Traces don't have duration
  is_transaction: false,
  children: [],
  level: -1, // Mark as fake root
});

/**
 * Formats a span display name for the tree view.
 *
 * Uses span.name if available (OTEL-native), otherwise falls back to span.description.
 *
 * @param span - The span to format
 * @returns A formatted display name for the span
 */
function formatSpanDisplayName(span: SelectedSpan): string {
  return span.displayName;
}

/**
 * Renders a hierarchical tree structure of spans using Unicode box-drawing characters.
 *
 * Creates a visual tree representation showing parent-child relationships between spans,
 * with proper indentation and connecting lines. Each span shows its operation, short ID,
 * description, duration, and type (transaction vs span).
 *
 * Tree format:
 * - Root spans have no prefix
 * - Child spans use ├─ for intermediate children, └─ for last child
 * - Continuation lines use │ for vertical connections
 * - Proper spacing maintains visual alignment
 *
 * @param spans - Array of selected spans with their nested children structure
 * @returns Array of formatted markdown strings representing the tree structure
 */
function renderSpanTree(spans: SelectedSpan[]): string[] {
  const lines: string[] = [];

  function renderSpan(span: SelectedSpan, prefix = "", isLast = true): void {
    const connector = prefix === "" ? "" : isLast ? "└─ " : "├─ ";
    const displayName = formatSpanDisplayName(span);

    // Don't show duration or ID for the fake trace root span — the trace ID
    // is already shown in the section header.
    if (span.op === "trace") {
      lines.push(`${prefix}${connector}${displayName}`);
    } else {
      const duration = span.duration
        ? `${Math.round(span.duration)}ms`
        : "unknown";

      // Full span ID goes last so the human-readable parts read first, but
      // the ID is still easily extractable for follow-up get_trace_details calls.
      // Don't show 'default' operations as they're not meaningful.
      const metadataParts = [
        ...(span.op === "default" ? [] : [span.op]),
        ...span.metadata,
        duration,
        span.id,
      ];
      lines.push(
        `${prefix}${connector}${displayName} [${metadataParts.join(" · ")}]`,
      );
    }

    // Render children with proper tree indentation
    for (let i = 0; i < span.children.length; i++) {
      const child = span.children[i];
      const isLastChild = i === span.children.length - 1;
      const childPrefix = prefix + (isLast ? "   " : "│  ");
      renderSpan(child, childPrefix, isLastChild);
    }
  }

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const isLastRoot = i === spans.length - 1;
    renderSpan(span, "", isLastRoot);
  }

  return lines;
}

function findTraceSpan(trace: Trace, spanId: string): TraceSpan | null {
  for (const span of getTraceSpans(trace)) {
    const found = findTraceSpanInSubtree(span, spanId);
    if (found) {
      return found;
    }
  }

  return null;
}

function findTraceSpanInSubtree(
  span: TraceSpan,
  targetSpanId: string,
): TraceSpan | null {
  if (getTraceSpanId(span) === targetSpanId) {
    return span;
  }

  for (const child of getTraceSpanChildren(span)) {
    const found = findTraceSpanInSubtree(child, targetSpanId);
    if (found) {
      return found;
    }
  }

  return null;
}

function calculateOperationStats(trace: Trace): Record<
  string,
  {
    count: number;
    avgDuration: number;
    p95Duration: number;
  }
> {
  const allSpans = getAllSpansFlattened(trace);
  const operationSpans: Record<string, TraceSpan[]> = {};

  // Group leaf spans by operation type (only spans with no children)
  for (const span of allSpans) {
    // Only consider leaf nodes - spans that have no children
    if (!span.children || span.children.length === 0) {
      // Use span.op if available, otherwise extract from span.name, fallback to "unknown"
      const op = span.op || (span.name ? span.name.split(" ")[0] : "unknown");
      if (!operationSpans[op]) {
        operationSpans[op] = [];
      }
      operationSpans[op].push(span);
    }
  }

  const stats: Record<
    string,
    { count: number; avgDuration: number; p95Duration: number }
  > = {};

  // Calculate stats for each operation
  for (const [op, opSpans] of Object.entries(operationSpans)) {
    const durations = opSpans
      .map((span) => span.duration || 0)
      .filter((duration) => duration > 0)
      .sort((a, b) => a - b);

    const count = opSpans.length;
    const avgDuration =
      durations.length > 0
        ? durations.reduce((sum, duration) => sum + duration, 0) /
          durations.length
        : 0;

    // Calculate P95 (95th percentile)
    const p95Index = Math.floor(durations.length * 0.95);
    const p95Duration = durations.length > 0 ? durations[p95Index] || 0 : 0;

    stats[op] = {
      count,
      avgDuration,
      p95Duration,
    };
  }

  return stats;
}

function getAllSpansFlattened(trace: Trace): TraceSpan[] {
  const result: TraceSpan[] = [];

  function collectSpans(spanList: TraceSpan[]) {
    for (const span of spanList) {
      result.push(span);
      const children = getTraceSpanChildren(span);
      if (children.length > 0) {
        collectSpans(children);
      }
    }
  }

  collectSpans(getTraceSpans(trace));
  return result;
}

function buildTraceFetchState({
  trace,
  totalSpanCount,
}: {
  trace: Trace;
  totalSpanCount: number;
}): TraceFetchState {
  const fetchedSpanCount = getAllSpansFlattened(trace).length;

  return {
    fetchedSpanCount,
    isComplete: fetchedSpanCount >= totalSpanCount,
  };
}

function formatTraceOutput({
  organizationSlug,
  traceId,
  spanId,
  summary,
  trace,
  traceFetchState,
  apiService,
  experimentalMode,
  availableToolNames,
  directToolNames,
  aiConversations,
}: {
  organizationSlug: string;
  traceId: string;
  spanId?: string;
  summary: TraceSummary;
  trace: Trace;
  traceFetchState: TraceFetchState;
  apiService: SentryApiService;
  experimentalMode?: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
  aiConversations: AIConversationReference[];
}): string {
  if (spanId) {
    return formatFocusedSpanOutput({
      organizationSlug,
      traceId,
      spanId,
      summary,
      trace,
      traceFetchState,
      apiService,
      experimentalMode,
      availableToolNames,
      directToolNames,
      aiConversations,
    });
  }

  return formatTraceOverviewOutput({
    organizationSlug,
    traceId,
    summary,
    trace,
    apiService,
    experimentalMode,
    availableToolNames,
    directToolNames,
    aiConversations,
  });
}

function formatTraceOverviewOutput({
  organizationSlug,
  traceId,
  summary,
  trace,
  apiService,
  experimentalMode,
  availableToolNames,
  directToolNames,
  aiConversations,
}: {
  organizationSlug: string;
  traceId: string;
  summary: TraceSummary;
  trace: Trace;
  apiService: SentryApiService;
  experimentalMode?: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
  aiConversations: AIConversationReference[];
}): string {
  const sections: string[] = [];

  // Header
  sections.push(`# Trace \`${traceId}\` in **${organizationSlug}**`);
  sections.push("");

  // High-level statistics
  sections.push("## Summary");
  sections.push("");
  sections.push(`**Total Spans**: ${summary.spanCount}`);
  sections.push(`**Errors**: ${summary.errors}`);
  sections.push(`**Performance Issues**: ${summary.performanceIssues ?? 0}`);
  sections.push(`**Logs**: ${summary.logs ?? 0}`);

  // Show operation breakdown with detailed stats if we have trace data
  if (trace.length > 0) {
    const operationStats = calculateOperationStats(trace);
    const sortedOps = Object.entries(operationStats)
      .filter(([, stats]) => stats.avgDuration >= MIN_AVG_DURATION_MS) // Only show ops with avg duration >= 5ms
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, 10); // Show top 10

    if (sortedOps.length > 0) {
      sections.push("");
      sections.push("## Operation Breakdown");
      sections.push("");

      for (const [op, stats] of sortedOps) {
        const avgDuration = Math.round(stats.avgDuration);
        const p95Duration = Math.round(stats.p95Duration);
        sections.push(
          `- **${op}**: ${stats.count} spans (avg: ${avgDuration}ms, p95: ${p95Duration}ms)`,
        );
      }
      sections.push("");
    }
  }

  // Show span tree structure
  if (trace.length > 0) {
    const selectedSpans = selectInterestingSpans(trace, traceId);
    const overviewSpanCount = countSelectedSpans(selectedSpans);

    if (overviewSpanCount > 0) {
      sections.push("## Overview");
      sections.push("");
      const treeLines = renderSpanTree(selectedSpans);
      sections.push(...treeLines);
      sections.push("");

      sections.push(
        `*Overview shows ${overviewSpanCount} of ${summary.spanCount} spans.*`,
      );
      sections.push("");
    }
  }

  // Links and usage information
  const traceUrl = apiService.getTraceUrl(organizationSlug, traceId);
  sections.push("## View Full Trace");
  sections.push("");
  sections.push(`**Sentry URL**: ${traceUrl}`);
  sections.push("");

  sections.push(
    ...formatAIConversationSection({
      aiConversations,
      organizationSlug,
      experimentalMode: experimentalMode ?? false,
      availableToolNames,
      directToolNames,
    }),
  );

  sections.push("## Next Steps");
  sections.push("");
  sections.push(
    ...buildTraceNextSteps({
      organizationSlug,
      traceId,
      experimentalMode: experimentalMode ?? false,
      availableToolNames,
      directToolNames,
    }),
  );

  return sections.join("\n");
}

function formatFocusedSpanOutput({
  organizationSlug,
  traceId,
  spanId,
  summary,
  trace,
  traceFetchState,
  apiService,
  experimentalMode,
  availableToolNames,
  directToolNames,
  aiConversations,
}: {
  organizationSlug: string;
  traceId: string;
  spanId: string;
  summary: TraceSummary;
  trace: Trace;
  traceFetchState: TraceFetchState;
  apiService: SentryApiService;
  experimentalMode?: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
  aiConversations: AIConversationReference[];
}): string {
  const focusedSpan = findTraceSpan(trace, spanId);
  if (!focusedSpan) {
    if (!traceFetchState.isComplete) {
      throw new UserInputError(
        `Span \`${spanId}\` was not found in the fetched portion of trace \`${traceId}\`. ${formatIncompleteTraceFetchMessage(summary, traceFetchState)}`,
      );
    }

    throw new UserInputError(
      `Span \`${spanId}\` was not found in trace \`${traceId}\`.`,
    );
  }

  const focusedSpanId = getTraceSpanId(focusedSpan);
  const traceUrl = apiService.getTraceUrl(organizationSlug, traceId);
  const focusedSpanUrl = buildSpanUrl(traceUrl, focusedSpanId);
  const totalDescendantCount = countDescendantSpans(focusedSpan);
  const selectedTree = selectInterestingSpanSubtree(focusedSpan);
  const shownDescendantCount = countSelectedDescendants(selectedTree);
  const sections: string[] = [];

  sections.push(
    `# Span \`${focusedSpanId}\` in Trace \`${traceId}\` in **${organizationSlug}**`,
  );
  sections.push("");
  sections.push("## Summary");
  sections.push("");
  sections.push(`**Project**: ${focusedSpan.project_slug ?? "unknown"}`);
  sections.push(`**Operation**: ${focusedSpan.op ?? "unknown"}`);
  sections.push(`**Description**: ${formatTraceSpanDescription(focusedSpan)}`);
  sections.push(`**Duration**: ${formatDuration(focusedSpan.duration)}`);
  if (typeof focusedSpan.exclusive_time === "number") {
    sections.push(
      `**Exclusive Time**: ${formatDuration(focusedSpan.exclusive_time)}`,
    );
  }
  sections.push(
    `**Status**: ${focusedSpan.status ?? (focusedSpan.is_transaction ? "transaction" : "unknown")}`,
  );
  sections.push(
    `**Parent Span ID**: ${focusedSpan.parent_span_id ?? "None (root span)"}`,
  );
  sections.push(`**Child Spans**: ${getTraceSpanChildren(focusedSpan).length}`);
  sections.push(`**Descendant Spans**: ${totalDescendantCount}`);
  sections.push(
    `**Errors**: ${Array.isArray(focusedSpan.errors) ? focusedSpan.errors.length : 0}`,
  );
  sections.push(`**Event Type**: ${focusedSpan.event_type ?? "span"}`);
  sections.push(`**SDK**: ${focusedSpan.sdk_name ?? "unknown"}`);
  sections.push(`**Trace Total Spans**: ${summary.spanCount}`);
  sections.push("");
  sections.push("## Child Snapshot");
  sections.push("");
  sections.push(...renderSpanTree([selectedTree]));
  sections.push("");
  sections.push(
    `*Child snapshot shows ${shownDescendantCount} of ${totalDescendantCount} descendant spans.*`,
  );
  sections.push("");
  sections.push("## View Full Span");
  sections.push("");
  sections.push(`**Sentry URL**: ${focusedSpanUrl}`);
  sections.push("");
  sections.push("## Attributes");
  sections.push("");
  sections.push(...formatSpanAttributeSections(focusedSpan, traceId));
  sections.push(
    ...formatAIConversationSection({
      aiConversations,
      organizationSlug,
      experimentalMode: experimentalMode ?? false,
      availableToolNames,
      directToolNames,
    }),
  );
  sections.push("## Next Steps");
  sections.push("");
  sections.push(
    ...buildTraceNextSteps({
      organizationSlug,
      traceId,
      spanFocused: true,
      experimentalMode: experimentalMode ?? false,
      availableToolNames,
      directToolNames,
    }),
  );

  return sections.join("\n");
}

function formatIncompleteTraceFetchMessage(
  summary: TraceSummary,
  traceFetchState: TraceFetchState,
): string {
  return `Fetched ${traceFetchState.fetchedSpanCount} of ${summary.spanCount} spans.`;
}

function countSelectedSpans(spans: SelectedSpan[]): number {
  let count = 0;

  function visit(span: SelectedSpan): void {
    if (span.op !== "trace") {
      count += 1;
    }

    for (const child of span.children) {
      visit(child);
    }
  }

  for (const span of spans) {
    visit(span);
  }

  return count;
}

function countDescendantSpans(span: TraceSpan): number {
  let count = 0;

  for (const child of getTraceSpanChildren(span)) {
    count += 1;
    count += countDescendantSpans(child);
  }

  return count;
}

function countSelectedDescendants(span: SelectedSpan): number {
  let count = 0;

  for (const child of span.children) {
    count += 1;
    count += countSelectedDescendants(child);
  }

  return count;
}

function formatDuration(durationMs: number | undefined): string {
  if (typeof durationMs !== "number") {
    return "unknown";
  }

  return `${Math.round(durationMs)}ms`;
}

function formatTraceSpanDescription(span: TraceSpan): string {
  return formatSemanticSpanDisplay(span).label;
}

function buildSpanUrl(traceUrl: string, spanId: string): string {
  const url = new URL(traceUrl);
  url.searchParams.set("node", `span-${spanId}`);
  return url.toString();
}

function formatSpanAttributeSections(
  span: TraceSpan,
  traceId: string,
): string[] {
  const sections: string[] = [];
  const coreFields = stripUndefined({
    span_id: getTraceSpanId(span),
    event_id: span.event_id,
    trace: span.trace ?? traceId,
    transaction_id: span.transaction_id,
    parent_span_id: span.parent_span_id ?? null,
    project_id: span.project_id,
    project_slug: span.project_slug,
    profile_id: span.profile_id,
    profiler_id: span.profiler_id,
    start_timestamp: span.start_timestamp,
    end_timestamp: span.end_timestamp,
    timestamp: span.timestamp,
    duration: span.duration,
    exclusive_time: span.exclusive_time,
    transaction: span.transaction,
    is_transaction: span.is_transaction,
    description: span.description,
    sdk_name: span.sdk_name,
    op: span.op,
    name: span.name,
    event_type: span.event_type,
    status: span.status,
    is_segment: span.is_segment,
    same_process_as_parent: span.same_process_as_parent,
    hash: span.hash,
    organization: span.organization ?? null,
  });

  sections.push(...formatJsonSection("### Core Fields", coreFields));
  sections.push(
    ...formatJsonSection("### Measurements", span.measurements ?? {}),
  );
  sections.push(...formatJsonSection("### Tags", span.tags ?? {}));
  sections.push(...formatJsonSection("### Data", span.data ?? {}));
  sections.push(
    ...formatJsonSection(
      "### Additional Attributes",
      span.additional_attributes ?? {},
    ),
  );
  sections.push(...formatJsonSection("### Errors", span.errors ?? []));
  sections.push(
    ...formatJsonSection("### Occurrences", span.occurrences ?? []),
  );

  return sections;
}

function formatJsonSection(title: string, value: unknown): string[] {
  return [
    title,
    "",
    "```json",
    JSON.stringify(sortJsonValue(value), null, 2) ?? "null",
    "```",
    "",
  ];
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nestedValue]) => nestedValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, sortJsonValue(nestedValue)]),
  );
}

function stripUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

function collectAIConversationReferencesFromTrace(
  trace: Trace,
): AIConversationReference[] {
  const references = new Map<string, AIConversationReference>();

  // Known gap: trace details only expose conversation IDs already present in
  // the trace payload; unlike issue details, this path does not run a spans
  // search enrichment lookup.
  for (const span of getTraceSpans(trace)) {
    collectAIConversationReferences(span, references);
    if (references.size >= MAX_AI_CONVERSATION_REFERENCES) {
      break;
    }
  }

  return [...references.values()];
}

function collectAIConversationReferences(
  span: TraceSpan,
  references: Map<string, AIConversationReference>,
): void {
  const conversationId = getAIConversationIdFromSpan(span);
  if (conversationId && !references.has(conversationId)) {
    references.set(conversationId, {
      conversationId,
      spanId: getTraceSpanId(span),
    });
  }

  if (references.size >= MAX_AI_CONVERSATION_REFERENCES) {
    return;
  }

  for (const child of getTraceSpanChildren(span)) {
    collectAIConversationReferences(child, references);
    if (references.size >= MAX_AI_CONVERSATION_REFERENCES) {
      return;
    }
  }
}

function getAIConversationIdFromSpan(span: TraceSpan): string | undefined {
  return (
    getStringRecordValue(
      span.additional_attributes,
      "gen_ai.conversation.id",
    ) ??
    getStringRecordValue(span.data, "gen_ai.conversation.id") ??
    getStringRecordValue(span.tags, "gen_ai.conversation.id")
  );
}

function getStringRecordValue(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatAIConversationSection({
  aiConversations,
  organizationSlug,
  experimentalMode,
  availableToolNames,
  directToolNames,
}: {
  aiConversations: AIConversationReference[];
  organizationSlug: string;
  experimentalMode: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
}): string[] {
  if (aiConversations.length === 0) {
    return [];
  }

  const instructions = formatAIConversationActionInstructions({
    organizationSlug,
    aiConversations,
    experimentalMode,
    availableToolNames,
    directToolNames,
  });

  const lines = ["## Agent Conversations", ""];
  if (aiConversations.length === 1) {
    const [conversation] = aiConversations;
    lines.push(`**Conversation ID**: \`${conversation.conversationId}\``);
    if (conversation.spanId) {
      lines.push(`**Matching Span**: \`${conversation.spanId}\``);
    }
    lines.push("");
    lines.push(...instructions);
    lines.push("");
    return lines;
  }

  for (const conversation of aiConversations) {
    const spanSuffix = conversation.spanId
      ? ` (matching span: \`${conversation.spanId}\`)`
      : "";
    lines.push(`- \`${conversation.conversationId}\`${spanSuffix}`);
  }
  lines.push("");
  lines.push(...instructions.map((instruction) => `- ${instruction}`));
  lines.push("");
  return lines;
}

function buildTraceNextSteps({
  organizationSlug,
  traceId,
  spanFocused = false,
  experimentalMode,
  availableToolNames,
  directToolNames,
}: {
  organizationSlug: string;
  traceId: string;
  spanFocused?: boolean;
  experimentalMode: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
}): string[] {
  const formatSearchStep = ({
    label,
    toolName,
    arguments: args,
    fallbackInstruction,
  }: {
    label: string;
    toolName: "search_traces" | "search_errors" | "search_logs";
    arguments: Record<string, string>;
    fallbackInstruction: string;
  }) =>
    `- **${label}**: ${formatToolCallInstruction({
      toolName,
      arguments: {
        organizationSlug,
        ...args,
      },
      experimentalMode,
      availableToolNames,
      directToolNames,
      fallbackInstruction,
    })}`;

  if (hasAgentProvider()) {
    const spanQuery = spanFocused
      ? `show sibling spans or the rest of trace ${traceId}`
      : `show more spans from trace ${traceId}`;

    return [
      formatSearchStep({
        label: "Search spans",
        toolName: "search_traces",
        arguments: {
          query: spanQuery,
        },
        fallbackInstruction: "Span search is not available in this session",
      }),
      formatSearchStep({
        label: "Search errors",
        toolName: "search_errors",
        arguments: {
          query: `show error events from trace ${traceId}`,
        },
        fallbackInstruction: "Error search is not available in this session",
      }),
      formatSearchStep({
        label: "Search logs",
        toolName: "search_logs",
        arguments: {
          query: `show logs from trace ${traceId}`,
        },
        fallbackInstruction: "Log search is not available in this session",
      }),
    ];
  }

  return [
    formatSearchStep({
      label: "Search spans",
      toolName: "search_traces",
      arguments: {
        query: `trace:${traceId}`,
      },
      fallbackInstruction: "Span search is not available in this session",
    }),
    formatSearchStep({
      label: "Search errors",
      toolName: "search_errors",
      arguments: {
        query: `trace:${traceId}`,
      },
      fallbackInstruction: "Error search is not available in this session",
    }),
    formatSearchStep({
      label: "Search logs",
      toolName: "search_logs",
      arguments: {
        query: `trace:${traceId}`,
      },
      fallbackInstruction: "Log search is not available in this session",
    }),
  ];
}
