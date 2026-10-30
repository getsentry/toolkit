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
  type ParsedOrgProject,
  parseOrgProjectInput,
} from "../../lib/arg-parsing.js";
import { openInBrowser } from "../../lib/browser.js";
import { buildCommand } from "../../lib/command.js";
import { ApiError, ResolutionError } from "../../lib/errors.js";
import { filterFields } from "../../lib/formatters/json.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  extractReplayActivityEvents,
  formatReplayDetails,
  type ReplayViewData,
  replayHint,
} from "../../lib/formatters/replay.js";
import { ID_KINDS, parseIdArgument } from "../../lib/id-arguments.js";
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
  type ResolvedOrgOptionalTarget,
  resolveOrgOptionalTarget,
} from "../../lib/resolve-target.js";
import { applySentryUrlContext } from "../../lib/sentry-url-parser.js";
import { buildReplayUrl } from "../../lib/sentry-web-urls.js";
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

const USAGE_HINT =
  "sentry replay view [<org>/<project>/]<replay-id> | <replay-url>";
const MAX_ACTIVITY_EVENTS = 6;
const MAX_RELATED_ERRORS = 3;
const MAX_RELATED_TRACES = 2;

const log = logger.withTag("replay.view");

/**
 * Parse `replay view` and `replay download` arguments: a replay ID in the
 * forms every ID-taking command takes (see `id-arguments.ts`), or a replay
 * URL.
 *
 * `usageHint` lets sibling replay commands show their own usage in errors.
 * Has no side effects: a pasted URL's server is returned as `baseUrl`.
 */
export function parseReplayArguments(
  args: readonly string[],
  usageHint = USAGE_HINT,
): ReplayArgumentsInput {
  const { target, id, baseUrl, warnings } = parseIdArgument(
    args,
    ID_KINDS.replay,
    { usageHint },
  );
  const parsed = parseOrgProjectInput(target);
  return {
    replayId: id,
    target: parsed.parsed,
    baseUrl: baseUrl ?? parsed.baseUrl,
    warnings,
  };
}

/** Parsed `replay view` and `replay download` arguments. */
export type ReplayArgumentsInput = {
  readonly replayId: string;
  readonly target: ParsedOrgProject;
  /** Server of a pasted Sentry URL, for `applySentryUrlContext` */
  readonly baseUrl?: string;
  /** Warnings to log, such as for reversed arguments */
  readonly warnings: readonly string[];
};

/** A replay ID and the org (and optional project) to look it up in. */
export type ResolvedReplayTarget = ResolvedOrgOptionalTarget & {
  readonly replayId: string;
};

/** The arguments of `replay view` and `replay download`. */
export type ReplayArguments = BoundArguments<
  ReplayArgumentsInput,
  ResolvedReplayTarget
>;

/**
 * Positional for `[<org>/<project>] <replay-id>` or a replay URL, shared by
 * `replay view` and `replay download`.
 */
export function replayArguments(
  command: "view" | "download",
  usageHint: string,
) {
  const commandLog = logger.withTag(`replay.${command}`);
  return boundArguments({
    placeholder: "replay-id-or-url",
    brief: "[<org>/<project>] <replay-id or trace-id> or <replay-url>",
    kind: "org/project",
    parse: (raw) => parseReplayArguments(raw, usageHint),
    resolve: async (
      input,
      context: SentryContext,
    ): Promise<ResolvedReplayTarget> => {
      if (input.baseUrl) {
        applySentryUrlContext(input.baseUrl);
      }
      for (const warning of input.warnings) {
        commandLog.warn(warning);
      }
      const resolved = await resolveOrgOptionalTarget(
        input.target,
        context.cwd,
        `replay ${command}`,
      );
      return { ...resolved, replayId: input.replayId };
    },
  });
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
  scope: ReplayProjectScope,
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
      ],
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
      ],
    );
  }
}

async function fetchReplayActivity(
  org: string,
  replay: ReplayDetails,
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
      { expectedSegments: replay.count_segments },
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
  replay: ReplayDetails,
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
    }),
  );
}

function fetchRelatedReplayTraces(
  org: string,
  replay: ReplayDetails,
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
    }),
  );
}

async function enrichReplayView(
  org: string,
  replay: ReplayDetails,
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
      "  <replay-url>             - parse org and replay ID from a Sentry URL",
    examples: [
      {
        description:
          "View a replay by ID (organization and project auto-detected)",
        command: "sentry replay view 346789a703f6454384f1de473b8b9fcc",
      },
      {
        description: "View a replay in an explicit organization",
        command: "sentry replay view my-org/346789a703f6454384f1de473b8b9fcc",
      },
      {
        description: "View a replay with explicit org/project context",
        command:
          "sentry replay view my-org/frontend/346789a703f6454384f1de473b8b9fcc",
      },
      {
        description: "View a replay from its URL",
        command:
          "sentry replay view https://sentry.io/organizations/my-org/explore/replays/346789a703f6454384f1de473b8b9fcc/",
      },
      {
        description: "View the replay linked to a trace",
        command:
          "sentry replay view my-org/frontend/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      {
        description: "Open a replay in the browser",
        command:
          "sentry replay view my-org/346789a703f6454384f1de473b8b9fcc --web",
      },
    ],
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
    positional: replayArguments("view", USAGE_HINT),
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
  async *func(this: SentryContext, flags: ViewFlags, target: ReplayArguments) {
    applyFreshFlag(flags);

    const resolved = await target.resolved;
    const { replayId } = resolved;

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
          ],
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
