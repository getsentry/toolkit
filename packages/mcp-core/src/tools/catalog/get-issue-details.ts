import { z } from "zod";
import type { SentryApiService } from "../../api-client";
import { ApiClientError, ApiNotFoundError } from "../../api-client";
import { ISSUE_STATUSES, RELATED_ISSUE_TYPES } from "../../api-client/schema";
import type {
  AutofixRunState,
  CommitterList,
  DefaultEvent,
  ErrorEvent,
  Event,
  ExternalIssueList,
  Issue,
  RelatedIssues,
  RelatedIssueType,
  SourceMapDebug,
  Trace,
} from "../../api-client/types";
import { ConfigurationError, UserInputError } from "../../errors";
import type { CodeLocation } from "../../internal/code-location";
import { buildIssueSideQuests } from "../../internal/issue-side-quests";
import { sideQuestsSchema } from "../../internal/side-quests";
import {
  dedupeReplayIds,
  getMetricAlertContext,
  getMetricAlertFollowUpCalls,
  getReplayIdFromEvent,
  getSeerActionabilityLabel,
  getSuspectCommit,
  isPerformanceIssueType,
  isSupportedEventType,
  reportUnsupportedEventType,
} from "../../internal/formatting";
import {
  type AIConversationReference,
  getAIConversationSuggestedActions,
} from "../../internal/tool-helpers/ai-conversation-actions";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { enhanceNotFoundError } from "../../internal/tool-helpers/enhance-error";
import {
  assertIssueWithinProjectConstraint,
  isErrorIssue,
  parseIssueParams,
} from "../../internal/tool-helpers/issue";
import { structuredResult } from "../../internal/tool-helpers/results";
import type { ToolSession } from "../../internal/tool-helpers/tool-call-formatting";
import {
  MAX_SUGGESTED_ACTIONS,
  type SuggestedToolAction,
  buildSuggestedToolAction,
  suggestedToolActionSchema,
} from "../../internal/tool-helpers/suggested-actions";
import {
  getAutofixArtifactSummaries,
  getStatusDisplayName,
} from "../../internal/tool-helpers/seer";
import {
  ParamEventId,
  ParamIssueShortId,
  ParamIssueUrl,
  ParamOrganizationSlug,
  ParamPackageNames,
  ParamRegionUrl,
} from "../../schema";
import { logError, logIssue } from "../../telem/logging";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { resolveCodeLocation } from "../support/code-location";
import {
  buildIssueEventPayload,
  getEventTimestamp,
  issueEventSchema,
} from "../support/issue-event-payload";
import { maybeFetchSourceMapDebug } from "../support/source-map-debug";
import {
  nonEmptyString,
  type StructuredThreadSummary,
} from "../support/structured-stacktrace";
import type { StructuredToolOutput } from "../types";

// mirrors MAX_DISPLAY_REPLAYS in the markdown output
const MAX_RELATED_REPLAYS = 5;
const MAX_AI_CONVERSATION_MATCHES = 3;
const AI_CONVERSATION_LOOKUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const TRACE_ID_PATTERN = /^[0-9a-fA-F]{32}$/;
// also the per-type limit sent to /related/, so the top few are the endpoint's own top few
const MAX_RELATED_ISSUES = 5;
/**
 * Because this is a high-volume tool, it asks only for the relation types that are quick to
 * compute and light on rate limits.
 */
const ISSUE_DETAILS_RELATED_TYPES = [
  "similar_stacktrace",
  "same_trace",
  "contributing",
  "same_supergroup",
] as const satisfies readonly RelatedIssueType[];

/**
 * The issue payload as `structuredContent`.
 *
 * Every field is mapped explicitly rather than spread from an api response, so a passthrough
 * upstream schema cannot leak backend-only fields into the public interface.
 */
export const getIssueDetailsOutputSchema = z.object({
  issue: z.object({
    shortId: z.string(),
    title: z.string(),
    culprit: z.string().nullable(),
    firstSeen: z.string().nullable(),
    lastSeen: z.string().nullable(),
    occurrences: z.number().nullable(),
    usersImpacted: z.number().nullable(),
    status: z.string().nullable(),
    substatus: z.string().nullable(),
    assignedTo: z.string().nullable(),
    issueType: z.string().nullable(),
    issueCategory: z.string().nullable(),
    seerActionability: z.string().nullable(),
    platform: z.string().nullable(),
    project: z.string().nullable(),
    url: z.string(),
    // metadata fields that only performance issues carry
    location: z.string().nullable(),
    queryPattern: z.string().nullable(),
  }),
  relatedIssues: z
    .object({
      issues: z.array(
        z.object({
          shortId: z.string(),
          title: z.string(),
          status: z.enum(ISSUE_STATUSES).nullable(),
          project: z.string().nullable(),
          relations: z.array(z.enum(RELATED_ISSUE_TYPES)),
        }),
      ),
      unavailableTypes: z
        .array(z.enum(RELATED_ISSUE_TYPES))
        .describe("Relation types that failed, so some may be missing."),
    })
    .optional()
    .describe(
      `Up to ${MAX_RELATED_ISSUES} other issues related to this one, most relations first: similar_stacktrace (likely duplicate), same_trace (same request), contributing (behind a metric alert), same_supergroup (same root cause per Seer). Check them before resolving or ignoring this issue.`,
    ),
  event: issueEventSchema,
  seer: z
    .object({
      status: z.string().nullable(),
      rootCause: z.string().nullable(),
      solution: z.string().nullable(),
      failureReason: z
        .string()
        .nullable()
        .describe(
          'Why the Seer run failed, when Sentry can explain it. "out_of_credits": the organization ran out of Seer credits, so someone with billing access must adjust Seer spend and auto-reload in Sentry before the run can continue.',
        ),
    })
    .nullable(),
  codeLocation: z
    .object({
      repository: z.string().nullable(),
      path: z.string().nullable(),
      line: z.number().nullable(),
      url: z.string(),
    })
    .nullable(),
  suspectCommit: z
    .object({
      id: z.string(),
      message: z.string().nullable(),
      author: z.string().nullable(),
      suspectCommitType: z.string().nullable(),
    })
    .nullable(),
  replays: z
    .object({
      attached: z.string().nullable(),
      related: z.array(z.string()),
      // the full count, since `related` is capped
      relatedCount: z.number(),
    })
    .nullable(),
  externalIssues: z
    .array(
      z.object({
        serviceType: z.string(),
        displayName: z.string(),
        webUrl: z.string(),
      }),
    )
    .nullable(),
  aiConversations: z
    .array(
      z.object({
        conversationId: z.string(),
        spanId: z.string().nullable(),
      }),
    )
    .nullable(),
  suggestedActions: z.array(suggestedToolActionSchema),
  sideQuests: sideQuestsSchema,
});

export type GetIssueDetailsPayload = z.output<
  typeof getIssueDetailsOutputSchema
>;

/**
 * The attached replay plus the related ones, derived the way the markdown output derives them.
 * The attached id lives on the event rather than in the related list, so passing that list
 * through alone loses the replay for an issue whose only one is attached.
 */
function buildReplays(
  event: Event,
  relatedReplayIds?: string[],
): GetIssueDetailsPayload["replays"] {
  const attached = getReplayIdFromEvent(event);
  const related = dedupeReplayIds(relatedReplayIds ?? []).filter(
    (replayId) => replayId !== attached,
  );
  if (!attached && related.length === 0) {
    return null;
  }
  // markdown shows a count plus the first few, not every id
  return {
    attached,
    related: related.slice(0, MAX_RELATED_REPLAYS),
    relatedCount: related.length,
  };
}

type IssueDetailsArgs = {
  packageNames?: string[] | undefined;
  organizationSlug: string;
  issue: Issue;
  event: Event;
  apiService: SentryApiService;
  autofixState?: AutofixRunState | undefined;
  performanceTrace?: Trace | undefined;
  externalIssues?: ExternalIssueList | undefined;
  relatedReplayIds?: string[] | undefined;
  relatedIssues?: RelatedIssues | undefined;
  projectSlug?: string | null | undefined;
  aiConversations?: AIConversationReference[] | undefined;
  codeLocation?: CodeLocation | undefined;
  committers?: CommitterList | undefined;
  sourceMapDebug?: SourceMapDebug | undefined;
  experimentalMode?: boolean | undefined;
  availableToolNames?: ReadonlySet<string> | undefined;
  directToolNames?: ReadonlySet<string> | undefined;
};

/** null for a status this version doesn't know, so the output still matches its schema. */
function toIssueStatus(
  status: string | null | undefined,
): (typeof ISSUE_STATUSES)[number] | null {
  return ISSUE_STATUSES.find((known) => known === status) ?? null;
}

/**
 * The endpoint's top few related issues. Same-trace and same-supergroup issues can be in any
 * project, so a project-scoped session drops the ones outside its project, as
 * find_related_issues does.
 */
function buildRelatedIssues(
  related: RelatedIssues,
  projectSlug: string | null | undefined,
): NonNullable<GetIssueDetailsPayload["relatedIssues"]> {
  const inScope = projectSlug
    ? related.data.filter(({ issue }) => issue.project.slug === projectSlug)
    : related.data;
  return {
    issues: inScope
      .slice(0, MAX_RELATED_ISSUES)
      .map(({ issue, relations }) => ({
        shortId: issue.shortId,
        title: issue.title,
        status: toIssueStatus(issue.status),
        project: nonEmptyString(issue.project.name),
        relations: relations.map((relation) => relation.type),
      })),
    unavailableTypes: related.meta.types
      .filter((meta) => meta.status === "unavailable")
      .map((meta) => meta.type),
  };
}

function issueDetailsResult(
  args: IssueDetailsArgs,
): StructuredToolOutput<GetIssueDetailsPayload> {
  if (!isSupportedEventType(args.event)) {
    reportUnsupportedEventType(args);
  }
  return structuredResult(buildIssueDetailsPayload(args));
}

/**
 * The failure reason the markdown summary explains: only out-of-credits, and only once the run
 * has errored. Other reasons are Seer internals with no guidance to give.
 */
function getSeerFailureReason(
  autofix: NonNullable<AutofixRunState["autofix"]>,
): string | null {
  return autofix.status === "error" &&
    autofix.failure_reason === "out_of_credits"
    ? "out_of_credits"
    : null;
}

function buildIssueDetailsPayload({
  packageNames,
  organizationSlug,
  issue,
  event,
  apiService,
  autofixState,
  performanceTrace,
  externalIssues,
  relatedReplayIds,
  relatedIssues,
  projectSlug,
  aiConversations,
  codeLocation,
  committers,
  sourceMapDebug,
  experimentalMode,
  availableToolNames,
  directToolNames,
}: IssueDetailsArgs): GetIssueDetailsPayload {
  const autofix = autofixState?.autofix;
  // the run's own artifacts, not the whole state: an AutofixRunState carries every step and
  // would dwarf the rest of the payload
  const summaries = autofix ? getAutofixArtifactSummaries(autofix) : undefined;
  const isPerf = isPerformanceIssueType(issue) && !!issue.metadata;
  const suspectCommit = getSuspectCommit(committers);
  const session = {
    experimentalMode: experimentalMode ?? false,
    availableToolNames,
    directToolNames,
  };
  const sideQuests = buildIssueSideQuests({ event, sourceMapDebug }, session);
  const eventPayload = buildIssueEventPayload({
    event,
    performanceTrace,
    packageNames,
  });
  const related = relatedIssues
    ? buildRelatedIssues(relatedIssues, projectSlug)
    : undefined;

  return {
    issue: {
      shortId: issue.shortId,
      // a performance issue's metadata carries the better title, as the markdown path prefers
      title:
        (isPerf ? nonEmptyString(issue.metadata?.title) : null) ?? issue.title,
      culprit: nonEmptyString(issue.culprit),
      firstSeen: nonEmptyString(issue.firstSeen),
      lastSeen: nonEmptyString(issue.lastSeen),
      occurrences: toCount(issue.count),
      usersImpacted: toCount(issue.userCount),
      status: nonEmptyString(issue.status),
      substatus: nonEmptyString(issue.substatus),
      assignedTo: nonEmptyString(
        typeof issue.assignedTo === "string"
          ? issue.assignedTo
          : issue.assignedTo?.name,
      ),
      issueType: nonEmptyString(issue.issueType),
      issueCategory: nonEmptyString(issue.issueCategory),
      seerActionability:
        issue.seerFixabilityScore == null
          ? null
          : getSeerActionabilityLabel(issue.seerFixabilityScore),
      platform: nonEmptyString(issue.platform),
      project: nonEmptyString(issue.project.name),
      url: apiService.getIssueUrl(organizationSlug, issue.shortId),
      // metadata.value is a query pattern only for a performance issue; on an error it is the
      // exception message, so reading it unconditionally would misname the error text
      location: isPerf ? nonEmptyString(issue.metadata?.location) : null,
      queryPattern: isPerf ? nonEmptyString(issue.metadata?.value) : null,
    },
    // right after the issue, so it comes early in the text; omitted when it wasn't looked up
    ...(related && { relatedIssues: related }),
    event: eventPayload,
    seer: autofix
      ? {
          status: nonEmptyString(getStatusDisplayName(autofix.status)),
          rootCause: nonEmptyString(summaries?.rootCause),
          solution: nonEmptyString(summaries?.solution),
          failureReason: getSeerFailureReason(autofix),
        }
      : null,
    codeLocation: codeLocation
      ? {
          repository: codeLocation.repository ?? null,
          path: codeLocation.path ?? null,
          line: codeLocation.line ?? null,
          url: codeLocation.url,
        }
      : null,
    replays: buildReplays(event, relatedReplayIds),
    suspectCommit: suspectCommit
      ? {
          id: suspectCommit.id,
          message: nonEmptyString(suspectCommit.message),
          author: nonEmptyString(suspectCommit.author),
          suspectCommitType: nonEmptyString(suspectCommit.suspectCommitType),
        }
      : null,
    // mapped field by field, not handed through: several upstream schemas are passthrough, and
    // the link's own ids and the Sentry group id are integration plumbing, not follow-up handles
    externalIssues: externalIssues?.length
      ? externalIssues.map((externalIssue) => ({
          serviceType: externalIssue.serviceType,
          displayName: externalIssue.displayName,
          webUrl: externalIssue.webUrl,
        }))
      : null,
    aiConversations: aiConversations?.length
      ? aiConversations.map((conversation) => ({
          conversationId: conversation.conversationId,
          spanId: conversation.spanId ?? null,
        }))
      : null,
    suggestedActions: buildIssueSuggestedActions({
      organizationSlug,
      issue,
      event,
      apiService,
      aiConversations,
      hasRelatedIssues: (related?.issues.length ?? 0) > 0,
      otherThread: findOtherThread(eventPayload.threads),
      session,
    }),
    // omitted, not empty, when there are none
    ...(sideQuests && { sideQuests }),
  };
}

/**
 * The first thread with frames that neither crashed nor is current, as a
 * `thread` selector. A thread without frames has no stacktrace to fetch.
 */
function findOtherThread(
  threads: StructuredThreadSummary[] | null,
): number | string | null {
  const thread = threads?.find(
    (candidate) =>
      !candidate.crashed && !candidate.current && candidate.frameCount > 0,
  );
  return thread?.id ?? thread?.name ?? null;
}

function toCount(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  const count = Number(value);
  return Number.isFinite(count) ? count : null;
}

/**
 * Follow-up calls, most specific first: a metric issue's monitor and query, the related
 * issues, the issue's chart, the agent conversations in the trace, the trace itself,
 * another thread's stacktrace, and the breadcrumbs.
 */
function buildIssueSuggestedActions({
  organizationSlug,
  issue,
  event,
  apiService,
  aiConversations,
  hasRelatedIssues,
  otherThread,
  session,
}: {
  organizationSlug: string;
  issue: Issue;
  event: Event;
  apiService: SentryApiService;
  aiConversations?: AIConversationReference[] | undefined;
  hasRelatedIssues: boolean;
  otherThread: number | string | null;
  session: ToolSession;
}): SuggestedToolAction[] {
  const candidates: Array<SuggestedToolAction | null> = [];
  const metricAlertContext = getMetricAlertContext(event);

  if (metricAlertContext) {
    const calls = getMetricAlertFollowUpCalls({
      organizationSlug,
      issue,
      event,
      context: metricAlertContext,
    });
    if (calls.monitor) {
      candidates.push(
        buildSuggestedToolAction({
          ...calls.monitor,
          reason: "Inspect the Metric Monitor and its connected Alerts.",
          ...session,
        }),
      );
    }
    if (calls.search) {
      candidates.push(
        buildSuggestedToolAction({
          toolName: calls.search.toolName,
          arguments: calls.search.arguments,
          reason: `Search the data the monitor query matched; focus on ${calls.search.window.start.toISOString()} to ${calls.search.window.end.toISOString()}.`,
          ...session,
        }),
      );
    }
  }

  // the inline list is capped and has no scores; the tool has the full list
  if (hasRelatedIssues) {
    candidates.push(
      buildSuggestedToolAction({
        toolName: "find_related_issues",
        arguments: { organizationSlug, issueId: issue.shortId },
        reason:
          "List every related issue with its similarity score before resolving or ignoring this one.",
        ...session,
      }),
    );
  }

  // experimental, like the chart view that renders it
  if (session.experimentalMode) {
    candidates.push(
      buildSuggestedToolAction({
        toolName: "render_issue_chart",
        arguments: { organizationSlug, issueId: issue.shortId },
        reason: "Chart this issue's events and affected users over time.",
        ...session,
      }),
    );
  }

  if (aiConversations?.length) {
    candidates.push(
      ...getAIConversationSuggestedActions({
        organizationSlug,
        aiConversations,
        ...session,
      }),
    );
  }

  // a metric issue's trace belongs to the monitor evaluation, not the data that breached
  const traceId = getEventTraceId(event);
  if (traceId && TRACE_ID_PATTERN.test(traceId) && !metricAlertContext) {
    candidates.push(
      buildSuggestedToolAction({
        toolName: "get_trace_details",
        arguments: { organizationSlug, traceId },
        reason: "Inspect the distributed trace this event belongs to.",
        ...session,
      }),
    );
  }

  // event.threads lists them, but only get_event_stacktrace returns another thread's frames
  if (otherThread !== null) {
    candidates.push(
      buildSuggestedToolAction({
        toolName: "get_event_stacktrace",
        arguments: {
          organizationSlug,
          issueId: issue.shortId,
          eventId: event.id,
          thread: otherThread,
        },
        reason:
          "Fetch the full stacktrace of a thread that did not crash; pick another from event.threads by id or name.",
        ...session,
      }),
    );
  }

  candidates.push(
    buildSuggestedToolAction({
      toolName: "get_issue_breadcrumbs",
      arguments: {
        issueUrl: apiService.getIssueUrl(organizationSlug, issue.shortId),
      },
      reason: "Read the breadcrumb trail leading up to this event.",
      ...session,
    }),
  );

  return candidates
    .filter((action): action is SuggestedToolAction => action !== null)
    .slice(0, MAX_SUGGESTED_ACTIONS);
}

export default defineTool({
  name: "get_issue_details",
  title: "Get Issue Details",
  skills: ["inspect", "triage", "seer"], // Available in inspect, triage, and seer skills
  requiredScopes: ["event:read"],
  description:
    "Get the details of one Sentry issue, by issue ID, URL, or event ID: title, status, counts, the latest or a chosen event with its stacktrace, Seer root cause, suspect commit, linked tickets, and replays. Can also return installed package versions for one event. Use search_issues to list issues.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    issueId: ParamIssueShortId.optional(),
    eventId: ParamEventId.optional(),
    issueUrl: ParamIssueUrl.optional(),
    packageNames: ParamPackageNames.optional().describe(
      "Exact, case-sensitive package names recorded on the event. Returns their versions. Requires eventId.",
    ),
  },
  outputSchema: getIssueDetailsOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    if (params.packageNames && !params.eventId) {
      throw new UserInputError(
        "`packageNames` requires an explicit `eventId`.",
      );
    }
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });

    if (params.eventId) {
      const orgSlug = params.organizationSlug;
      const eventId = params.eventId; // Capture eventId for type safety
      if (!orgSlug) {
        throw new UserInputError(
          "`organizationSlug` is required when providing `eventId`",
        );
      }

      setTargetTagsAndAttributes({ organizationSlug: orgSlug });
      // Use issueId directly if provided (e.g., from URL parsing), otherwise search by eventId
      let issue: Awaited<ReturnType<typeof apiService.getIssue>>;
      if (params.issueId) {
        issue = await apiService.getIssue({
          organizationSlug: orgSlug,
          issueId: params.issueId,
        });
      } else {
        const issues = await apiService.listIssues({
          organizationSlug: orgSlug,
          query: eventId,
        });
        const found = issues.at(0);
        if (!found) {
          throw new UserInputError(`No issue found for Event ID: ${eventId}`);
        }
        issue = found;
      }
      assertIssueWithinProjectConstraint({
        issue,
        projectSlug: context.constraints.projectSlug,
      });
      // For this call, we might want to provide context if it fails
      const [
        {
          event,
          performanceTrace,
          aiConversations,
          codeLocation,
          committers,
          sourceMapDebug,
        },
        { autofixState, externalIssues, relatedReplayIds, relatedIssues },
      ] = await Promise.all([
        apiService
          .getEventForIssue({
            organizationSlug: orgSlug,
            issueId: String(issue.id),
            eventId,
          })
          // Optionally enhance 404 errors with parameter context
          .catch((error) => {
            if (error instanceof ApiNotFoundError) {
              throw enhanceNotFoundError(error, {
                organizationSlug: orgSlug,
                issueId: String(issue.id),
                eventId,
              });
            }
            throw error;
          })
          .then(async (event) => ({
            event,
            ...(await fetchEventEnrichment({
              apiService,
              organizationSlug: orgSlug,
              event,
              issue,
            })),
          })),
        fetchIssueEnrichmentData({
          apiService,
          organizationSlug: orgSlug,
          issue,
          seerEnabled: isSeerGranted(context),
          includeRelatedIssues: context.experimentalMode ?? false,
          // same_trace follows the event's trace, so it must be the event shown
          eventId,
        }),
      ]);

      return issueDetailsResult({
        packageNames: params.packageNames,
        organizationSlug: orgSlug,
        issue,
        event,
        apiService,
        autofixState,
        performanceTrace,
        externalIssues,
        relatedReplayIds,
        relatedIssues,
        projectSlug: context.constraints.projectSlug,
        aiConversations,
        codeLocation,
        committers,
        sourceMapDebug,
        experimentalMode: context.experimentalMode,
        availableToolNames: context.availableToolNames,
        directToolNames: context.directToolNames,
      });
    }

    // Validate that we have the minimum required parameters
    if (!params.issueUrl && !params.issueId) {
      throw new UserInputError(
        "Either `issueId` or `issueUrl` must be provided",
      );
    }

    if (!params.issueUrl && !params.organizationSlug) {
      throw new UserInputError(
        "`organizationSlug` is required when providing `issueId`",
      );
    }

    const { organizationSlug: orgSlug, issueId: parsedIssueId } =
      parseIssueParams({
        organizationSlug: params.organizationSlug,
        issueId: params.issueId,
        issueUrl: params.issueUrl,
      });

    setTargetTagsAndAttributes({ organizationSlug: orgSlug });

    // For the main issue lookup, provide parameter context on 404
    let issue: Awaited<ReturnType<typeof apiService.getIssue>>;
    try {
      issue = await apiService.getIssue({
        organizationSlug: orgSlug,
        issueId: parsedIssueId,
      });
    } catch (error) {
      if (error instanceof ApiNotFoundError) {
        throw enhanceNotFoundError(error, {
          organizationSlug: orgSlug,
          issueId: parsedIssueId,
        });
      }
      throw error;
    }
    assertIssueWithinProjectConstraint({
      issue,
      projectSlug: context.constraints.projectSlug,
    });

    const [
      {
        event,
        performanceTrace,
        aiConversations,
        codeLocation,
        committers,
        sourceMapDebug,
      },
      { autofixState, externalIssues, relatedReplayIds, relatedIssues },
    ] = await Promise.all([
      apiService
        .getLatestEventForIssue({
          organizationSlug: orgSlug,
          issueId: String(issue.id),
        })
        .then(async (event) => ({
          event,
          ...(await fetchEventEnrichment({
            apiService,
            organizationSlug: orgSlug,
            event,
            issue,
          })),
        })),
      fetchIssueEnrichmentData({
        apiService,
        organizationSlug: orgSlug,
        issue,
        seerEnabled: isSeerGranted(context),
        // experimental only until the Seer load and rate limits are checked
        includeRelatedIssues: context.experimentalMode ?? false,
      }),
    ]);

    return issueDetailsResult({
      organizationSlug: orgSlug,
      issue,
      event,
      apiService,
      autofixState,
      performanceTrace,
      externalIssues,
      relatedReplayIds,
      relatedIssues,
      projectSlug: context.constraints.projectSlug,
      aiConversations,
      codeLocation,
      committers,
      sourceMapDebug,
      experimentalMode: context.experimentalMode,
      availableToolNames: context.availableToolNames,
      directToolNames: context.directToolNames,
    });
  },
});

async function fetchEventEnrichment({
  apiService,
  organizationSlug,
  event,
  issue,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  event: Event;
  issue: Issue;
}): Promise<{
  performanceTrace: Trace | undefined;
  aiConversations: AIConversationReference[];
  codeLocation: CodeLocation | undefined;
  committers: CommitterList | undefined;
  sourceMapDebug: SourceMapDebug | undefined;
}> {
  const [
    performanceTrace,
    aiConversations,
    codeLocation,
    committers,
    sourceMapDebug,
  ] = await Promise.all([
    maybeFetchPerformanceTrace({
      apiService,
      organizationSlug,
      event,
    }),
    maybeFindAIConversationsForIssueEvent({
      apiService,
      organizationSlug,
      event,
    }),
    resolveCodeLocation({
      apiService,
      organizationSlug,
      projectSlug: issue.project.slug,
      event,
    }),
    maybeFetchCommitters({
      apiService,
      organizationSlug,
      projectSlug: issue.project.slug,
      event,
    }),
    maybeFetchSourceMapDebug({
      apiService,
      organizationSlug,
      projectSlug: issue.project.slug,
      event,
    }),
  ]);

  return {
    performanceTrace,
    aiConversations,
    codeLocation,
    committers,
    sourceMapDebug,
  };
}

/** Keeps issue details available when optional commit lookup fails, reporting unexpected failures. */
async function maybeFetchCommitters({
  apiService,
  organizationSlug,
  projectSlug,
  event,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  projectSlug: string;
  event: Event;
}): Promise<CommitterList | undefined> {
  try {
    return await apiService.getEventCommitters({
      organizationSlug,
      projectSlug,
      eventId: event.id,
    });
  } catch (error) {
    if (
      !(error instanceof ApiClientError) &&
      !(error instanceof ConfigurationError)
    ) {
      logIssue(error, {
        loggerScope: ["tools", "get-issue-details", "committers"],
        contexts: {
          request: { organizationSlug, projectSlug, eventId: event.id },
        },
      });
    }
    return undefined;
  }
}

/**
 * Fetches supplementary data for an issue in parallel: Seer analysis, external links, replays
 * and related issues. All calls are non-blocking -- failures are caught so they never
 * prevent the primary issue details from being returned. Seer analysis is
 * skipped entirely when the `seer` skill is not granted, and related issues unless
 * `includeRelatedIssues` is set.
 */
async function fetchIssueEnrichmentData({
  apiService,
  organizationSlug,
  issue,
  seerEnabled,
  includeRelatedIssues,
  eventId,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  issue: Issue;
  seerEnabled: boolean;
  includeRelatedIssues: boolean;
  /** The event the response shows; related issues come from the latest event when omitted. */
  eventId?: string;
}): Promise<{
  autofixState: AutofixRunState | undefined;
  externalIssues: ExternalIssueList | undefined;
  relatedReplayIds: string[] | undefined;
  relatedIssues: RelatedIssues | undefined;
}> {
  const issueId = String(issue.id);
  const [autofixState, externalIssues, relatedReplayIds, relatedIssues] =
    await Promise.all([
      maybeFetchAutofixState({
        apiService,
        organizationSlug,
        issue,
        seerEnabled,
      }),
      apiService
        .getIssueExternalLinks({ organizationSlug, issueId })
        .catch(() => undefined),
      apiService
        .listReplayIdsForIssue({
          organizationSlug,
          issueId,
          dataSource: getReplayDataSource(issue),
        })
        .catch(() => undefined),
      includeRelatedIssues
        ? maybeFetchRelatedIssues({
            apiService,
            organizationSlug,
            issueId,
            eventId,
          })
        : undefined,
    ]);

  return { autofixState, externalIssues, relatedReplayIds, relatedIssues };
}

/** Leaves the related issues out when the lookup fails, reporting unexpected failures. */
async function maybeFetchRelatedIssues({
  apiService,
  organizationSlug,
  issueId,
  eventId,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  issueId: string;
  eventId?: string | undefined;
}): Promise<RelatedIssues | undefined> {
  try {
    return await apiService.getRelatedIssues({
      organizationSlug,
      issueId,
      types: ISSUE_DETAILS_RELATED_TYPES,
      eventId,
      limit: MAX_RELATED_ISSUES,
    });
  } catch (error) {
    if (
      !(error instanceof ApiClientError) &&
      !(error instanceof ConfigurationError)
    ) {
      logIssue(error, {
        loggerScope: ["tools", "get-issue-details", "related-issues"],
        contexts: { request: { organizationSlug, issueId } },
      });
    }
    return undefined;
  }
}

/**
 * Whether Seer output can be used at all in this session.
 *
 * A session started with `--disable-skills=seer` (or `--skills` that omits it)
 * drops Seer output on the floor, so requesting it is pure overhead -- and on
 * deployments without Seer the autofix endpoint answers 500, making it a
 * guaranteed-failing request on every issue lookup. An unknown granted set
 * keeps the previous behaviour and fetches.
 */
function isSeerGranted(context: ServerContext): boolean {
  return context.grantedSkills ? context.grantedSkills.has("seer") : true;
}

async function maybeFetchAutofixState({
  apiService,
  organizationSlug,
  issue,
  seerEnabled,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  issue: Issue;
  seerEnabled: boolean;
}): Promise<AutofixRunState | undefined> {
  if (!seerEnabled) {
    return undefined;
  }

  return await apiService
    .getAutofixState({ organizationSlug, issueId: String(issue.id) })
    .catch(() => undefined);
}

async function maybeFetchPerformanceTrace({
  apiService,
  organizationSlug,
  event,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  event: Event;
}): Promise<Trace | undefined> {
  const context = shouldFetchTraceForEvent(event);
  if (!context) {
    return undefined;
  }

  try {
    return await apiService.getTrace({
      organizationSlug,
      traceId: context.traceId,
      limit: 10000,
    });
  } catch (error) {
    logError(error);
    return undefined;
  }
}

async function maybeFindAIConversationsForIssueEvent({
  apiService,
  organizationSlug,
  event,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  event: Event;
}): Promise<AIConversationReference[]> {
  const traceId = getEventTraceId(event);
  if (!traceId || !TRACE_ID_PATTERN.test(traceId)) {
    return [];
  }

  try {
    return await findAIConversationsForTrace({
      apiService,
      organizationSlug,
      traceId,
      event,
    });
  } catch (error) {
    logError(error);
    return [];
  }
}

/**
 * Conversation IDs live on spans, not issue events. Keep this as a bounded
 * opportunistic span match so issue details never fetch the full trace.
 */
async function findAIConversationsForTrace({
  apiService,
  organizationSlug,
  traceId,
  event,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  traceId: string;
  event: Event;
}): Promise<AIConversationReference[]> {
  const response = await apiService.searchEvents({
    organizationSlug,
    dataset: "spans",
    query: `trace:${traceId} has:gen_ai.conversation.id`,
    fields: ["gen_ai.conversation.id", "span_id", "timestamp"],
    limit: MAX_AI_CONVERSATION_MATCHES,
    sort: "-timestamp",
    ...buildConversationLookupTimeParams(event),
  });

  if (
    !response ||
    typeof response !== "object" ||
    !Array.isArray((response as { data?: unknown }).data)
  ) {
    return [];
  }

  const references = new Map<string, AIConversationReference>();
  for (const row of (response as { data: unknown[] }).data) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const record = row as Record<string, unknown>;
    const conversationId = getString(record["gen_ai.conversation.id"]);
    if (!conversationId || references.has(conversationId)) {
      continue;
    }

    references.set(conversationId, {
      conversationId,
      spanId: getString(record["span_id"]),
    });

    if (references.size >= MAX_AI_CONVERSATION_MATCHES) {
      break;
    }
  }

  return [...references.values()];
}

function buildConversationLookupTimeParams(event: Event): {
  statsPeriod?: string;
  start?: string;
  end?: string;
} {
  const eventTimestamp = getEventTimestamp(event);
  if (!eventTimestamp) {
    return { statsPeriod: "14d" };
  }

  return {
    start: new Date(
      eventTimestamp.getTime() - AI_CONVERSATION_LOOKUP_WINDOW_MS,
    ).toISOString(),
    end: new Date(
      eventTimestamp.getTime() + AI_CONVERSATION_LOOKUP_WINDOW_MS,
    ).toISOString(),
  };
}

function getEventTraceId(event: Event): string | undefined {
  const traceId = event.contexts?.["trace"]?.["trace_id"];
  return getString(traceId);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isErrorEvent(event: Event): event is ErrorEvent | DefaultEvent {
  // "default" type represents error events without exception data
  return event.type === "error" || event.type === "default";
}

function shouldFetchTraceForEvent(event: Event): { traceId: string } | null {
  // Only fetch traces for non-error events (transactions, profiling, etc.)
  if (isErrorEvent(event)) {
    return null;
  }

  // Check if we have a trace ID
  const traceId = event.contexts?.["trace"]?.["trace_id"];

  if (typeof traceId !== "string" || traceId.length === 0) {
    return null;
  }

  return { traceId };
}

function getReplayDataSource(issue: Issue): "discover" | "search_issues" {
  return isErrorIssue(issue) ? "discover" : "search_issues";
}
