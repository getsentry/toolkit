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
import {
  detectSwappedViewArgs,
  looksLikeIssueShortId,
  spansFlag,
} from "../../lib/arg-parsing.js";
import { openInBrowser } from "../../lib/browser.js";
import { buildCommand } from "../../lib/command.js";
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
import { filterFields } from "../../lib/formatters/json.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import { resolveOrg, toNumericId } from "../../lib/resolve-target.js";
import { buildTraceUrl } from "../../lib/sentry-urls.js";
import { setOrgProjectContext } from "../../lib/telemetry.js";
import {
  parseTraceTargetWithRecovery,
  resolveTraceOrgOptionalProject,
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
  summary: ReturnType<typeof computeTraceSummary>
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
 * Standard field names in trace view output (summary keys + "spans").
 *
 * When `--fields` includes names beyond these, the extras are forwarded
 * to the API as `additional_attributes` so the server populates them on
 * each span.
 */
const STANDARD_TRACE_VIEW_FIELDS = new Set([
  "traceId",
  "duration",
  "spanCount",
  "projects",
  "rootTransaction",
  "rootOp",
  "startTimestamp",
  "spans",
  "spanTreeLines",
]);

/**
 * Extract non-standard field names from `--fields` to pass as
 * `additional_attributes` to the trace detail API.
 *
 * Standard fields (summary keys, "spans") are filtered out because
 * they are already present in the response. Only extra names that
 * correspond to span attributes need to be requested from the API.
 *
 * @param fields - Parsed `--fields` value (may be undefined)
 * @returns Attribute names to request, or undefined when none are needed
 */
export function extractAdditionalAttributes(
  fields: string[] | undefined
): string[] | undefined {
  if (!fields || fields.length === 0) {
    return;
  }
  const extra = fields.filter((f) => !STANDARD_TRACE_VIEW_FIELDS.has(f));
  return extra.length > 0 ? extra : undefined;
}

/**
 * Detect UX issues in raw positional args before trace-target parsing.
 *
 * - **Single-arg issue short ID**: first arg looks like `CAM-82X` with no
 *   second arg → sets `issueShortId` for auto-recovery (resolve issue → trace).
 * - **Swapped args**: user typed `<trace-id> <org>/<project>` instead of
 *   `<org>/<project> <trace-id>`. If detected, swaps them silently and warns.
 * - **Two-arg issue short ID**: first arg looks like `CAM-82X` with a second
 *   arg → suggests `sentry issue view` (ambiguous intent, no auto-recovery).
 *
 * Returns corrected args and optional warnings to emit.
 *
 * @internal Exported for testing
 */
export function preProcessArgs(args: string[]): {
  correctedArgs: string[];
  warning?: string;
  suggestion?: string;
  /** Issue short ID detected for auto-recovery (single-arg only) */
  issueShortId?: string;
} {
  if (args.length === 0) {
    return { correctedArgs: args };
  }

  const first = args[0];
  if (!first) {
    return { correctedArgs: args };
  }

  // Single-arg issue short ID → auto-recover by resolving issue → trace
  if (args.length === 1 && looksLikeIssueShortId(first)) {
    return {
      correctedArgs: args,
      issueShortId: first,
    };
  }

  if (args.length < 2) {
    return { correctedArgs: args };
  }

  const second = args[1];
  if (!second) {
    return { correctedArgs: args };
  }

  // Detect swapped args: user put ID first and target second
  const swapWarning = detectSwappedViewArgs(first, second);
  if (swapWarning) {
    // Swap them: put target first, trace ID second
    return {
      correctedArgs: [second, first, ...args.slice(2)],
      warning: swapWarning,
    };
  }

  // Detect issue short ID passed as first arg (two-arg case — ambiguous)
  const suggestion = looksLikeIssueShortId(first)
    ? `Did you mean: sentry issue view ${first}`
    : undefined;

  return { correctedArgs: args, suggestion };
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
  const stack = Array.from(spans).reverse();
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
  details: Map<string, TraceItemDetail>
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
      `\n${attrsCount} ${spanWord} additional attributes. Use --json to see them.`
    );
  }

  // Note spans with full detail data (from --full or auto-fetched with --json)
  if (data.details && data.details.size > 0) {
    parts.push(
      `\n${data.details.size} span(s) have attribute data. Use --json to see full details.`
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
      Object.entries(measurements).filter(([, v]) => v !== 0)
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
 * a nested key, accessible via `--fields spans`.
 *
 * Without this transform, `--fields traceId` would return `{}` because
 * the raw yield shape is `{ summary, spans }` and `traceId` lives inside `summary`.
 *
 * Zero-valued measurements are filtered from each span to reduce noise
 * from the API (which returns zero web vitals on non-browser spans).
 */
function jsonTransformTraceView(
  data: TraceViewData,
  fields?: string[]
): unknown {
  const { summary, spans, details } = data;
  const cleanedSpans = (spans as TraceSpan[]).map((span) => {
    const cleaned = filterSpanMeasurements(span);
    return details && details.size > 0
      ? mergeSpanDetails(cleaned, details)
      : cleaned;
  });
  const result: Record<string, unknown> = { ...summary, spans: cleanedSpans };
  if (fields && fields.length > 0) {
    return filterFields(result, fields);
  }
  return result;
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
  cwd: string
): Promise<ResolvedTrace> {
  const log = logger.withTag("trace.view");
  log.warn(
    `'${issueShortId}' is an issue short ID, not a trace ID. Looking up the issue's trace.`
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
        `Try: sentry issue view ${issueShortId}`
    );
  }

  return { traceId, org, project };
}

/**
 * Fetch per-span details when --full or --json is active.
 *
 * Extracted from func() to keep cognitive complexity under the Biome
 * limit of 15. Logs a warning for large traces and reports progress
 * on stderr for traces with more than {@link PROGRESS_THRESHOLD} spans.
 */
function fetchTraceSpanDetails(
  spans: TraceSpan[],
  totalCount: number,
  options: {
    org: string;
    fallbackProject: string;
    traceId: string;
  }
): Promise<Map<string, TraceItemDetail>> {
  const log = logger.withTag("trace.view");
  const flat = flattenSpanTree(spans);

  if (totalCount > LARGE_TRACE_WARN_THRESHOLD) {
    log.warn(
      `Trace has ${totalCount} spans \u2014 this may take a moment. ` +
        "Use 'sentry span view' for specific spans."
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
      "Target specification:\n" +
      "  sentry trace view <trace-id>                       # auto-detect from DSN or config\n" +
      "  sentry trace view <org>/<project>/<trace-id>       # explicit org and project\n" +
      "  sentry trace view <project> <trace-id>             # find project across all orgs\n\n" +
      "The trace ID is the 32-character hexadecimal identifier.",
  },
  output: {
    human: formatTraceView,
    jsonTransform: jsonTransformTraceView,
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        placeholder: "org/project/trace-id",
        brief:
          "[<org>/<project>/]<trace-id> - Target (optional) and trace ID (required)",
        parse: String,
      },
    },
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
  async *func(this: SentryContext, flags: ViewFlags, ...args: string[]) {
    applyFreshFlag(flags);
    const { cwd } = this;
    const log = logger.withTag("trace.view");

    // Pre-process: detect swapped args and issue short IDs
    const { correctedArgs, warning, suggestion, issueShortId } =
      preProcessArgs(args);
    if (warning) {
      log.warn(warning);
    }
    if (suggestion) {
      log.warn(suggestion);
    }

    let resolved: ResolvedTrace;
    if (issueShortId) {
      resolved = await resolveTraceFromIssue(issueShortId, cwd);
    } else {
      const parsed = await parseTraceTargetWithRecovery(
        correctedArgs,
        USAGE_HINT
      );
      warnIfNormalized(parsed, "trace.view");
      const target = await resolveTraceOrgOptionalProject(
        parsed,
        cwd,
        USAGE_HINT
      );
      resolved = {
        ...target,
        projectFilter:
          parsed.type === "explicit"
            ? (target as { project?: string }).project
            : undefined,
      };
    }
    const { traceId, org, project, projectFilter } = resolved;

    if (flags.web) {
      await openInBrowser(buildTraceUrl(org, traceId), "trace");
      return;
    }

    // Forward non-standard --fields as additional_attributes so the
    // trace API populates them on each span for JSON consumers.
    const additionalAttributes = extractAdditionalAttributes(flags.fields);

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
        ]
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
    });
    return { hint: buildViewHint(traceId, org, projectFilter, summary) };
  },
});
