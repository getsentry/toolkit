/**
 * sentry trace view
 *
 * View detailed information about a distributed trace.
 */

import type { SentryContext } from "../../context.js";
import {
  attributesToDict,
  fetchMultiSpanDetails,
  getDetailedTrace,
  getIssueByShortId,
  getLatestEvent,
  getProject,
  type TraceItemDetail,
} from "../../lib/api-client.js";
import { looksLikeIssueShortId, spansFlag } from "../../lib/arg-parsing.js";
import { openInBrowser } from "../../lib/browser.js";
import { buildCommand } from "../../lib/command.js";
import { ORG_PROJECT_TARGET } from "../../lib/completion-target.js";
import {
  ContextError,
  ResolutionError,
  ValidationError,
} from "../../lib/errors.js";
import {
  computeTraceSummary,
  formatSimpleSpanTree,
  formatTraceSummary,
} from "../../lib/formatters/index.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  parseTraceFields,
  projectTraceFields,
  type TraceFieldSelection,
} from "../../lib/formatters/trace.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import {
  type BoundArguments,
  boundArguments,
} from "../../lib/positional-parse.js";
import { resolveOrg, toNumericId } from "../../lib/resolve-target.js";
import { buildTraceUrl } from "../../lib/sentry-web-urls.js";
import { setOrgProjectContext } from "../../lib/telemetry.js";
import {
  parseTraceArgumentsInput,
  resolveTraceArguments,
  resolveTraceOrgOptionalProject,
  type TraceArgumentsInput,
  warnIfNormalized,
} from "../../lib/trace-target.js";
import type { TraceSpan } from "../../types/index.js";

type ViewFlags = {
  readonly json: boolean;
  readonly web: boolean;
  readonly spans: number;
  readonly fresh: boolean;
  readonly full: boolean;
  readonly fields?: string[];
};

/** Usage hint for ContextError messages */
const USAGE_HINT = "sentry trace view [<org>/<project>/]<trace-id>";

/**
 * Build a contextual hint with real values for easy copy-paste.
 */
function buildViewHint(
  traceId: string,
  org: string,
  projectFilter: string | undefined,
  summary: ReturnType<typeof computeTraceSummary>,
): string {
  if (projectFilter) {
    return `Filtered to project '${projectFilter}'. Full trace: sentry trace view ${org}/${traceId}`;
  }
  if (summary.projects.length > 1) {
    const projectList = summary.projects.join(", ");
    const firstProject = summary.projects[0];
    return `This trace spans ${summary.projects.length} projects (${projectList}). Filter: sentry trace view ${org}/${firstProject}/${traceId}`;
  }
  return `Tip: Open in browser with 'sentry trace view --web ${traceId}'`;
}

/**
 * The arguments of `trace view`, parsed: an issue short ID to find the
 * trace of, or the trace ID in the forms every ID-taking command takes
 * (see `id-arguments.ts`), as typed until it resolves.
 */
export type TraceViewInput =
  | { readonly issueShortId: string }
  | {
      readonly trace: TraceArgumentsInput;
      /** Suggestion when the first argument looks like an issue short ID */
      readonly suggestion?: string;
    };

/**
 * Parse `trace view` arguments, without side effects.
 *
 * - **Single-arg issue short ID**: `CAM-82X` alone is looked up as an issue
 *   (resolve issue → trace).
 * - **Two-arg issue short ID**: `CAM-82X` with a second argument suggests
 *   `sentry issue view` (ambiguous intent, no lookup).
 *
 * @internal Exported for testing
 */
export function parseTraceViewInput(args: readonly string[]): TraceViewInput {
  const [first] = args;
  const shortId = first !== undefined && looksLikeIssueShortId(first);
  if (shortId && args.length === 1) {
    return { issueShortId: first };
  }
  return {
    trace: parseTraceArgumentsInput(args, USAGE_HINT),
    ...(shortId && { suggestion: `Did you mean: sentry issue view ${first}` }),
  };
}

/** The arguments of `trace view`. */
type TraceViewArguments = BoundArguments<TraceViewInput, ResolvedTrace>;

/**
 * Resolve `trace view` arguments to the trace and the org (and project) to
 * fetch it from, recovering a malformed trace ID.
 */
async function resolveTraceViewInput(
  input: TraceViewInput,
  context: SentryContext,
): Promise<ResolvedTrace> {
  if ("issueShortId" in input) {
    return await resolveTraceFromIssue(input.issueShortId, context.cwd);
  }
  if (input.suggestion) {
    logger.withTag("trace.view").warn(input.suggestion);
  }
  const parsed = await resolveTraceArguments(input.trace);
  warnIfNormalized(parsed, "trace.view");
  const target = await resolveTraceOrgOptionalProject(
    parsed,
    context.cwd,
    USAGE_HINT,
  );
  return {
    ...target,
    projectFilter:
      parsed.type === "explicit"
        ? (target as { project?: string }).project
        : undefined,
  };
}

/**
 * Return type for trace view — includes all data both renderers need.
 * @internal Exported for testing
 */
export type TraceViewData = {
  summary: ReturnType<typeof computeTraceSummary>;
  spans: unknown[];
  /** Pre-formatted span tree lines for human output (not serialized) */
  spanTreeLines?: string[];
  /** Per-span attribute details from trace-items endpoint (when --full or --json) */
  details?: Map<string, TraceItemDetail>;
  /** Shared interpretation used by the request and JSON projection. */
  fieldSelection?: TraceFieldSelection;
};

/**
 * Count spans in the tree that have non-empty `additional_attributes`.
 * Walks the nested children structure recursively.
 */
function countSpansWithAdditionalAttrs(spans: unknown[]): number {
  let count = 0;
  for (const raw of spans) {
    const span = raw as TraceSpan;
    const attrs = span.additional_attributes;
    if (attrs && Object.keys(attrs).length > 0) {
      count += 1;
    }
    if (span.children) {
      count += countSpansWithAdditionalAttrs(span.children);
    }
  }
  return count;
}

/** Span count threshold for the large-trace informational warning */
const LARGE_TRACE_WARN_THRESHOLD = 500;

/** Span count threshold for showing progress indicator */
const PROGRESS_THRESHOLD = 20;

/**
 * Flatten a nested span tree into an array in depth-first order.
 * Collects ALL spans — no cap.
 *
 * @internal Exported for testing
 */
export function flattenSpanTree(spans: TraceSpan[]): TraceSpan[] {
  const result: TraceSpan[] = [];
  // Reverse so the first child is popped first (depth-first order)
  const stack = [...spans].reverse();
  let span = stack.pop();
  while (span) {
    result.push(span);
    if (span.children) {
      for (let i = span.children.length - 1; i >= 0; i--) {
        const child = span.children[i];
        if (child) {
          stack.push(child);
        }
      }
    }
    span = stack.pop();
  }
  return result;
}

/**
 * Recursively merge detail data dicts onto a span tree for JSON output.
 * Each span with a matching detail entry gets a `data` dict containing
 * filtered custom attributes.
 */
function mergeSpanDetails(
  span: TraceSpan,
  details: Map<string, TraceItemDetail>,
): TraceSpan & { data?: Record<string, unknown> } {
  const { children, ...rest } = span;
  const result: TraceSpan & { data?: Record<string, unknown> } = { ...rest };

  if (span.span_id) {
    const detail = details.get(span.span_id);
    if (detail) {
      const data = attributesToDict(detail.attributes);
      if (Object.keys(data).length > 0) {
        result.data = data;
      }
    }
  }

  if (children) {
    result.children = children.map((c) => mergeSpanDetails(c, details));
  }

  return result;
}

/**
 * Format trace view data for human-readable terminal output.
 *
 * Renders trace summary and optional span tree.
 * When spans carry `additional_attributes` (requested via `--fields`),
 * a note is appended indicating how many spans have extra data.
 * When `details` are present (from --full or --json), notes their count.
 *
 * @internal Exported for testing
 */
export function formatTraceView(data: TraceViewData): string {
  const parts: string[] = [];

  parts.push(formatTraceSummary(data.summary));

  if (data.spanTreeLines && data.spanTreeLines.length > 0) {
    parts.push(data.spanTreeLines.join("\n"));
  }

  // Note spans with additional_attributes (from --fields)
  const attrsCount = countSpansWithAdditionalAttrs(data.spans);
  if (attrsCount > 0) {
    const spanWord = attrsCount === 1 ? "span has" : "spans have";
    parts.push(
      `\n${attrsCount} ${spanWord} additional attributes. Use --json to see them.`,
    );
  }

  // Note spans with full detail data (from --full or auto-fetched with --json)
  if (data.details && data.details.size > 0) {
    parts.push(
      `\n${data.details.size} span(s) have attribute data. Use --json to see full details.`,
    );
  }

  return parts.join("\n");
}

/**
 * Return a copy of the span with zero-valued measurements removed.
 *
 * The Sentry trace detail API returns `measurements` on every span with
 * zero-valued web vitals (CLS, FCP, INP, LCP, TTFB, etc.) even for
 * non-browser spans. This adds ~40% noise to JSON output. This helper
 * strips entries where the value is exactly `0`, and omits the
 * `measurements` field entirely when all values are zero. Non-zero
 * measurements (e.g., on root `pageload` spans) are preserved.
 *
 * Processes children recursively so the entire span tree is cleaned.
 */
function filterSpanMeasurements(span: TraceSpan): TraceSpan {
  const { measurements, children, ...rest } = span;

  let cleanedMeasurements: Record<string, number> | undefined;
  if (measurements) {
    const nonZero = Object.fromEntries(
      Object.entries(measurements).filter(([, v]) => v !== 0),
    );
    if (Object.keys(nonZero).length > 0) {
      cleanedMeasurements = nonZero;
    }
  }

  return {
    ...rest,
    ...(cleanedMeasurements ? { measurements: cleanedMeasurements } : {}),
    ...(children ? { children: children.map(filterSpanMeasurements) } : {}),
  };
}

/**
 * Transform trace view data for JSON output.
 *
 * Flattens the summary as the primary object so that `--fields traceId,duration`
 * works directly on summary properties. The raw `spans` array is preserved as
 * a nested key, accessible via `--fields spans`. Bare attribute selectors
 * retain span IDs and children so their values remain attributable.
 *
 * Without this transform, `--fields traceId` would return `{}` because
 * the raw yield shape is `{ summary, spans }` and `traceId` lives inside `summary`.
 *
 * Zero-valued measurements are filtered from each span to reduce noise
 * from the API (which returns zero web vitals on non-browser spans).
 */
function jsonTransformTraceView(
  data: TraceViewData,
  fields?: string[],
): unknown {
  const { summary, spans, details } = data;
  const cleanedSpans = (spans as TraceSpan[]).map((span) => {
    const cleaned = filterSpanMeasurements(span);
    return details && details.size > 0
      ? mergeSpanDetails(cleaned, details)
      : cleaned;
  });
  const result = { ...summary, spans: cleanedSpans };
  const selection = data.fieldSelection ?? parseTraceFields(fields);
  return selection ? projectTraceFields(result, selection) : result;
}

/** Resolved trace target: org, project (optional), and trace ID */
type ResolvedTrace = {
  traceId: string;
  org: string;
  project?: string;
  /** Project slug when user explicitly provided org/project/trace-id */
  projectFilter?: string;
};

/**
 * Resolve a trace from an issue short ID by looking up the issue,
 * fetching its latest event, and extracting the trace ID.
 */
async function resolveTraceFromIssue(
  issueShortId: string,
  cwd: string,
): Promise<ResolvedTrace> {
  const log = logger.withTag("trace.view");
  log.warn(
    `'${issueShortId}' is an issue short ID, not a trace ID. Looking up the issue's trace.`,
  );

  const resolved = await resolveOrg({ cwd });
  if (!resolved) {
    throw new ContextError("Organization", `sentry issue view ${issueShortId}`);
  }
  const org = resolved.org;

  const issue = await getIssueByShortId(org, issueShortId);
  let project: string | undefined;
  if (issue.project?.slug) {
    setOrgProjectContext([org], [issue.project.slug]);
    project = issue.project.slug;
  }

  const event = await getLatestEvent(org, issue.id);
  const traceId = event?.contexts?.trace?.trace_id;
  if (!traceId) {
    throw new ValidationError(
      `Could not find a trace for issue '${issueShortId}'. The latest event has no trace context.\n\n` +
        `Try: sentry issue view ${issueShortId}`,
    );
  }

  return { traceId, org, project };
}

/**
 * Fetch per-span details when --full or --json is active.
 *
 * Extracted from func() to keep cognitive complexity manageable.
 * Logs a warning for large traces and reports progress
 * on stderr for traces with more than {@link PROGRESS_THRESHOLD} spans.
 */
function fetchTraceSpanDetails(
  spans: TraceSpan[],
  totalCount: number,
  options: {
    org: string;
    fallbackProject: string;
    traceId: string;
  },
): Promise<Map<string, TraceItemDetail>> {
  const log = logger.withTag("trace.view");
  const flat = flattenSpanTree(spans);

  if (totalCount > LARGE_TRACE_WARN_THRESHOLD) {
    log.warn(
      `Trace has ${totalCount} spans \u2014 this may take a moment. ` +
        "Use 'sentry span view' for specific spans.",
    );
  }

  return fetchMultiSpanDetails(flat, {
    ...options,
    onProgress:
      flat.length > PROGRESS_THRESHOLD
        ? (done, total) => {
            log.info(`Fetching span data (${done}/${total})...`);
          }
        : undefined,
  });
}

export const viewCommand = buildCommand({
  docs: {
    brief: "View details of a specific trace",
    fullDescription:
      "View detailed information about a distributed trace by its ID.\n\n" +
      "The trace ID is the 32-character hexadecimal identifier.",
    examples: [
      {
        description: "View trace details with the span tree",
        command: "sentry trace view abc123def456abc123def456abc12345",
      },
      {
        description: "Show the full trace across all projects",
        command: "sentry trace view my-org/abc123def456abc123def456abc12345",
      },
      {
        description: "Filter the span tree to one project",
        command:
          "sentry trace view my-org/cli-server/abc123def456abc123def456abc12345",
      },
      {
        description: "Recover the trace from an issue short ID",
        command: "sentry trace view PROJ-123",
      },
      {
        description: "Open the trace in the browser",
        command: "sentry trace view abc123def456abc123def456abc12345 -w",
      },
      {
        description: "Find a project across organizations",
        command:
          "sentry trace view cli-server abc123def456abc123def456abc12345",
      },
      {
        description:
          "Select the trace ID and an attribute across the whole span tree",
        command:
          "sentry trace view abc123def456abc123def456abc12345 --json --fields traceId,http.method",
      },
      {
        description: "Keep full spans while requesting an additional attribute",
        command:
          "sentry trace view abc123def456abc123def456abc12345 --json --fields spans,http.method",
      },
      {
        description: "Select IDs and detail attributes from root spans only",
        command:
          "sentry trace view abc123def456abc123def456abc12345 --json --fields spans.span_id,spans.data.http.method",
      },
      {
        description:
          "Select an additional attribute from immediate child spans",
        command:
          "sentry trace view abc123def456abc123def456abc12345 --json --fields spans.children.additional_attributes.http.method",
      },
    ],
  },
  output: {
    human: formatTraceView,
    jsonTransform: jsonTransformTraceView,
  },
  parameters: {
    positional: boundArguments({
      placeholder: "org/project/trace-id",
      brief:
        "[<org>/<project>/]<trace-id> - Target (optional) and trace ID (required)",
      kind: ORG_PROJECT_TARGET,
      parse: parseTraceViewInput,
      resolve: resolveTraceViewInput,
    }),
    flags: {
      web: {
        kind: "boolean",
        brief: "Open in browser",
        default: false,
      },
      full: {
        kind: "boolean",
        brief: "Fetch full span attributes (auto-enabled with --json)",
        default: false,
      },
      ...spansFlag,
      fresh: FRESH_FLAG,
    },
    aliases: { ...FRESH_ALIASES, w: "web" },
  },
  async *func(
    this: SentryContext,
    flags: ViewFlags,
    target: TraceViewArguments,
  ) {
    applyFreshFlag(flags);
    const { traceId, org, project, projectFilter } = await target.resolved;

    if (flags.web) {
      await openInBrowser(buildTraceUrl(org, traceId), "trace");
      return;
    }

    const fieldSelection = parseTraceFields(flags.fields);
    const additionalAttributes = fieldSelection?.additionalAttributes.length
      ? fieldSelection.additionalAttributes
      : undefined;

    // Resolve numeric project ID for API-level filtering
    let numericProjectId: number | undefined;
    if (projectFilter) {
      const projectData = await getProject(org, projectFilter);
      numericProjectId = toNumericId(projectData.id);
    }

    const spans = await getDetailedTrace(org, traceId, {
      additionalAttributes,
      projectId: numericProjectId,
    });

    if (spans.length === 0) {
      throw new ResolutionError(
        `Trace '${traceId}'`,
        "not found",
        `sentry trace view ${org}/${project ?? "<project>"}/${traceId}`,
        [
          "Check that you are querying the right org/project",
          "The trace may be past your plan's retention window",
        ],
      );
    }

    const summary = computeTraceSummary(traceId, spans);

    // Format span tree (unless disabled with --spans 0 or --spans no)
    const spanTreeLines =
      flags.spans > 0
        ? formatSimpleSpanTree(traceId, spans, flags.spans, {
            projectFiltered: !!projectFilter,
          })
        : undefined;

    // Fetch per-span details when --full is set or --json auto-enables it
    const shouldFetchDetails = flags.full || flags.json;
    const spanDetails = shouldFetchDetails
      ? await fetchTraceSpanDetails(spans, summary.spanCount, {
          org,
          fallbackProject: project ?? spans[0]?.project_slug ?? "",
          traceId,
        })
      : undefined;

    yield new CommandOutput({
      summary,
      spans,
      spanTreeLines,
      details: spanDetails,
      fieldSelection,
    });
    return { hint: buildViewHint(traceId, org, projectFilter, summary) };
  },
});
