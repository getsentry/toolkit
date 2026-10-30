/**
 * sentry span view
 *
 * View detailed information about one or more spans within a trace.
 */

import type { SentryContext } from "../../context.js";
import {
  attributesToDict,
  fetchMultiSpanDetails,
  getDetailedTrace,
  type TraceItemDetail,
} from "../../lib/api-client.js";
import { spansFlag } from "../../lib/arg-parsing.js";
import { buildCommand } from "../../lib/command.js";
import { ORG_PROJECT_TARGET } from "../../lib/completion-target.js";
import {
  ContextError,
  ResolutionError,
  ValidationError,
} from "../../lib/errors.js";
import {
  type FoundSpan,
  findSpanById,
  formatSimpleSpanTree,
  formatSpanDetails,
} from "../../lib/formatters/index.js";
import { filterFields } from "../../lib/formatters/json.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { computeSpanDurationMs } from "../../lib/formatters/time-utils.js";
import { validateSpanId } from "../../lib/hex-id.js";
import {
  handleRecoveryResult,
  recoverHexId,
} from "../../lib/hex-id-recovery.js";
import { ID_KINDS, parseIdArguments } from "../../lib/id-arguments.js";
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
import {
  parseTraceArgumentsInput,
  type ResolvedTraceOrgProject,
  resolveTraceArguments,
  resolveTraceOrgProject,
  type TraceArgumentsInput,
  warnIfNormalized,
} from "../../lib/trace-target.js";

const log = logger.withTag("span.view");

type ViewFlags = {
  readonly json: boolean;
  readonly spans: number;
  readonly fresh: boolean;
  readonly fields?: string[];
};

/** Usage hint for ContextError messages */
const USAGE_HINT =
  "sentry span view [<org>/<project>/]<trace-id> <span-id> [<span-id>...]";

/** The arguments of `span view`, parsed but with the IDs as typed. */
export type SpanViewInput = {
  /** The trace, validated (or recovered) when the arguments resolve */
  readonly trace: TraceArgumentsInput;
  readonly rawSpanIds: readonly string[];
};

/** The trace and the span IDs of `span view`, validated or recovered. */
type ResolvedSpans = ResolvedTraceOrgProject & {
  readonly spanIds: string[];
};

/** The arguments of `span view`. */
type SpanViewArguments = BoundArguments<SpanViewInput, ResolvedSpans>;

/**
 * Parse `span view` arguments, without side effects.
 *
 * Span IDs take the forms every ID-taking command does (see
 * `id-arguments.ts`), with the trace as their target:
 * `[<org>/<project>/]<trace-id> <span-id>...`, or
 * `[<org>/<project>/]<trace-id>/<span-id>` in one argument (as `span list`
 * prints them), with more span IDs after it.
 *
 * IDs are kept as typed: {@link resolveSpanViewInput} validates the trace
 * and then the spans once it knows the trace, so malformed IDs can be
 * recovered.
 *
 * @throws {ContextError} If the trace or the span IDs are missing
 */
export function parseSpanViewInput(rawArgs: readonly string[]): SpanViewInput {
  // A lone argument that does not end in a span ID is the trace
  const { target, ids } = parseIdArguments(rawArgs, ID_KINDS.span, {
    usageHint: USAGE_HINT,
    multiple: true,
    optional: true,
    needsProject: true,
    validate: false,
  });
  const [first] = ids;

  if (target === undefined) {
    // Span IDs without a trace: say so, rather than "invalid trace ID"
    // (CLI-SC)
    throw new ContextError(
      "Trace ID and span ID",
      USAGE_HINT,
      first && ID_KINDS.span.isId(first)
        ? [
            `'${first}' looks like a span ID (16 characters), not a trace ID`,
            `Provide the trace ID first: sentry span view <trace-id> ${validateSpanId(first)}`,
            `Use 'sentry trace list' to find trace IDs`,
          ]
        : [],
    );
  }

  if (first === undefined) {
    throw new ContextError("Span ID", USAGE_HINT, [
      `Use 'sentry span list ${target}' to find span IDs within this trace`,
    ]);
  }

  return { trace: parseTrace(target, first), rawSpanIds: ids };
}

/**
 * Parse the target of the span IDs as the trace, with a trace-focused error
 * when it has no trace ID, as in `<org>/<project>/<span-id>` (CLI-1GP). A
 * malformed trace ID is left for {@link resolveTraceArguments}.
 *
 * @throws {ContextError} When the trace ID is missing
 */
function parseTrace(traceArg: string, spanId: string): TraceArgumentsInput {
  try {
    return parseTraceArgumentsInput([traceArg], USAGE_HINT, {
      needsProject: true,
    });
  } catch (error) {
    if (!(error instanceof ContextError)) {
      throw error;
    }
    throw new ContextError("Trace ID", USAGE_HINT, [
      `'${traceArg}' is missing a trace ID before the span ID '${spanId}'`,
      `Provide the trace ID: sentry span view ${traceArg}/<trace-id> ${spanId}`,
    ]);
  }
}

/**
 * Resolve `span view` arguments: validate (or recover) the trace ID, find
 * the trace's org and project, then validate (or recover) the span IDs in
 * that trace.
 */
async function resolveSpanViewInput(
  input: SpanViewInput,
  context: SentryContext,
): Promise<ResolvedSpans> {
  const traceTarget = await resolveTraceArguments(input.trace);
  warnIfNormalized(traceTarget, "span.view");
  const { traceId, org, project } = await resolveTraceOrgProject(
    traceTarget,
    context.cwd,
    USAGE_HINT,
  );
  // Span IDs are unique only within a trace, so recovery scopes its fuzzy
  // lookup via `ctx.traceId`.
  const spanIds = await Promise.all(
    input.rawSpanIds.map((raw) =>
      validateAndRecoverSpanId(raw, { org, project, traceId }),
    ),
  );
  return { traceId, org, project, spanIds };
}

/**
 * Validate a raw span ID, attempting {@link recoverHexId} on
 * {@link ValidationError}. Requires trace-scoped context because span IDs
 * are only unique within a trace.
 */
async function validateAndRecoverSpanId(
  rawSpanId: string,
  ctx: { org: string; project: string; traceId: string },
): Promise<string> {
  try {
    return ID_KINDS.span.validate(rawSpanId);
  } catch (err) {
    if (!(err instanceof ValidationError)) {
      throw err;
    }
    const result = await recoverHexId(rawSpanId, "span", ctx);
    return handleRecoveryResult(result, err, {
      entityType: "span",
      canonicalCommand: `sentry span view ${ctx.org}/${ctx.project}/${ctx.traceId} <id>`,
      logTag: "span.view",
    });
  }
}

/**
 * Format a list of span IDs as a markdown bullet list.
 */
function formatIdList(ids: string[]): string {
  return ids.map((id) => ` - \`${id}\``).join("\n");
}

/**
 * Warn about span IDs that weren't found in the trace.
 */
function warnMissingIds(spanIds: string[], foundIds: Set<string>): void {
  const missing = spanIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    log.warn(
      `${missing.length} of ${spanIds.length} span(s) not found in trace:\n${formatIdList(missing)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Output config types and formatters
// ---------------------------------------------------------------------------

/** Resolved span result from tree search. */
type SpanResult = FoundSpan & { spanId: string };

/** Structured data returned by the command for both JSON and human output */
type SpanViewData = {
  /** Found span results with ancestors and depth */
  results: SpanResult[];
  /** The trace ID for context */
  traceId: string;
  /** Maximum child tree depth to display (from --spans flag) */
  spansDepth: number;
  /** Full attribute details per span ID (from trace-items endpoint) */
  details?: Map<string, TraceItemDetail>;
};

/**
 * Serialize span results for JSON output.
 *
 * When `details` is provided (from the trace-items endpoint), each span
 * gains a `data` dict containing all custom attributes. Internal/storage
 * attributes are filtered out for readability.
 */
function buildJsonResults(
  results: SpanResult[],
  traceId: string,
  details?: Map<string, TraceItemDetail>,
): unknown[] {
  return results.map((r) => {
    const base: Record<string, unknown> = {
      span_id: r.span.span_id,
      parent_span_id: r.span.parent_span_id,
      trace_id: traceId,
      op: r.span.op || r.span["transaction.op"],
      description: r.span.description || r.span.transaction,
      start_timestamp: r.span.start_timestamp,
      end_timestamp: r.span.end_timestamp || r.span.timestamp,
      duration: computeSpanDurationMs(r.span),
      project_slug: r.span.project_slug,
      transaction: r.span.transaction,
      depth: r.depth,
      ancestors: r.ancestors.map((a) => ({
        span_id: a.span_id,
        op: a.op || a["transaction.op"],
        description: a.description || a.transaction,
      })),
      children: (r.span.children ?? []).map((c) => ({
        span_id: c.span_id,
        op: c.op || c["transaction.op"],
        description: c.description || c.transaction,
      })),
    };

    // Merge full attribute data from the trace-items endpoint
    const detail = details?.get(r.spanId);
    if (detail) {
      const data = attributesToDict(detail.attributes);
      if (Object.keys(data).length > 0) {
        base.data = data;
      }
    }

    return base;
  });
}

/**
 * Format span view data for human-readable terminal output.
 *
 * Renders each span's details (KV table + ancestor chain) and optionally
 * shows the child span tree. When attribute details are available, notable
 * custom attributes are appended after the standard fields.
 * Multiple spans are separated by `---`.
 */
function formatSpanViewHuman(data: SpanViewData): string {
  const parts: string[] = [];
  for (let i = 0; i < data.results.length; i++) {
    if (i > 0) {
      parts.push("\n---\n");
    }
    const result = data.results[i];
    if (!result) {
      continue;
    }

    // Standard span details (KV table + ancestor chain)
    const detail = data.details?.get(result.spanId);
    parts.push(
      formatSpanDetails(result.span, result.ancestors, data.traceId, detail),
    );

    // Show child tree if --spans > 0 and the span has children
    const children = result.span.children ?? [];
    if (data.spansDepth > 0 && children.length > 0) {
      const treeLines = formatSimpleSpanTree(
        data.traceId,
        [result.span],
        data.spansDepth,
      );
      if (treeLines.length > 0) {
        parts.push(`${treeLines.join("\n")}\n`);
      }
    }
  }
  return parts.join("");
}

/**
 * Transform span view data for JSON output.
 * Applies `--fields` filtering per element.
 */
function jsonTransformSpanView(data: SpanViewData, fields?: string[]): unknown {
  const mapped = buildJsonResults(data.results, data.traceId, data.details);
  if (fields && fields.length > 0) {
    return mapped.map((item) => filterFields(item, fields));
  }
  return mapped;
}

export const viewCommand = buildCommand({
  docs: {
    brief: "View details of specific spans",
    fullDescription:
      "View detailed information about one or more spans within a trace.\n\n" +
      "The first argument is the trace ID (optionally prefixed with org/project),\n" +
      "followed by one or more span IDs.",
    examples: [
      {
        description: "View a single span",
        command:
          "sentry span view abc123def456abc123def456abc12345 a1b2c3d4e5f67890",
      },
      {
        description: "View multiple spans at once",
        command:
          "sentry span view abc123def456abc123def456abc12345 a1b2c3d4e5f67890 b2c3d4e5f6789012",
      },
      {
        description: "Specify the organization and project explicitly",
        command:
          "sentry span view my-org/backend/abc123def456abc123def456abc12345 a1b2c3d4e5f67890",
      },
    ],
  },
  output: {
    human: formatSpanViewHuman,
    jsonTransform: jsonTransformSpanView,
  },
  parameters: {
    positional: boundArguments({
      placeholder: "trace-id/span-id",
      brief:
        "[<org>/<project>/]<trace-id> <span-id> [<span-id>...] - Trace ID and one or more span IDs",
      kind: ORG_PROJECT_TARGET,
      parse: parseSpanViewInput,
      resolve: resolveSpanViewInput,
    }),
    flags: {
      ...spansFlag,
      fresh: FRESH_FLAG,
    },
    aliases: { ...FRESH_ALIASES },
  },
  async *func(
    this: SentryContext,
    flags: ViewFlags,
    target: SpanViewArguments,
  ) {
    applyFreshFlag(flags);
    const { traceId, org, project, spanIds } = await target.resolved;

    // Fetch trace data (single fetch for all span lookups)
    const spans = await getDetailedTrace(org, traceId);

    if (spans.length === 0) {
      throw new ResolutionError(`Trace "${traceId}"`, "not found", USAGE_HINT, [
        "The ID format is valid but no matching trace exists in this project",
        "Check that you are querying the right org/project, or the trace may be past your plan's retention window",
      ]);
    }

    // Find each requested span
    const results: SpanResult[] = [];
    const foundIds = new Set<string>();

    for (const spanId of spanIds) {
      const found = findSpanById(spans, spanId);
      if (found) {
        results.push({
          spanId,
          span: found.span,
          ancestors: found.ancestors,
          depth: found.depth,
        });
        foundIds.add(spanId);
      }
    }

    if (results.length === 0) {
      if (spanIds.length === 1) {
        throw new ResolutionError(
          `Span "${spanIds[0]}" in trace ${traceId}`,
          "not found",
          USAGE_HINT,
        );
      }
      const idList = formatIdList(spanIds);
      throw new ResolutionError(
        `Spans in trace ${traceId}`,
        "none of the requested IDs were found",
        USAGE_HINT,
        [`Requested IDs:\n${idList}`],
      );
    }

    warnMissingIds(spanIds, foundIds);

    // Fetch full attribute details for each found span in parallel.
    // Uses the trace-items detail endpoint which returns ALL attributes.
    const details = await fetchMultiSpanDetails(
      results.map((r) => ({
        span_id: r.spanId,
        project_slug: r.span.project_slug,
      })),
      { org, fallbackProject: project, traceId },
    );

    yield new CommandOutput({
      results,
      traceId,
      spansDepth: flags.spans,
      details,
    });
  },
});
