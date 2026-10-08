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
  TransactionEvent,
} from "../../api-client/types";
import { ConfigurationError, UserInputError } from "../../errors";
import type { CodeLocation } from "../../internal/code-location";
import {
  dedupeReplayIds,
  getReplayIdFromEvent,
  getSeerActionabilityLabel,
  getSuspectCommit,
  isPerformanceIssueType,
  usesSharedFormatterBody,
} from "../../internal/formatting";
import type { AIConversationReference } from "../../internal/tool-helpers/ai-conversation-actions";
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
  getAutofixArtifactSummaries,
  getStatusDisplayName,
} from "../../internal/tool-helpers/seer";
import {
  ParamEventId,
  ParamIssueShortId,
  ParamIssueUrl,
  ParamOrganizationSlug,
  ParamRegionUrl,
} from "../../schema";
import { logError, logIssue } from "../../telem/logging";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { resolveCodeLocation } from "../support/code-location";

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
 *
 * `event.body` is the one open record: it is whatever Sentry's shared formatter emits
 * for `?llmFormat=json`, and its sections are decided there. Enumerating them here would make
 * this schema a second declaration of that contract, needing a bump every time a section is
 * added on the Sentry side.
 */
export const getIssueDetailsOutputSchema = z.object({
  issue: z.object({
    shortId: z.string(),
    title: z.string(),
    culprit: z.string().nullish(),
    firstSeen: z.string().nullish(),
    lastSeen: z.string().nullish(),
    occurrences: z.number().nullish(),
    usersImpacted: z.number().nullish(),
    status: z.string().nullish(),
    substatus: z.string().nullish(),
    assignedTo: z.string().nullish(),
    issueType: z.string().nullish(),
    issueCategory: z.string().nullish(),
    seerActionability: z.string().nullish(),
    platform: z.string().nullish(),
    project: z.string().nullish(),
    url: z.string(),
    // metadata fields the markdown surfaces for specific issue types
    location: z.string().nullish(),
    queryPattern: z.string().nullish(),
  }),
  event: z.object({
    id: z.string(),
    type: z.string().nullish(),
    occurredAt: z.string().nullish(),
    body: z.record(z.string(), z.unknown()),
  }),
  seer: z
    .object({
      status: z.string().nullish(),
      rootCause: z.string().nullish(),
      solution: z.string().nullish(),
    })
    .nullish(),
  codeLocation: z
    .object({
      repository: z.string().nullish(),
      path: z.string().nullish(),
      line: z.number().nullish(),
      url: z.string(),
    })
    .nullish(),
  suspectCommit: z
    .object({
      id: z.string(),
      message: z.string().nullish(),
      author: z.string().nullish(),
      suspectCommitType: z.string().nullish(),
    })
    .nullish(),
  replays: z
    .object({
      attached: z.string().nullish(),
      related: z.array(z.string()),
      // the full count, since `related` is capped
      relatedCount: z.number(),
    })
    .nullish(),
  externalIssues: z
    .array(
      z.object({
        id: z.string(),
        issueId: z.string(),
        serviceType: z.string(),
        displayName: z.string(),
        webUrl: z.string(),
      }),
    )
    .nullish(),
  aiConversations: z
    .array(
      z.object({
        conversationId: z.string(),
        spanId: z.string().nullish(),
      }),
    )
    .nullish(),
});

export type GetIssueDetailsPayload = z.infer<
  typeof getIssueDetailsOutputSchema
>;

/**
 * Parses the shared formatter's json body. Returns undefined when the caller's org is not on
 * the rollout yet, which is the signal to keep returning markdown: a structured result has to
 * carry the whole answer, and without the body it would not.
 */
function parseFormattedBody(event: Event): Record<string, unknown> | undefined {
  // the same event-type gate the markdown path applies: a transaction still needs the local
  // rendering, which carries the fetched performance trace that the shared body does not
  if (!usesSharedFormatterBody(event)) {
    return undefined;
  }
  const content = event.formatted?.content;
  if (!content) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The attached replay plus the related ones, derived the way the markdown output derives them.
 * The attached id lives on the event rather than in the related list, so passing that list
 * through alone loses the replay for an issue whose only one is attached.
 */
/**
 * ``dateCreated`` sits on the shared-formatter event types rather than the base union, and
 * the markdown path normalizes it to ISO. Read it the same way and tolerate a bad value.
 */
function eventOccurredAt(event: Event): string | null {
  const raw = "dateCreated" in event ? event.dateCreated : null;
  if (typeof raw !== "string") {
    return null;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

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

function buildIssueDetailsPayload({
  organizationSlug,
  issue,
  event,
  body,
  apiService,
  autofixState,
  externalIssues,
  relatedReplayIds,
  aiConversations,
  codeLocation,
  committers,
}: {
  organizationSlug: string;
  issue: Issue;
  event: Event;
  body: Record<string, unknown>;
  apiService: SentryApiService;
  autofixState?: AutofixRunState;
  externalIssues?: ExternalIssueList;
  relatedReplayIds?: string[];
  aiConversations?: AIConversationReference[];
  codeLocation?: CodeLocation;
  committers?: CommitterList;
}): GetIssueDetailsPayload {
  const autofix = autofixState?.autofix;
  // the run's own artifacts, not the whole state: an AutofixRunState carries every step and
  // would dwarf the rest of the payload
  const summaries = autofix ? getAutofixArtifactSummaries(autofix) : undefined;
  const isPerf = isPerformanceIssueType(issue) && !!issue.metadata;

  return {
    issue: {
      shortId: issue.shortId,
      // a performance issue's metadata carries the better title, as the markdown path prefers
      title: (isPerf ? issue.metadata?.title : null) || issue.title,
      culprit: issue.culprit,
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
      occurrences: issue.count == null ? null : Number(issue.count),
      usersImpacted: issue.userCount == null ? null : Number(issue.userCount),
      status: issue.status,
      substatus: issue.substatus,
      assignedTo:
        typeof issue.assignedTo === "string"
          ? issue.assignedTo
          : issue.assignedTo?.name,
      issueType: issue.issueType,
      issueCategory: issue.issueCategory,
      seerActionability:
        issue.seerFixabilityScore == null
          ? null
          : getSeerActionabilityLabel(issue.seerFixabilityScore),
      platform: issue.platform,
      project: issue.project?.name,
      url: apiService.getIssueUrl(organizationSlug, issue.shortId),
      // metadata.value is a query pattern only for a performance issue; on an error it is the
      // exception message, so reading it unconditionally would misname the error text
      location: isPerf ? issue.metadata?.location : null,
      queryPattern: isPerf ? issue.metadata?.value : null,
    },
    event: {
      id: event.id,
      type: typeof event.type === "string" ? event.type : null,
      occurredAt: eventOccurredAt(event),
      body,
    },
    seer: autofix
      ? {
          status: getStatusDisplayName(autofix.status),
          rootCause: summaries?.rootCause,
          solution: summaries?.solution,
        }
      : null,
    codeLocation: codeLocation
      ? {
          repository: codeLocation.repository,
          path: codeLocation.path,
          line: codeLocation.line,
          url: codeLocation.url,
        }
      : null,
    replays: buildReplays(event, relatedReplayIds),
    suspectCommit: getSuspectCommit(committers),
    // mapped field by field, not handed through: several upstream schemas are passthrough, and
    // structuredContent is a product contract rather than a view of the api response
    externalIssues: externalIssues?.length
      ? externalIssues.map((issue) => ({
          id: String(issue.id),
          issueId: String(issue.issueId),
          serviceType: issue.serviceType,
          displayName: issue.displayName,
          webUrl: issue.webUrl,
        }))
      : null,
    aiConversations: aiConversations?.length
      ? aiConversations.map((conversation) => ({
          conversationId: conversation.conversationId,
          spanId: conversation.spanId,
        }))
      : null,
  };
}

export default defineTool({
  name: "get_issue_details",
  skills: ["inspect", "triage", "seer"], // Available in inspect, triage, and seer skills
  requiredScopes: ["event:read"],
  description: [
    "Get detailed information about a specific Sentry issue by ID.",
    "",
    "USE THIS TOOL WHEN USERS:",
    "- Provide a specific issue ID (e.g., 'CLOUDFLARE-MCP-41', 'PROJECT-123')",
    "- Ask to 'explain [ISSUE-ID]', 'tell me about [ISSUE-ID]'",
    "- Want details/stacktrace/analysis for a known issue",
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
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    issueId: ParamIssueShortId.optional(),
    eventId: ParamEventId.optional(),
    issueUrl: ParamIssueUrl.optional(),
  },
  // outputSchema is deliberately not declared yet. tools/list would export it immediately,
  // while an org that is not on sentry's formatter rollout still gets a markdown result with
  // no structuredContent -- advertising a schema that some success paths cannot satisfy. Wire
  // it up once the rollout guarantees a json body on every event.
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
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
        const [found] = await apiService.listIssues({
          organizationSlug: orgSlug,
          query: eventId,
        });
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

      const body = parseFormattedBody(event);
      if (body) {
        return structuredResult(
          buildIssueDetailsPayload({
            organizationSlug: orgSlug,
            issue,
            event,
            body,
            apiService,
            autofixState,
            externalIssues,
            relatedReplayIds,
            aiConversations,
            codeLocation,
            committers,
          }),
        );
      }

      // no shared-formatter body for this org yet: keep returning markdown rather than a
      // structured result that is missing the event itself
      return formatIssueOutput({
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
        issueId: parsedIssueId!,
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

    const body = parseFormattedBody(event);
    if (body) {
      return structuredResult(
        buildIssueDetailsPayload({
          organizationSlug: orgSlug,
          issue,
          event,
          body,
          apiService,
          autofixState,
          externalIssues,
          relatedReplayIds,
          aiConversations,
          codeLocation,
          committers,
        }),
      );
    }

    // no shared-formatter body for this org yet: keep returning markdown rather than a
    // structured result that is missing the event itself
    return formatIssueOutput({
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

  return apiService
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

function getEventTimestamp(event: Event): Date | null {
  const timestamp =
    getString((event as { dateCreated?: unknown }).dateCreated) ??
    getString(event.dateReceived);
  if (!timestamp) {
    return null;
  }

  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
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

function isTransactionEvent(event: Event): event is TransactionEvent {
  return event.type === "transaction";
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
