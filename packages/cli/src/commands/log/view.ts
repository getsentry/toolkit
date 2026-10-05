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
  detectSwappedViewArgs,
  looksLikeIssueShortId,
  parseOrgProjectArg,
  parseSlashSeparatedArg,
  splitNewlineArg,
} from "../../lib/arg-parsing.js";
import { openInBrowser } from "../../lib/browser.js";
import { buildCommand } from "../../lib/command.js";
import {
  ContextError,
  ResolutionError,
  ValidationError,
} from "../../lib/errors.js";
import { formatLogDetails } from "../../lib/formatters/index.js";
import { filterFields } from "../../lib/formatters/json.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  ageInDaysFromUuidV7,
  HEX_ID_RE,
  normalizeHexId,
  validateHexId,
} from "../../lib/hex-id.js";
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
  resolveLogProjectId,
  resolveOrgAndProject,
  resolveProjectBoundSlug,
} from "../../lib/resolve-target.js";
import { RETENTION_DAYS } from "../../lib/retention.js";
import { buildLogsUrl } from "../../lib/sentry-urls.js";
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
 * Resolve a single-slash positional arg (`before/after`) as `org/log-id`, or
 * return `null` when `after` is not a valid 32-char hex log ID and should fall
 * through to `parseSlashSeparatedArg`.
 *
 * This guard must run before `parseSlashSeparatedArg` because that function
 * throws `ContextError` for any single-slash arg, treating it as `org/project`
 * with a missing log ID (CLI-1AK).
 */
function parseSingleSlashLogArg(
  beforeSlash: string,
  afterSlash: string
): { rawLogIds: string[]; targetArg: string | undefined } | null {
  // "org/LOG-ID" or "project/LOG-ID" → treat beforeSlash as target, afterSlash as log ID.
  if (afterSlash && HEX_ID_RE.test(normalizeHexId(afterSlash))) {
    return {
      rawLogIds: [normalizeHexId(afterSlash)],
      targetArg: beforeSlash || undefined,
    };
  }
  return null;
}

/**
 * Parse positional arguments for log view.
 * Handles:
 * - `<log-id>` — single log ID (auto-detect org/project)
 * - `<target> <log-id> [<log-id>...]` — explicit target + one or more log IDs
 * - `<org>/<project>/<log-id>` — single slash-separated arg
 *
 * When two or more args are provided, the first is always treated as the
 * target (org/project specifier) and the rest as log IDs.
 *
 * Arguments containing newlines are split into multiple IDs.
 *
 * Returns **raw** log IDs without running {@link validateHexId} — validation
 * is deferred to the main command so {@link recoverHexId} can use the
 * resolved org/project context for fuzzy prefix lookups.
 *
 * @param args - Positional arguments from CLI
 * @returns Parsed raw log IDs and optional target arg
 * @throws {ContextError} If no arguments provided
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: positional arg parsing has many format branches by design
export function parsePositionalArgs(args: string[]): {
  rawLogIds: string[];
  targetArg: string | undefined;
  /** Suggestion when first arg looks like an issue short ID */
  suggestion?: string;
} {
  if (args.length === 0) {
    throw new ContextError("Log ID", USAGE_HINT, []);
  }

  const first = args[0];
  if (first === undefined) {
    throw new ContextError("Log ID", USAGE_HINT, []);
  }

  if (args.length === 1) {
    // Single arg — could be slash-separated org/project/logId, org/logId, or a plain ID
    // (possibly containing newlines).
    // Guard: detect exactly-one-slash args before parseSlashSeparatedArg, which
    // throws ContextError for "org/logId" thinking it's "org/project" with no ID.
    const trimmedFirst = first.trim();
    const slashIdx = trimmedFirst.indexOf("/");
    if (slashIdx !== -1 && trimmedFirst.indexOf("/", slashIdx + 1) === -1) {
      const singleSlash = parseSingleSlashLogArg(
        trimmedFirst.slice(0, slashIdx),
        trimmedFirst.slice(slashIdx + 1)
      );
      if (singleSlash) {
        if (singleSlash.rawLogIds.length === 0) {
          throw new ContextError("Log ID", USAGE_HINT, []);
        }
        return singleSlash;
      }
    }

    const { id, targetArg } = parseSlashSeparatedArg(
      first,
      "Log ID",
      USAGE_HINT
    );
    const rawLogIds = splitNewlineArg(id);
    if (rawLogIds.length === 0) {
      throw new ContextError("Log ID", USAGE_HINT, []);
    }
    return { rawLogIds, targetArg };
  }

  // Two or more args — first is target, rest are log IDs.
  // Each arg may contain newlines (split them).

  // Check issue short ID first — it takes precedence over swap detection
  // because `detectSwappedViewArgs` also fires for `CAM-82X my-org/project`
  // (first has no "/", second has "/"), but the user's intent is clearly
  // to view an issue, not to swap log-view arguments.
  if (looksLikeIssueShortId(first)) {
    const rawLogIds = args.slice(1).flatMap(splitNewlineArg);
    if (rawLogIds.length === 0) {
      throw new ContextError("Log ID", USAGE_HINT, []);
    }
    return {
      rawLogIds,
      targetArg: first,
      suggestion: `Did you mean: sentry issue view ${first}`,
    };
  }

  // biome-ignore lint/style/noNonNullAssertion: length >= 2 guarantees index 1 exists
  const second = args[1]!;

  // Detect swapped args: exactly two args where first has no "/" and second
  // does (e.g., `sentry log view ace106b2 myorg/myproject`). Only fires for
  // the two-arg case to avoid silently dropping extra args in multi-arg use.
  if (args.length === 2) {
    const swapWarning = detectSwappedViewArgs(first, second);
    if (swapWarning) {
      return {
        rawLogIds: splitNewlineArg(first),
        targetArg: second,
        suggestion: swapWarning,
      };
    }
  }

  const rawLogIds = args.slice(1).flatMap(splitNewlineArg);
  if (rawLogIds.length === 0) {
    throw new ContextError("Log ID", USAGE_HINT, []);
  }

  return { rawLogIds, targetArg: first };
}

/**
 * Validate and attempt to recover one log ID against the resolved target.
 *
 * For each raw ID: run {@link validateHexId}; on {@link ValidationError},
 * attempt {@link recoverHexId} with the resolved org/project. Successful
 * recovery returns a valid hex ID (and emits a `log.warn`).
 */
async function validateAndRecoverLogId(
  rawId: string,
  target: ResolvedLogTarget
): Promise<string> {
  try {
    return validateHexId(rawId, "log ID");
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
 * @param parsed - Result of `parseOrgProjectArg`
 * @param rawLogIds - Raw log IDs (used for usage hints; not yet validated)
 * @param cwd - Current working directory
 * @returns Resolved target, or null if resolution produced nothing
 * @throws {ContextError} If org-all mode is used (requires specific project)
 */
async function resolveTarget(
  parsed: ReturnType<typeof parseOrgProjectArg>,
  rawLogIds: string[],
  cwd: string
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
        parsed.originalSlug
      );
      if (
        isAllDigits(parsed.projectSlug) &&
        result.project !== parsed.projectSlug
      ) {
        log.info(
          `Tip: Resolved project ID ${parsed.projectSlug} to ${result.org}/${result.project}. ` +
            "Use the slug form for faster lookups."
        );
      }
      return result;
    }

    case "org-all":
      throw new ContextError("Specific project", USAGE_HINT, []);

    case "auto-detect":
      return resolveOrgAndProject({ cwd, usageHint: USAGE_HINT });

    default: {
      const _exhaustiveCheck: never = parsed;
      throw new ValidationError(
        `Invalid target specification: ${_exhaustiveCheck}`
      );
    }
  }
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
 * Uses the consola logger for structured output to stderr.
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
      `${missing.length} of ${logIds.length} log(s) not found:\n${formatIdList(missing)}`
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
          "Pass a single log ID or run interactively."
      );
      return;
    }
    const confirmed = await log.prompt(`Open ${logIds.length} browser tabs?`, {
      type: "confirm",
      initial: false,
    });
    // consola prompt returns Symbol(clack:cancel) on Ctrl+C — a truthy value.
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
  project: string
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
      suggestions
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
    idList.map((id) => `ID: ${id}`)
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
        // biome-ignore lint/style/noNonNullAssertion: index is bounded by data.logs.length
        data.logs[i]!,
        data.orgSlug,
        data.details?.[i]?.attributes,
        data.extraFields
      )
    );
  }
  return parts.join("\n");
}

export const viewCommand = buildCommand({
  docs: {
    brief: "View details of one or more log entries",
    fullDescription:
      "View detailed information about Sentry log entries by their IDs.\n\n" +
      "Target specification:\n" +
      "  sentry log view <log-id>                          # auto-detect from DSN or config\n" +
      "  sentry log view <org>/<proj> <log-id> [<id>...]   # explicit org and project\n" +
      "  sentry log view <project> <log-id> [<id>...]      # find project across all orgs\n\n" +
      "Multiple log IDs can be passed as separate arguments or newline-separated\n" +
      "within a single argument (handy when piping from other commands).\n\n" +
      "The log ID is the 32-character hexadecimal identifier shown in log listings.",
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
    positional: {
      kind: "array",
      parameter: {
        placeholder: "org/project/log-id",
        brief:
          "[<org>/<project>] <log-id> [<log-id>...] - Target (optional) and one or more log IDs",
        parse: String,
      },
    },
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
  async *func(this: SentryContext, flags: ViewFlags, ...args: string[]) {
    applyFreshFlag(flags);
    const { cwd } = this;
    const cmdLog = logger.withTag("log.view");

    // Parse positional args (raw — validation is deferred to after target
    // resolution so we can run fuzzy recovery with org/project context).
    const { rawLogIds, targetArg, suggestion } = parsePositionalArgs(args);
    if (suggestion) {
      cmdLog.warn(suggestion);
    }
    const parsed = parseOrgProjectArg(targetArg);

    const target = await resolveTarget(parsed, rawLogIds, cwd);

    if (!target) {
      throw new ContextError("Organization and project", USAGE_HINT);
    }

    // Validate + recover each log ID in parallel. `log.warn` preserves
    // emission order regardless of await order, and a throwing recovery
    // (multi-match ResolutionError) exits via `Promise.all` with the
    // first-thrown error — same UX as the old sequential loop.
    const logIds = await Promise.all(
      rawLogIds.map((raw) => validateAndRecoverLogId(raw, target))
    );

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
              entry.trace
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
