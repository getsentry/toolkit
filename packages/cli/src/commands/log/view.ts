/**
 * sentry log view
 *
 * View detailed information about one or more Sentry log entries.
 */

import { isatty } from "node:tty";

import pLimit from "p-limit";

import type { SentryContext } from "../../context.js";
import { getLogItemDetail, getLogs } from "../../lib/api-client.js";
import {
  looksLikeIssueShortId,
  type OrgProjectInput,
  type ParsedOrgProject,
  parseOrgProjectInput,
} from "../../lib/arg-parsing.js";
import { openInBrowser } from "../../lib/browser.js";
import { buildCommand } from "../../lib/command.js";
import { ORG_PROJECT_TARGET } from "../../lib/completion-target.js";
import {
  ContextError,
  ResolutionError,
  ValidationError,
} from "../../lib/errors.js";
import { formatLogDetails } from "../../lib/formatters/index.js";
import { filterFields } from "../../lib/formatters/json.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { ageInDaysFromUuidV7 } from "../../lib/hex-id.js";
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
import { prompt } from "../../lib/prompt.js";
import {
  type BoundArguments,
  boundArguments,
} from "../../lib/positional-parse.js";
import {
  resolveLogProjectId,
  resolveOrgAndProject,
  resolveProjectBoundSlug,
} from "../../lib/resolve-target.js";
import { RETENTION_DAYS } from "../../lib/retention.js";
import { applySentryUrlContext } from "../../lib/sentry-url-parser.js";
import { buildLogsUrl } from "../../lib/sentry-web-urls.js";
import { setOrgProjectContext } from "../../lib/telemetry.js";
import { isAllDigits } from "../../lib/utils.js";
import type { DetailedSentryLog, TraceItemDetail } from "../../types/index.js";

const log = logger.withTag("log-view");

/** Matches SPAN_DETAIL_CONCURRENCY in traces.ts */
const LOG_DETAIL_CONCURRENCY = 15;

type ViewFlags = {
  readonly json: boolean;
  readonly web: boolean;
  readonly fresh: boolean;
  readonly fields?: string[];
};

/** Usage hint for ContextError messages */
const USAGE_HINT = "sentry log view <org>/<project> <log-id> [<log-id>...]";

/**
 * Parse positional arguments for log view.
 *
 * Log IDs take the forms every ID-taking command does (see
 * `id-arguments.ts`): `<log-id>`, `<project>/<log-id>`,
 * `<org>/<project>/<log-id>`, `<target> <log-id>`, reversed, and more log
 * IDs after any of those, each maybe repeating the target. An argument may
 * hold several lines, one log ID each.
 *
 * Returns **raw** log IDs without validating them — validation
 * is deferred to the main command so {@link recoverHexId} can use the
 * resolved org/project context for fuzzy prefix lookups.
 *
 * @param args - Positional arguments from CLI
 * @returns Parsed raw log IDs, optional target arg, and warnings
 * @throws {ContextError} If no log ID is given
 * @throws {ValidationError} If the log IDs name different projects
 */
export function parsePositionalArgs(args: readonly string[]): {
  rawLogIds: string[];
  targetArg: string | undefined;
  /** Warnings to log, such as for reversed arguments */
  warnings: readonly string[];
  /** Suggestion when first arg looks like an issue short ID */
  suggestion?: string;
} {
  const { target, ids, warnings } = parseIdArguments(args, ID_KINDS.log, {
    usageHint: USAGE_HINT,
    multiple: true,
    needsProject: true,
    validate: false,
  });
  const [first] = args;
  return {
    rawLogIds: [...ids],
    targetArg: target,
    warnings,
    ...(args.length > 1 &&
      first &&
      looksLikeIssueShortId(first) && {
        suggestion: `Did you mean: sentry issue view ${first}`,
      }),
  };
}

/**
 * Validate and attempt to recover one log ID against the resolved target.
 *
 * For each raw ID: run `ID_KINDS.log.validate`; on {@link ValidationError},
 * attempt {@link recoverHexId} with the resolved org/project. Successful
 * recovery returns a valid hex ID (and emits a `log.warn`).
 */
async function validateAndRecoverLogId(
  rawId: string,
  target: ResolvedLogTarget,
): Promise<string> {
  try {
    return ID_KINDS.log.validate(rawId);
  } catch (err) {
    if (!(err instanceof ValidationError)) {
      throw err;
    }
    const result = await recoverHexId(rawId, "log", {
      org: target.org,
      project: target.project,
    });
    return handleRecoveryResult(result, err, {
      entityType: "log",
      canonicalCommand: `sentry log view ${target.org}/${target.project}/<id>`,
      logTag: "log.view",
    });
  }
}

/**
 * Resolved target type for log commands.
 * @internal Exported for testing
 */
export type ResolvedLogTarget = {
  org: string;
  project: string;
  detectedFrom?: string;
};

/**
 * Resolve the target org/project from the parsed arg.
 *
 * @param parsed - The parsed target argument
 * @param rawLogIds - Raw log IDs (used for usage hints; not yet validated)
 * @param cwd - Current working directory
 * @returns Resolved target, or null if resolution produced nothing
 * @throws {ContextError} If org-all mode is used (requires specific project)
 */
async function resolveTarget(
  parsed: ParsedOrgProject,
  rawLogIds: string[],
  cwd: string,
): Promise<ResolvedLogTarget | null> {
  switch (parsed.type) {
    case "explicit":
      setOrgProjectContext([parsed.org], [parsed.project]);
      return { org: parsed.org, project: parsed.project };

    case "project-search": {
      const result = await resolveProjectBoundSlug(
        parsed.projectSlug,
        USAGE_HINT,
        `sentry log view <org>/${parsed.projectSlug} ${rawLogIds.join(" ")}`,
        parsed.originalSlug,
      );
      if (
        isAllDigits(parsed.projectSlug) &&
        result.project !== parsed.projectSlug
      ) {
        log.info(
          `Tip: Resolved project ID ${parsed.projectSlug} to ${result.org}/${result.project}. ` +
            "Use the slug form for faster lookups.",
        );
      }
      return result;
    }

    case "org-all":
      throw new ContextError("Specific project", USAGE_HINT, []);

    case "auto-detect":
      return await resolveOrgAndProject({ cwd, usageHint: USAGE_HINT });

    default: {
      const _exhaustiveCheck: never = parsed;
      throw new ValidationError(
        `Invalid target specification: ${_exhaustiveCheck}`,
      );
    }
  }
}

/** The arguments of `log view`: the log IDs as typed, and the target. */
type LogViewInput = ReturnType<typeof parsePositionalArgs> & {
  readonly target: OrgProjectInput;
};

/** The target of `log view`, and its log IDs, validated or recovered. */
type ResolvedLogs = ResolvedLogTarget & { readonly logIds: string[] };

/** The arguments of `log view`. */
type LogViewArguments = BoundArguments<LogViewInput, ResolvedLogs>;

/** Parse `log view` arguments, without side effects. */
function parseLogViewInput(args: readonly string[]): LogViewInput {
  const input = parsePositionalArgs(args);
  return { ...input, target: parseOrgProjectInput(input.targetArg) };
}

/**
 * Resolve `log view` arguments: find the org and project, then validate
 * (or recover) the log IDs in that project.
 */
async function resolveLogViewInput(
  input: LogViewInput,
  context: SentryContext,
): Promise<ResolvedLogs> {
  if (input.target.baseUrl) {
    applySentryUrlContext(input.target.baseUrl);
  }
  const cmdLog = logger.withTag("log.view");
  for (const warning of input.warnings) {
    cmdLog.warn(warning);
  }
  if (input.suggestion) {
    cmdLog.warn(input.suggestion);
  }
  const target = await resolveTarget(
    input.target.parsed,
    input.rawLogIds,
    context.cwd,
  );
  if (!target) {
    throw new ContextError("Organization and project", USAGE_HINT);
  }
  // `log.warn` preserves emission order regardless of await order, and a
  // throwing recovery (multi-match ResolutionError) exits via
  // `Promise.all` with the first-thrown error.
  const logIds = await Promise.all(
    input.rawLogIds.map((raw) => validateAndRecoverLogId(raw, target)),
  );
  return { ...target, logIds };
}

/**
 * Format a list of log IDs as a markdown bullet list.
 *
 * @param ids - Log IDs to format
 * @returns Markdown list string with each ID on its own line
 */
function formatIdList(ids: string[]): string {
  return ids.map((id) => ` - \`${id}\``).join("\n");
}

/**
 * Warn about IDs that weren't found in the API response.
 * Uses the logger for structured output to stderr.
 *
 * @param logIds - All requested IDs
 * @param logs - Logs actually returned by the API
 */
function warnMissingIds(logIds: string[], logs: DetailedSentryLog[]): void {
  if (logs.length >= logIds.length) {
    return;
  }
  const foundIds = new Set(logs.map((l) => l["sentry.item_id"]));
  const missing = logIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    log.warn(
      `${missing.length} of ${logIds.length} log(s) not found:\n${formatIdList(missing)}`,
    );
  }
}

/**
 * Handle --web flag: open log URLs in the browser.
 * Prompts for confirmation in interactive mode when multiple IDs are given.
 * Aborts in non-interactive mode with a warning.
 *
 * @param orgSlug - Organization slug for URL building
 * @param logIds - Log IDs to open
 */
async function handleWebOpen(orgSlug: string, logIds: string[]): Promise<void> {
  if (logIds.length > 1) {
    if (!isatty(0)) {
      log.warn(
        `Refusing to open ${logIds.length} browser tabs in non-interactive mode. ` +
          "Pass a single log ID or run interactively.",
      );
      return;
    }
    const confirmed = await prompt(`Open ${logIds.length} browser tabs?`, {
      type: "confirm",
      initial: false,
    });
    // The prompt returns Symbol(clack:cancel) on Ctrl+C — a truthy value.
    // Strictly check for `true` to avoid opening tabs on cancel.
    if (confirmed !== true) {
      return;
    }
  }
  for (const id of logIds) {
    await openInBrowser(buildLogsUrl(orgSlug, id), "log");
  }
}

/**
 * Build a retention-aware message for logs the API couldn't find.
 *
 * When a log ID is UUIDv7 (as Sentry emits) and its embedded timestamp is
 * older than the hard retention cap, we can state with certainty that
 * it's past retention rather than hedging with "may have been deleted".
 *
 * Returns a per-ID annotation like " (created 2025-12-15, past 90-day
 * retention)" when applicable, else an empty string.
 */
function retentionSuffix(logId: string): string {
  const retention = RETENTION_DAYS.log;
  if (retention === null) {
    return "";
  }
  const age = ageInDaysFromUuidV7(logId);
  if (age === null || age <= retention) {
    return "";
  }
  const days = Math.floor(age);
  return ` (created ${days} days ago, past the ${retention}-day log retention)`;
}

/**
 * Throw a descriptive error when no logs were found.
 *
 * @param logIds - Requested IDs
 * @param org - Organization slug
 * @param project - Project slug
 * @throws {ResolutionError} Always
 */
function throwNotFoundError(
  logIds: string[],
  org: string,
  project: string,
): never {
  // Generic fallback wording references `RETENTION_DAYS.log` so a single
  // edit in `retention.ts` keeps this message in sync with the
  // deterministic retention-aware path.
  const retentionDays = RETENTION_DAYS.log;

  if (logIds.length === 1) {
    const id = logIds[0] ?? "";
    const suffix = retentionSuffix(id);
    let suggestions: string[];
    if (suffix) {
      suggestions = [`This log is no longer retrievable.${suffix}`];
    } else if (retentionDays) {
      suggestions = [
        `Make sure the log ID is correct and was sent within the last ${retentionDays} days`,
      ];
    } else {
      suggestions = ["Make sure the log ID is correct"];
    }
    throw new ResolutionError(
      `Log '${id}'`,
      `not found in ${org}/${project}`,
      `sentry log view ${org}/${project}/${id}`,
      suggestions,
    );
  }

  // Multiple IDs — compute the retention suffix once per ID so both the
  // ID list and the "any expired?" check reuse the same decode.
  const suffixed = logIds.map((id) => ({ id, suffix: retentionSuffix(id) }));
  const anyExpired = suffixed.some(({ suffix }) => suffix !== "");
  const idList = suffixed.map(({ id, suffix }) => `${id}${suffix}`);
  let hint: string;
  if (anyExpired) {
    hint =
      "Expired log IDs are no longer retrievable — check non-expired IDs and re-run";
  } else if (retentionDays) {
    hint = `Make sure the log IDs are correct and were sent within the last ${retentionDays} days`;
  } else {
    hint = "Make sure the log IDs are correct";
  }
  throw new ResolutionError(
    `${idList.length} log(s)`,
    `not found in ${org}/${project}`,
    hint,
    idList.map((id) => `ID: ${id}`),
  );
}

/**
 * Data returned by the log view command.
 * Used by both JSON and human output paths.
 */
type LogViewData = {
  /** Retrieved log entries */
  logs: DetailedSentryLog[];
  /** Org slug — needed by human formatter for trace URLs, also useful context in JSON */
  orgSlug: string;
  /** Full attribute sets from the trace-items detail endpoint (index matches logs) */
  details?: (TraceItemDetail | undefined)[];
  /** --fields filter: limits which custom attributes are shown in human output */
  extraFields?: string[];
};

/**
 * Format log view data as human-readable output.
 *
 * Each log entry is formatted with full details. Multiple entries
 * are separated by horizontal rules.
 *
 * @param data - Log view data with entries and org slug
 * @returns Formatted string for terminal output
 */
function formatLogViewHuman(data: LogViewData): string {
  const parts: string[] = [];
  for (let i = 0; i < data.logs.length; i++) {
    if (parts.length > 0) {
      parts.push("\n---\n");
    }
    parts.push(
      formatLogDetails(
        // oxlint-disable-next-line typescript/no-non-null-assertion -- index is bounded by data.logs.length
        data.logs[i]!,
        data.orgSlug,
        data.details?.[i]?.attributes,
        data.extraFields,
      ),
    );
  }
  return parts.join("\n");
}

export const viewCommand = buildCommand({
  docs: {
    brief: "View details of one or more log entries",
    fullDescription:
      "View detailed information about Sentry log entries by their IDs.\n\n" +
      "Multiple log IDs can be passed as separate arguments or newline-separated\n" +
      "within a single argument (handy when piping from other commands).\n\n" +
      "The log ID is the 32-character hexadecimal identifier shown in log listings.",
    examples: [
      {
        description: "View a log entry",
        command: "sentry log view 968c763c740cfda8b6728f27fb9e9b01",
      },
      {
        description: "Specify the project explicitly",
        command:
          "sentry log view my-org/backend 968c763c740cfda8b6728f27fb9e9b01",
      },
      {
        description: "Open in the browser",
        command: "sentry log view 968c763c740cfda8b6728f27fb9e9b01 -w",
      },
      {
        description: "Find a project across organizations",
        command: "sentry log view backend 968c763c740cfda8b6728f27fb9e9b01",
      },
    ],
  },
  output: {
    human: formatLogViewHuman,
    // Preserve original JSON contract: bare array of log entries.
    // orgSlug exists only for the human formatter (trace URLs).
    jsonTransform: (data: LogViewData, fields) =>
      fields && fields.length > 0
        ? data.logs.map((entry) => filterFields(entry, fields))
        : data.logs,
  },
  parameters: {
    positional: boundArguments({
      placeholder: "org/project/log-id",
      brief:
        "[<org>/<project>] <log-id> [<log-id>...] - Target (optional) and one or more log IDs",
      kind: ORG_PROJECT_TARGET,
      parse: parseLogViewInput,
      resolve: resolveLogViewInput,
    }),
    flags: {
      web: {
        kind: "boolean",
        brief: "Open in browser",
        default: false,
      },
      fresh: FRESH_FLAG,
    },
    aliases: { ...FRESH_ALIASES, w: "web" },
  },
  async *func(this: SentryContext, flags: ViewFlags, args: LogViewArguments) {
    applyFreshFlag(flags);
    const cmdLog = logger.withTag("log.view");
    const { logIds, ...target } = await args.resolved;

    if (flags.web) {
      await handleWebOpen(target.org, logIds);
      return;
    }

    // Resolve the project slug to its numeric ID so the Events request scopes
    // via the `project` param. The `project:<slug>` filter only matches
    // actively-selected projects and can otherwise return no logs (#1317).
    const projectId = await resolveLogProjectId(target.org, target.project);

    // Fetch all requested log entries
    const logs = await getLogs(target.org, target.project, logIds, {
      extraFields: flags.fields,
      projectId,
    });

    if (logs.length === 0) {
      throwNotFoundError(logIds, target.org, target.project);
    }

    warnMissingIds(logIds, logs);

    // Skip detail fetching in JSON mode — jsonTransform only uses data.logs,
    // not data.details, so the extra round-trips would be wasted.
    // Mirrors the shouldFetchDetails pattern in trace/view.ts.
    const detailLimit = pLimit(LOG_DETAIL_CONCURRENCY);
    const details = flags.json
      ? undefined
      : await detailLimit.map(logs, async (entry) => {
          if (!entry.trace) {
            return;
          }
          try {
            return await getLogItemDetail(
              target.org,
              target.project,
              entry["sentry.item_id"],
              entry.trace,
            );
          } catch (error) {
            cmdLog.debug("Failed to fetch log item detail", error);
            return;
          }
        });

    const hint = target.detectedFrom
      ? `Detected from ${target.detectedFrom}`
      : undefined;

    yield new CommandOutput({
      logs,
      orgSlug: target.org,
      details,
      extraFields: flags.fields,
    });
    return { hint };
  },
});
