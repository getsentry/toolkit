/**
 * Shared pieces of `sentry log list` and `sentry log tail`: the
 * project-or-trace positional, the log output types, and their human and
 * JSON renderers.
 */

import type { SentryContext } from "../../context.js";
import { sentry } from "../../lib/app-identity.js";
import {
  type ParsedOrgProject,
  parseOrgProjectInput,
} from "../../lib/arg-parsing.js";
import { ORG_PROJECT_TARGET } from "../../lib/completion-target.js";
import {
  type LogLike as BaseLogLike,
  buildLogRowCells,
  createLogStreamingTable,
  formatLogRow,
  formatLogsHeader,
  isPlainOutput,
} from "../../lib/formatters/index.js";
import { filterFields } from "../../lib/formatters/json.js";
import { renderInlineMarkdown } from "../../lib/formatters/markdown.js";
import {
  formatFooter,
  type HumanRenderer,
} from "../../lib/formatters/output.js";
import type { StreamingTable } from "../../lib/formatters/text-table.js";
import type { ListEnvelope } from "../../lib/org-list.js";
import {
  type BoundArguments,
  boundArguments,
} from "../../lib/positional-parse.js";
import { resolveProjectBoundTarget } from "../../lib/resolve-target.js";
import { applySentryUrlContext } from "../../lib/sentry-url-parser.js";
import {
  applyTraceTargetInput,
  parseDualModeInput,
  resolveTraceOrg,
  type TraceTargetInput,
  warnIfNormalized,
} from "../../lib/trace-target.js";

/**
 * Extends the base {@link BaseLogLike} from formatters with the
 * `timestamp_precise` field needed for `log tail` dedup tracking.
 */
export type LogLike = BaseLogLike & {
  /** Nanosecond-precision timestamp used for dedup in `log tail`.
   * Optional because TraceLog may omit it when the API response doesn't include it. */
  timestamp_precise?: number | undefined;
};

/**
 * A batch of logs: everything `log list` yields, and the first batch of
 * `log tail` when the renderer needs its context. `log tail` yields bare
 * {@link LogLike} items after that, see {@link LogOutput}.
 */
export type LogListResult = {
  logs: LogLike[];
  /** Trace ID, present for trace-filtered queries */
  traceId?: string;
  /** Whether more results are available beyond the limit */
  hasMore: boolean;
  /** Extra field names requested via `--fields`, used to render additional columns in human mode. */
  extraFields?: string[] | undefined;
};

/** Output of a log command: a batch, or an individual item (`log tail`). */
export type LogOutput = LogLike | LogListResult;

/** Usage hint for trace mode error messages */
const traceUsageHint = (commandName: string) =>
  sentry`${commandName} [<org>/[<project>/]]<trace-id>`;

/** What a log command reads, as parsed: a project's logs or a trace's. */
type LogListInput =
  | {
      readonly mode: "project";
      readonly target: ParsedOrgProject;
      /** Server of a pasted Sentry URL, for `applySentryUrlContext` */
      readonly baseUrl?: string | undefined;
    }
  | { readonly mode: "trace"; readonly trace: TraceTargetInput };

/** What a log command reads, resolved. */
type LogListTarget =
  | { readonly mode: "project"; readonly org: string; readonly project: string }
  | {
      readonly mode: "trace";
      readonly org: string;
      readonly traceId: string;
      /** Project the user named, to filter the trace's logs by */
      readonly projectFilter?: string | undefined;
    };

/** The arguments of `log list` and `log tail`. */
export type LogListArguments = BoundArguments<LogListInput, LogListTarget>;

/** The log commands that take a project-or-trace target. */
type LogCommandName = "log list" | "log tail";

/**
 * Disambiguate log list and log tail positional arguments with {@link parseDualModeInput}
 * (trace mode when the arguments end in a trace ID).
 */
function parseLogListInput(
  args: readonly string[],
  commandName: LogCommandName,
): LogListInput {
  const input = parseDualModeInput(args, traceUsageHint(commandName));
  if (input.mode === "trace") {
    return input;
  }
  const { parsed, baseUrl } = parseOrgProjectInput(input.target);
  return { mode: "project", target: parsed, baseUrl };
}

/** Resolve a parsed log target to an org and a project or trace. */
async function resolveLogListTarget(
  input: LogListInput,
  context: SentryContext,
  commandName: LogCommandName,
): Promise<LogListTarget> {
  if (input.mode === "trace") {
    const parsed = applyTraceTargetInput(input.trace);
    warnIfNormalized(parsed, commandName.replace(" ", "."));
    const { traceId, org } = await resolveTraceOrg(
      parsed,
      context.cwd,
      commandName,
      traceUsageHint(commandName),
    );
    return {
      mode: "trace",
      org,
      traceId,
      projectFilter: parsed.type === "explicit" ? parsed.project : undefined,
    };
  }
  if (input.baseUrl) {
    applySentryUrlContext(input.baseUrl);
  }
  const { org, project } = await resolveProjectBoundTarget(
    input.target,
    context.cwd,
    commandName,
  );
  return { mode: "project", org, project };
}

/**
 * The positional of `log list` and `log tail`: a project, or a trace ID with
 * an optional `<org>/[<project>/]` prefix.
 */
export function logTargetArguments(commandName: LogCommandName) {
  return boundArguments({
    placeholder: "org/project-or-trace-id",
    brief: "[<org>/[<project>/]]<trace-id>, <org>/<project>, or <project>",
    kind: ORG_PROJECT_TARGET,
    parse: (args: readonly string[]) => parseLogListInput(args, commandName),
    resolve: (input: LogListInput, context: SentryContext) =>
      resolveLogListTarget(input, context, commandName),
  });
}

/**
 * Render a batch of log rows as a human-readable string.
 *
 * When a StreamingTable is provided (TTY mode), renders rows through the
 * bordered table. Otherwise falls back to plain markdown rows.
 *
 * @param logs - Log entries to render
 * @param includeTrace - Whether to append trace-ID suffix to messages
 * @param table - Optional streaming table for TTY mode
 * @param extraFields - Additional field names to render as extra columns
 */
function renderLogRows(
  logs: LogLike[],
  includeTrace: boolean,
  table?: StreamingTable,
  extraFields?: string[],
): string {
  let text = "";
  for (const log of logs) {
    if (table) {
      text += table.row(
        buildLogRowCells(log, true, includeTrace, extraFields).map(
          renderInlineMarkdown,
        ),
      );
    } else {
      text += formatLogRow(log, includeTrace, extraFields);
    }
  }
  return text;
}

/** Shared discriminator for log output type. */
function isLogListResult(data: LogOutput): data is LogListResult {
  return "logs" in data && Array.isArray((data as LogListResult).logs);
}

/** Mutable state for the log renderer, extracted to reduce cognitive complexity. */
type LogRendererState = {
  table: StreamingTable | undefined;
  includeTrace: boolean;
  headerEmitted: boolean;
  extraFields: string[] | undefined;
};

/** Initialize table and column settings on the first non-empty render. */
function initFirstRender(
  state: LogRendererState,
  data: LogOutput,
  plain: boolean,
): void {
  if (isLogListResult(data)) {
    if (data.traceId) {
      state.includeTrace = false;
    }
    state.extraFields = data.extraFields;
  }
  state.table = plain
    ? undefined
    : createLogStreamingTable({}, state.extraFields);
  state.headerEmitted = true;
}

/**
 * Create a stateful human renderer for log list and log tail output.
 *
 * The factory is called once per command invocation. The returned renderer
 * tracks streaming table state (header emitted, table instance) and cleans
 * up via `finalize()`.
 *
 * All yields go through `render()` — from both commands.
 * The renderer emits the table header on the first non-empty batch, rows
 * per batch, and the table footer + hint via `finalize()`.
 *
 * Discriminates between {@link LogListResult} (`log list`, or the first
 * `log tail` batch) and bare {@link LogLike} items (`log tail`).
 */
export function createLogRenderer(): HumanRenderer<LogOutput> {
  const plain = isPlainOutput();
  const state: LogRendererState = {
    table: undefined,
    includeTrace: true,
    headerEmitted: false,
    extraFields: undefined,
  };

  return {
    render(data: LogOutput): string {
      const logs: LogLike[] = isLogListResult(data) ? data.logs : [data];
      if (logs.length === 0) {
        return "";
      }

      if (!state.headerEmitted) {
        initFirstRender(state, data, plain);
        let text = state.table
          ? state.table.header()
          : formatLogsHeader(state.extraFields);
        text += renderLogRows(
          logs,
          state.includeTrace,
          state.table,
          state.extraFields,
        );
        return text.trimEnd();
      }

      return renderLogRows(
        logs,
        state.includeTrace,
        state.table,
        state.extraFields,
      ).trimEnd();
    },

    finalize(hint?: string): string {
      let text = "";

      if (state.headerEmitted && state.table) {
        text += state.table.footer();
      }

      if (hint) {
        if (state.headerEmitted) {
          text += `${text ? "\n" : ""}${formatFooter(hint)}`;
        } else {
          text += `${hint}\n`;
        }
      }

      return text;
    },
  };
}

/**
 * Transform log output into the JSON shape.
 *
 * Discriminates between {@link LogListResult} (single-fetch) and bare
 * {@link LogLike} items (follow mode). Single-fetch yields a JSON envelope
 * with `data` and `hasMore`; follow mode yields one JSON object per line (JSONL).
 */
export function jsonTransformLogOutput(
  data: LogOutput,
  fields?: string[],
): ListEnvelope<LogLike> | Partial<LogLike> {
  if (isLogListResult(data)) {
    // Batch (single-fetch): return envelope with data + hasMore
    const logList = data;
    const items =
      fields && fields.length > 0
        ? logList.logs.map((log) => filterFields(log, fields))
        : logList.logs;
    return { data: items, hasMore: logList.hasMore };
  }
  // Single item (follow mode): return bare object for JSONL
  return fields && fields.length > 0 ? filterFields(data, fields) : data;
}
