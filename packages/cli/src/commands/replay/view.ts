/**
 * sentry replay view
 *
 * View detailed information about a Session Replay.
 */

import type { SentryContext } from "../../context.js";
import {
  getProject,
  getReplayRecordingSegments,
  getTraceMeta,
  listIssuesPaginated,
  resolveReplay,
} from "../../lib/api-client.js";
import {
  detectSwappedViewArgs,
  parseSlashSeparatedArg,
} from "../../lib/arg-parsing.js";
import { openInBrowser } from "../../lib/browser.js";
import { buildCommand } from "../../lib/command.js";
import {
  ApiError,
  ContextError,
  ResolutionError,
  ValidationError,
} from "../../lib/errors.js";
import { filterFields } from "../../lib/formatters/json.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  extractReplayActivityEvents,
  formatReplayDetails,
  type ReplayViewData,
  replayHint,
} from "../../lib/formatters/replay.js";
import { tryNormalizeHexId, validateHexId } from "../../lib/hex-id.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import { resolveOrgOptionalFromArg } from "../../lib/resolve-target.js";
import {
  applySentryUrlContext,
  parseSentryUrl,
} from "../../lib/sentry-url-parser.js";
import { buildReplayUrl } from "../../lib/sentry-urls.js";
import type {
  ReplayActivityEvent,
  ReplayDetails,
  ReplayRelatedIssue,
  ReplayRelatedTrace,
} from "../../types/index.js";
import { ReplayViewOutputSchema } from "../../types/index.js";

type ViewFlags = {
  readonly json: boolean;
  readonly web: boolean;
  readonly fresh: boolean;
  readonly fields?: string[];
};

type ParsedPositionalArgs = {
  replayId: string;
  targetArg: string | undefined;
  warning?: string;
};

const USAGE_HINT =
  "sentry replay view [<org>/<project>/]<replay-id> | <replay-url>";
const MAX_ACTIVITY_EVENTS = 6;
const MAX_RELATED_ERRORS = 3;
const MAX_RELATED_TRACES = 2;

const log = logger.withTag("replay.view");

/**
 * Parse a single positional argument as a replay target.
 *
 * Handles bare replay IDs, `<org>/<replay-id>`, `<org>/<project>/<replay-id>`,
 * and Sentry replay URLs. The single-slash case (`org/id`) needs special
 * handling because 32-char hex replay IDs look valid to the generic
 * `parseSlashSeparatedArg` which would misinterpret the org as a project.
 */
function parseSingleArg(arg: string, usageHint: string): ParsedPositionalArgs {
  const trimmed = arg.trim();
  if (!trimmed) {
    throw new ContextError("Replay ID", usageHint, []);
  }

  // Handle <org>/<replay-id> shorthand — must check before parseSlashSeparatedArg
  // because replay IDs are 32-char hex strings that look valid to the generic
  // slash parser's ID extraction, but with only one slash the "project" segment
  // would be wrongly treated as the ID.
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx !== -1 && trimmed.indexOf("/", slashIdx + 1) === -1) {
    const org = trimmed.slice(0, slashIdx);
    const replaySegment = trimmed.slice(slashIdx + 1);
    const normalizedReplayId =
      replaySegment && tryNormalizeHexId(replaySegment);
    if (!normalizedReplayId) {
      throw new ContextError("Replay ID", usageHint, []);
    }
    return { replayId: normalizedReplayId, targetArg: `${org}/` };
  }

  const { id: replayId, targetArg } = parseSlashSeparatedArg(
    trimmed,
    "Replay ID",
    usageHint
  );
  return { replayId, targetArg };
}

/**
 * Parse replay view positional arguments.
 *
 * Supports:
 * - `<replay-id>`
 * - `<org>/<replay-id>`
 * - `<org>/<project>/<replay-id>`
 * - `<target> <replay-id>`
 * - `<replay-url>`
 *
 * `usageHint` lets sibling replay commands show their own usage in errors.
 */
export function parsePositionalArgs(
  args: string[],
  usageHint = USAGE_HINT
): ParsedPositionalArgs {
  if (args.length === 0) {
    throw new ContextError("Replay ID", usageHint, []);
  }
  if (args.length > 2) {
    throw new ValidationError(
      `Too many positional arguments (got ${args.length}, expected at most 2).\n\nUsage: ${usageHint}`,
      "positional"
    );
  }

  const first = args[0];
  if (!first) {
    throw new ContextError("Replay ID", usageHint, []);
  }

  const urlParsed = parseSentryUrl(first);
  if (urlParsed) {
    applySentryUrlContext(urlParsed.baseUrl);
    if (urlParsed.replayId && urlParsed.org) {
      return { replayId: urlParsed.replayId, targetArg: `${urlParsed.org}/` };
    }
    throw new ContextError("Replay ID", usageHint, [
      "Pass a replay URL: https://sentry.io/organizations/{org}/explore/replays/{replayId}/",
    ]);
  }

  if (args.length === 1) {
    return parseSingleArg(first, usageHint);
  }

  const second = args[1];
  if (!second) {
    throw new ContextError("Replay ID", usageHint, []);
  }

  const warning =
    args.length === 2 ? detectSwappedViewArgs(first, second) : null;
  if (warning) {
    const normalizedReplayId = tryNormalizeHexId(first) ?? first;
    return {
      replayId: normalizedReplayId,
      targetArg: second,
      warning,
    };
  }

  return { replayId: second, targetArg: first };
}

type ReplayProjectScope = {
  org: string;
  project?: string;
  expectedProjectId?: string;
  replayId: string;
  replay: ReplayDetails;
  /** Subcommand named in the error's usage hint. */
  command?: "view" | "download";
};

/**
 * Reject a replay that is not in the project the user named.
 *
 * Replays are looked up org-wide, so an explicit `<org>/<project>/<id>` target
 * has to be checked against the replay's own project.
 */
export async function validateReplayProjectScope(
  scope: ReplayProjectScope
): Promise<void> {
  const { expectedProjectId, org, project, replay, replayId } = scope;
  const command = scope.command ?? "view";
  if (!project) {
    return;
  }

  if (replay.project_id === null || replay.project_id === undefined) {
    if (replay.is_archived) {
      return;
    }

    throw new ResolutionError(
      `Replay '${replayId}'`,
      "has no project association",
      `sentry replay ${command} ${org}/${project}/${replayId}`,
      [
        `Use the org-scoped replay instead: sentry replay ${command} ${org}/${replayId}`,
      ]
    );
  }

  const projectId = expectedProjectId ?? (await getProject(org, project)).id;
  if (String(projectId) !== String(replay.project_id)) {
    throw new ResolutionError(
      `Replay '${replayId}'`,
      `is not in project '${project}'`,
      `sentry replay ${command} ${org}/${project}/${replayId}`,
      [
        `Use the org-scoped replay instead: sentry replay ${command} ${org}/${replayId}`,
      ]
    );
  }
}

async function fetchReplayActivity(
  org: string,
  replay: ReplayDetails
): Promise<ReplayActivityEvent[]> {
  if (
    replay.is_archived ||
    !replay.project_id ||
    (replay.count_segments ?? 0) <= 0
  ) {
    return [];
  }

  try {
    const segments = await getReplayRecordingSegments(
      org,
      String(replay.project_id),
      replay.id,
      { expectedSegments: replay.count_segments }
    );
    return extractReplayActivityEvents(segments, MAX_ACTIVITY_EVENTS);
  } catch (error) {
    log.debug("Failed to fetch replay recording segments", error);
    return [];
  }
}

/**
 * Fetch related issue metadata for replay-linked error event IDs.
 *
 * Uses org-wide issue search (`project = ""`) because replays may span
 * multiple projects within the same organization.
 */
function fetchRelatedReplayIssues(
  org: string,
  replay: ReplayDetails
): Promise<ReplayRelatedIssue[]> {
  const eventIds = replay.error_ids.slice(0, MAX_RELATED_ERRORS);

  return Promise.all(
    eventIds.map(async (eventId) => {
      try {
        const page = await listIssuesPaginated(org, "", {
          query: `event.id:${eventId}`,
          perPage: 1,
        });
        const issue = page.data[0];
        return {
          eventId,
          issueId: issue?.id ?? null,
          shortId: issue?.shortId ?? null,
          title: issue?.title ?? null,
        };
      } catch (error) {
        log.debug(`Failed to resolve issue for event ${eventId}`, error);
        return { eventId, issueId: null, shortId: null, title: null };
      }
    })
  );
}

function fetchRelatedReplayTraces(
  org: string,
  replay: ReplayDetails
): Promise<ReplayRelatedTrace[]> {
  const traceIds = replay.trace_ids.slice(0, MAX_RELATED_TRACES);

  return Promise.all(
    traceIds.map(async (traceId) => {
      try {
        const meta = await getTraceMeta(org, traceId);
        return {
          traceId,
          errorCount: meta.errors,
          logCount: meta.logs,
          performanceIssueCount: meta.performance_issues,
          spanCount: meta.span_count,
        };
      } catch (error) {
        log.debug(`Failed to fetch trace meta for ${traceId}`, error);
        return {
          traceId,
          errorCount: null,
          logCount: null,
          performanceIssueCount: null,
          spanCount: null,
        };
      }
    })
  );
}

async function enrichReplayView(
  org: string,
  replay: ReplayDetails
): Promise<
  Pick<ReplayViewData, "activity" | "relatedIssues" | "relatedTraces">
> {
  const [activity, relatedIssues, relatedTraces] = await Promise.all([
    fetchReplayActivity(org, replay),
    fetchRelatedReplayIssues(org, replay),
    fetchRelatedReplayTraces(org, replay),
  ]);

  return { activity, relatedIssues, relatedTraces };
}

export const viewCommand = buildCommand({
  docs: {
    brief: "View a Session Replay",
    fullDescription:
      "View detailed information about a Session Replay.\n\n" +
      "Pass a replay ID, a Sentry replay URL, or a trace ID linked to a replay.\n\n" +
      "ID formats:\n" +
      "  <id>                     - auto-detect org from config or DSN\n" +
      "  <org>/<id>               - explicit organization\n" +
      "  <org>/<project>/<id>     - explicit org/project context\n" +
      "  <replay-url>             - parse org and replay ID from a Sentry URL\n\n" +
      "Examples:\n" +
      "  sentry replay view 346789a703f6454384f1de473b8b9fcc\n" +
      "  sentry replay view sentry/346789a703f6454384f1de473b8b9fcc\n" +
      "  sentry replay view sentry/cli/346789a703f6454384f1de473b8b9fcc\n" +
      "  sentry replay view https://sentry.io/organizations/sentry/explore/replays/346789a703f6454384f1de473b8b9fcc/\n" +
      "  sentry replay view --web sentry/346789a703f6454384f1de473b8b9fcc",
  },
  output: {
    human: formatReplayDetails,
    jsonTransform: (data: ReplayViewData, fields?: string[]) => {
      const result: Record<string, unknown> = {
        ...data.replay,
        org: data.org,
        activity: data.activity,
        relatedIssues: data.relatedIssues,
        relatedTraces: data.relatedTraces,
      };
      return fields && fields.length > 0
        ? filterFields(result, fields)
        : result;
    },
    schema: ReplayViewOutputSchema,
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        placeholder: "replay-id-or-url",
        brief: "[<org>/<project>] <replay-id or trace-id> or <replay-url>",
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

    const parsedArgs = parsePositionalArgs(args);
    if (parsedArgs.warning) {
      log.warn(parsedArgs.warning);
    }

    const replayId = validateHexId(parsedArgs.replayId, "replay ID");
    const resolved = await resolveOrgOptionalFromArg(
      parsedArgs.targetArg,
      cwd,
      "replay view"
    );

    let replay: ReplayDetails;
    try {
      replay = await resolveReplay(resolved.org, replayId, {
        projectSlugs: resolved.project ? [resolved.project] : undefined,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        throw new ResolutionError(
          `Replay '${replayId}'`,
          "not found",
          `sentry replay view ${resolved.org}/${replayId}`,
          [
            "Check that you are querying the right organization",
            "The replay may be past your retention window",
          ]
        );
      }
      throw error;
    }

    if (flags.web) {
      await openInBrowser(buildReplayUrl(resolved.org, replay.id), "replay");
      return;
    }

    await validateReplayProjectScope({
      org: resolved.org,
      project: resolved.project,
      expectedProjectId: resolved.projectData?.id,
      replayId,
      replay,
    });

    const enrichment = await enrichReplayView(resolved.org, replay);
    const data: ReplayViewData = {
      org: resolved.org,
      replay,
      ...enrichment,
    };

    yield new CommandOutput(data);
    return { hint: replayHint(data) };
  },
});
