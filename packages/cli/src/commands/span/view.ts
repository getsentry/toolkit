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
import { HEX_ID_RE, SPAN_ID_RE, validateSpanId } from "../../lib/hex-id.js";
import {
  handleRecoveryResult,
  recoverHexId,
} from "../../lib/hex-id-recovery.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import {
  parseSlashSeparatedTraceTarget,
  parseTraceTargetWithRecovery,
  resolveTraceOrgProject,
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

/** Result of the initial positional-arg parse for `span view`. */
type SpanViewArgs =
  | {
      /** Args are already resolved (auto-split `<trace-id>/<span-id>`). */
      kind: "resolved";
      traceTarget: ReturnType<typeof parseSlashSeparatedTraceTarget>;
      rawSpanIds: string[];
    }
  | {
      /**
       * First arg is the raw trace target (needs async recovery); the rest
       * are raw span IDs. Command layer calls `parseTraceTargetWithRecovery`.
       */
      kind: "deferred";
      rawTraceArg: string;
      rawSpanIds: string[];
    };

/**
 * Parse positional arguments for span view.
 *
 * Handles a few sync edge cases (single-arg `<trace>/<span>` slash split,
 * bare span ID without a trace) and returns either a fully-resolved
 * target or a deferred form. In the deferred case the command layer calls
 * {@link parseTraceTargetWithRecovery} on `rawTraceArg` so a malformed
 * trace ID gets the full recovery treatment (matching `trace view`
 * behavior).
 *
 * @throws {ContextError} If insufficient arguments or a single bare span ID
 */

/**
 * Try to auto-split a single arg of the form `<trace-target>/<span-id>`.
 *
 * Handles one-slash (`<trace-id>/<span-id>`) and multi-slash
 * (`org/project/<trace-id>/<span-id>`) forms. Returns null when the arg
 * cannot be unambiguously split (e.g. left side is not a hex trace ID in
 * the single-slash case). Throws a trace-focused {@link ContextError} when
 * the arg clearly intends the `<trace-target>/<span-id>` form but the
 * trace-target portion is invalid (e.g. `org/project/<span-id>`).
 *
 * @throws {ContextError} When the trace-target prefix fails validation.
 */
function tryAutoSplitSpanArg(arg: string): SpanViewArgs | null {
  const lastSlashIdx = arg.lastIndexOf("/");
  if (lastSlashIdx === -1) {
    return null;
  }

  const tracePrefix = arg.slice(0, lastSlashIdx);
  const possibleSpanId = arg
    .slice(lastSlashIdx + 1)
    .trim()
    .toLowerCase()
    .replace(/-/g, "");

  if (!SPAN_ID_RE.test(possibleSpanId) || tracePrefix.length === 0) {
    return null;
  }

  const hasMultipleSlashes = tracePrefix.includes("/");
  const normalizedPrefix = tracePrefix.trim().toLowerCase().replace(/-/g, "");

  // For single-slash form the prefix must be a hex trace ID.
  // For multi-slash (org/project/trace-id) always attempt the split.
  if (!(hasMultipleSlashes || HEX_ID_RE.test(normalizedPrefix))) {
    return null;
  }

  let traceTarget: ReturnType<typeof parseSlashSeparatedTraceTarget>;
  try {
    traceTarget = parseSlashSeparatedTraceTarget(tracePrefix, USAGE_HINT);
  } catch (_error) {
    // We already confirmed the last segment is a span ID and the prefix
    // looked like a trace target, so a validation failure here means the
    // trace-target portion is bad — e.g. `org/project/<span-id>` (missing
    // the trace ID) or `org/project/<bad-trace>/<span-id>`. Surface a
    // trace-focused ContextError that preserves the underlying detail
    // rather than falling through to the misleading "missing span ID" path.
    const suggestion = HEX_ID_RE.test(tracePrefix.split("/").pop() || "")
      ? `Provide the correct trace ID: sentry span view ${tracePrefix} ${possibleSpanId}`
      : `Provide the trace ID: sentry span view ${tracePrefix}/<trace-id> ${possibleSpanId}`;
    throw new ContextError("Trace ID", USAGE_HINT, [
      `'${arg}' is missing a valid trace ID before the span ID '${possibleSpanId}'`,
      suggestion,
    ]);
  }
  log.warn(
    `Interpreting '${arg}' as <trace-target>/<span-id>. ` +
      `Use separate arguments: sentry span view ${tracePrefix} ${possibleSpanId}`
  );
  return { kind: "resolved", traceTarget, rawSpanIds: [possibleSpanId] };
}

export function parsePositionalArgs(args: string[]): SpanViewArgs {
  if (args.length === 0) {
    throw new ContextError("Trace ID and span ID", USAGE_HINT, []);
  }

  const first = args[0];
  if (first === undefined) {
    throw new ContextError("Trace ID and span ID", USAGE_HINT, []);
  }

  // Auto-detect single-arg forms where the last slash-segment is a span ID.
  // This handles:
  //   <trace-id>/<span-id>                       (one slash)
  //   [<org>/][<project>/]<trace-id>/<span-id>   (two+ slashes, e.g. copy-paste from `span list`)
  // Without this check, parseSlashSeparatedTraceTarget treats the span
  // ID as a trace ID and fails validation (CLI-G6 / CLI-1BD).
  if (args.length === 1) {
    const resolved = tryAutoSplitSpanArg(first);
    if (resolved) {
      return resolved;
    }
  }

  // Single bare arg that looks like a span ID (16-char hex, no slashes):
  // the user forgot the trace ID. Give a targeted ContextError instead
  // of the confusing "Invalid trace ID" from validateTraceId() (CLI-SC).
  if (args.length === 1 && !first.includes("/")) {
    const normalized = first.trim().toLowerCase().replace(/-/g, "");
    if (SPAN_ID_RE.test(normalized)) {
      throw new ContextError("Trace ID and span ID", USAGE_HINT, [
        `'${first}' looks like a span ID (16 characters), not a trace ID`,
        `Provide the trace ID first: sentry span view <trace-id> ${normalized}`,
        `Use 'sentry trace list' to find trace IDs`,
      ]);
    }
  }

  const rawSpanIds = args.slice(1);
  if (rawSpanIds.length === 0) {
    throw new ContextError("Span ID", USAGE_HINT, [
      `Use 'sentry span list ${first}' to find span IDs within this trace`,
    ]);
  }

  return { kind: "deferred", rawTraceArg: first, rawSpanIds };
}

/**
 * Validate a raw span ID, attempting {@link recoverHexId} on
 * {@link ValidationError}. Requires trace-scoped context because span IDs
 * are only unique within a trace.
 */
async function validateAndRecoverSpanId(
  rawSpanId: string,
  ctx: { org: string; project: string; traceId: string }
): Promise<string> {
  try {
    return validateSpanId(rawSpanId);
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
      `${missing.length} of ${spanIds.length} span(s) not found in trace:\n${formatIdList(missing)}`
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
  details?: Map<string, TraceItemDetail>
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
      formatSpanDetails(result.span, result.ancestors, data.traceId, detail)
    );

    // Show child tree if --spans > 0 and the span has children
    const children = result.span.children ?? [];
    if (data.spansDepth > 0 && children.length > 0) {
      const treeLines = formatSimpleSpanTree(
        data.traceId,
        [result.span],
        data.spansDepth
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
      "Target specification:\n" +
      "  sentry span view <trace-id> <span-id>                        # auto-detect\n" +
      "  sentry span view <org>/<project>/<trace-id> <span-id>        # explicit\n\n" +
      "The first argument is the trace ID (optionally prefixed with org/project),\n" +
      "followed by one or more span IDs.\n\n" +
      "Examples:\n" +
      "  sentry span view <trace-id> a1b2c3d4e5f67890\n" +
      "  sentry span view <trace-id> a1b2c3d4e5f67890 b2c3d4e5f6789012\n" +
      "  sentry span view sentry/my-project/<trace-id> a1b2c3d4e5f67890",
  },
  output: {
    human: formatSpanViewHuman,
    jsonTransform: jsonTransformSpanView,
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        placeholder: "trace-id/span-id",
        brief:
          "[<org>/<project>/]<trace-id> <span-id> [<span-id>...] - Trace ID and one or more span IDs",
        parse: String,
      },
    },
    flags: {
      ...spansFlag,
      fresh: FRESH_FLAG,
    },
    aliases: { ...FRESH_ALIASES },
  },
  async *func(this: SentryContext, flags: ViewFlags, ...args: string[]) {
    applyFreshFlag(flags);
    const { cwd } = this;

    // Parse positional args. Either we get a resolved trace target (single-arg
    // <trace>/<span> slash form) or a deferred trace arg that routes through
    // `parseTraceTargetWithRecovery` for async trace-ID recovery — same
    // contract as `trace view`.
    const parsed = parsePositionalArgs(args);
    const rawSpanIds = parsed.rawSpanIds;
    const traceTarget =
      parsed.kind === "resolved"
        ? parsed.traceTarget
        : await parseTraceTargetWithRecovery([parsed.rawTraceArg], USAGE_HINT);
    warnIfNormalized(traceTarget, "span.view");

    // Resolve org/project
    const { traceId, org, project } = await resolveTraceOrgProject(
      traceTarget,
      cwd,
      USAGE_HINT
    );

    // Validate + recover span IDs now that trace context is available.
    // Span IDs are unique only within a trace, so recovery scopes its
    // fuzzy lookup via `ctx.traceId`.
    const spanIds = await Promise.all(
      rawSpanIds.map((raw) =>
        validateAndRecoverSpanId(raw, { org, project, traceId })
      )
    );
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
          USAGE_HINT
        );
      }
      const idList = formatIdList(spanIds);
      throw new ResolutionError(
        `Spans in trace ${traceId}`,
        "none of the requested IDs were found",
        USAGE_HINT,
        [`Requested IDs:\n${idList}`]
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
      { org, fallbackProject: project, traceId }
    );

    yield new CommandOutput({
      results,
      traceId,
      spansDepth: flags.spans,
      details,
    });
  },
});
