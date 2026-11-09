import { z } from "zod";
import type { SentryApiService } from "../../api-client";
import { ApiClientError, ApiNotFoundError } from "../../api-client";
import type {
  AutofixRunState,
  CommitterList,
  DefaultEvent,
  ErrorEvent,
  Event,
  ExternalIssueList,
  Issue,
  Trace,
} from "../../api-client/types";
import { ConfigurationError, UserInputError } from "../../errors";
import type { CodeLocation } from "../../internal/code-location";
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
  formatIssueOutput,
  parseIssueParams,
} from "../../internal/tool-helpers/issue";
import { structuredResult } from "../../internal/tool-helpers/results";
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
import { nonEmptyString } from "../support/structured-stacktrace";
import type { StructuredToolOutput } from "../types";

// mirrors MAX_DISPLAY_REPLAYS in the markdown output
const MAX_RELATED_REPLAYS = 5;
const MAX_AI_CONVERSATION_MATCHES = 3;
const AI_CONVERSATION_LOOKUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const TRACE_ID_PATTERN = /^[0-9a-fA-F]{32}$/;

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
  event: issueEventSchema,
  seer: z
    .object({
      status: z.string().nullable(),
      rootCause: z.string().nullable(),
      solution: z.string().nullable(),
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

type IssueDetailsArgs = Parameters<typeof formatIssueOutput>[0];

function issueDetailsResult(args: IssueDetailsArgs) {
  if (args.experimentalMode) {
    return buildIssueDetailsResult(args);
  }
  return formatIssueOutput(args);
}

function buildIssueDetailsResult(
  args: IssueDetailsArgs,
): StructuredToolOutput<GetIssueDetailsPayload> {
  if (!isSupportedEventType(args.event)) {
    reportUnsupportedEventType(args);
  }
  return structuredResult(buildIssueDetailsPayload(args));
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
  aiConversations,
  codeLocation,
  committers,
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
    event: buildIssueEventPayload({ event, performanceTrace, packageNames }),
    seer: autofix
      ? {
          status: nonEmptyString(getStatusDisplayName(autofix.status)),
          rootCause: nonEmptyString(summaries?.rootCause),
          solution: nonEmptyString(summaries?.solution),
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
      session: {
        experimentalMode: experimentalMode ?? false,
        availableToolNames,
        directToolNames,
      },
    }),
  };
}

function toCount(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  const count = Number(value);
  return Number.isFinite(count) ? count : null;
}

/**
 * The follow-up calls the markdown Response Notes describe, as callable actions: a metric
 * issue's monitor and query, the agent conversations in the trace, the trace itself, and the
 * breadcrumbs.
 */
function buildIssueSuggestedActions({
  organizationSlug,
  issue,
  event,
  apiService,
  aiConversations,
  session,
}: {
  organizationSlug: string;
  issue: Issue;
  event: Event;
  apiService: SentryApiService;
  aiConversations?: AIConversationReference[];
  session: {
    experimentalMode: boolean;
    availableToolNames?: ReadonlySet<string>;
    directToolNames?: ReadonlySet<string>;
  };
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
  description: [
    "Get detailed information about a specific Sentry issue by ID.",
    "",
    "USE THIS TOOL WHEN USERS:",
    "- Provide a specific issue ID (e.g., 'CLOUDFLARE-MCP-41', 'PROJECT-123')",
    "- Ask to 'explain [ISSUE-ID]', 'tell me about [ISSUE-ID]'",
    "- Want details/stacktrace/analysis for a known issue",
    "- Need installed package versions for an exact event (pass eventId and packageNames)",
    "- Want the suspect commit's SHA, message, author, and source when available",
    "- Provide a Sentry issue URL",
    "",
    "DO NOT USE for:",
    "- General searching or listing issues (use search_issues)",
    "",
    "TRIGGER PATTERNS:",
    "- 'Explain ISSUE-123' → use get_issue_details",
    "- 'Tell me about PROJECT-456' → use get_issue_details",
    "- 'What happened in [issue URL]' → use get_issue_details",
    "",
    "<examples>",
    "### With Sentry URL (recommended - simplest approach)",
    "```",
    "get_issue_details(issueUrl='https://sentry.sentry.io/issues/6916805731/?project=4509062593708032&query=is%3Aunresolved')",
    "```",
    "",
    "### With issue ID and organization",
    "```",
    "get_issue_details(organizationSlug='my-organization', issueId='CLOUDFLARE-MCP-41')",
    "```",
    "",
    "### With event ID and organization",
    "```",
    "get_issue_details(organizationSlug='my-organization', eventId='c49541c747cb4d8aa3efb70ca5aba243')",
    "```",
    "</examples>",
    "",
    "<hints>",
    "- **IMPORTANT**: If user provides a Sentry URL, pass the ENTIRE URL to issueUrl parameter unchanged",
    "- When using issueUrl, all other parameters are automatically extracted - don't provide them separately",
    "- If using issueId (not URL), then organizationSlug is required",
    "- To close the issue from a commit, put `Fixes <issue.shortId>` in the commit message, or `Fixes <issue.url>` when shortId is only digits",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    issueId: ParamIssueShortId.optional(),
    eventId: ParamEventId.optional(),
    issueUrl: ParamIssueUrl.optional(),
    packageNames: ParamPackageNames.optional(),
  },
  // Experimental sessions get structuredContent on every success path, so only they are told
  // the schema; stable sessions still get markdown until the structured payload graduates.
  experimentalOutputSchema: getIssueDetailsOutputSchema,
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
        { event, performanceTrace, aiConversations, codeLocation, committers },
        { autofixState, externalIssues, relatedReplayIds },
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
        aiConversations,
        codeLocation,
        committers,
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
      { event, performanceTrace, aiConversations, codeLocation, committers },
      { autofixState, externalIssues, relatedReplayIds },
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
      aiConversations,
      codeLocation,
      committers,
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
}> {
  const [performanceTrace, aiConversations, codeLocation, committers] =
    await Promise.all([
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
    ]);

  return { performanceTrace, aiConversations, codeLocation, committers };
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
 * Fetches supplementary data for an issue in parallel: Seer analysis and external links.
 * All calls are non-blocking -- failures are silently caught so they never
 * prevent the primary issue details from being returned. Seer analysis is
 * skipped entirely when the `seer` skill is not granted.
 */
async function fetchIssueEnrichmentData({
  apiService,
  organizationSlug,
  issue,
  seerEnabled,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  issue: Issue;
  seerEnabled: boolean;
}): Promise<{
  autofixState: AutofixRunState | undefined;
  externalIssues: ExternalIssueList | undefined;
  relatedReplayIds: string[] | undefined;
}> {
  const issueId = String(issue.id);
  const [autofixState, externalIssues, relatedReplayIds] = await Promise.all([
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
  ]);

  return { autofixState, externalIssues, relatedReplayIds };
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
      spanId: getString(record.span_id),
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
  const traceId = event.contexts?.trace?.trace_id;
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
  const traceId = event.contexts?.trace?.trace_id;

  if (typeof traceId !== "string" || traceId.length === 0) {
    return null;
  }

  return { traceId };
}

function getReplayDataSource(issue: Issue): "discover" | "search_issues" {
  return issue.issueCategory === "error" || issue.type === "error"
    ? "discover"
    : "search_issues";
}
