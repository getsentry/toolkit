import { getActiveSpan } from "@sentry/core";
import { z } from "zod";
import {
  RELATED_ISSUE_TYPE_STATUSES,
  RELATED_ISSUE_TYPES,
} from "../../api-client/schema";
import type { RelatedIssues } from "../../api-client/types";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import {
  ensureIssueWithinProjectConstraint,
  parseIssueParams,
} from "../../internal/tool-helpers/issue";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  buildSuggestedToolAction,
  suggestedToolActionSchema,
} from "../../internal/tool-helpers/suggested-actions";
import {
  ParamEventId,
  ParamIssueShortId,
  ParamIssueUrl,
  ParamOrganizationSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import {
  issueSummarySchema,
  toIssueSummary,
} from "../support/search-issues/results";

export const findRelatedIssuesOutputSchema = z.object({
  organizationSlug: z.string(),
  issueId: z.string(),
  relatedIssues: z
    .array(
      issueSummarySchema.extend({
        relations: z
          .array(
            z.object({
              type: z.enum(RELATED_ISSUE_TYPES),
              score: z
                .number()
                .nullable()
                .describe(
                  "similar_stacktrace only: how similar the stack traces are, from 0 to 1.",
                ),
            }),
          )
          .describe("One entry per relation type that matched the issue."),
      }),
    )
    .describe("Issues matched by more relation types first."),
  relationTypes: z
    .array(
      z.object({
        type: z.enum(RELATED_ISSUE_TYPES),
        status: z
          .enum(RELATED_ISSUE_TYPE_STATUSES)
          .describe(
            "ok: it ran, so no issues of this type means none were found. not_applicable: it doesn't apply to this issue. unavailable: it failed.",
          ),
        detail: z.string().nullable(),
        traceId: z
          .string()
          .nullable()
          .describe("same_trace only: the trace that was searched."),
      }),
    )
    .describe("Whether each requested relation type ran."),
  notes: z.array(z.string()),
  suggestedActions: z.array(suggestedToolActionSchema),
});

type RelationTypeMeta = RelatedIssues["meta"]["types"][number];

/**
 * Why a relation type failed. Only same_trace has an equivalent search to run
 * instead: issue search on the trace reads the same data. Similar stack traces
 * come from Seer embeddings, which no search reproduces.
 */
function formatUnavailableNote(meta: RelationTypeMeta): string {
  const detail = meta.detail ?? `${meta.type} is unavailable.`;
  if (meta.type === "same_trace" && meta.traceId) {
    return `${detail} To look for them now, run search_issues with the query \`trace:${meta.traceId}\`.`;
  }
  return detail;
}

export default defineTool({
  name: "find_related_issues",
  title: "Find Related Issues",
  skills: ["inspect", "triage", "seer"],
  requiredScopes: ["event:read"],
  description:
    "Find Sentry issues related to an issue: likely duplicates with a similar stack trace in the same project, other errors in the same trace, and the error issues behind a metric alert. Returns each related issue with its status and why it's related. Use it before resolving or ignoring an issue. It doesn't compare titles or error messages.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    issueId: ParamIssueShortId.optional(),
    issueUrl: ParamIssueUrl.optional(),
    eventId: ParamEventId.optional().describe(
      "One of the issue's events to find relations from, such as its trace. Defaults to the issue's latest event.",
    ),
    types: z
      .array(z.enum(RELATED_ISSUE_TYPES))
      .nullable()
      .default(null)
      .describe(
        "Relation types to return; all when omitted. similar_stacktrace: likely duplicates. same_trace: errors in the same trace, often the other side of a request. contributing: for a metric issue, the error issues behind it.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe("Maximum related issues per relation type."),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: findRelatedIssuesOutputSchema,
  async handler(params, context: ServerContext) {
    const parsed = parseIssueParams({
      issueUrl: params.issueUrl,
      issueId: params.issueId,
      organizationSlug:
        params.organizationSlug ?? context.constraints.organizationSlug,
    });

    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? context.constraints.regionUrl ?? undefined,
    });
    setTargetTagsAndAttributes({
      organizationSlug: parsed.organizationSlug,
      issueId: parsed.issueId,
    });

    const projectSlug = context.constraints.projectSlug;
    await ensureIssueWithinProjectConstraint({
      apiService,
      organizationSlug: parsed.organizationSlug,
      issueId: parsed.issueId,
      projectSlug,
    });

    const related = await apiService.getRelatedIssues({
      organizationSlug: parsed.organizationSlug,
      issueId: parsed.issueId,
      types: params.types ?? undefined,
      limit: params.limit,
      eventId: params.eventId,
    });

    // Same-trace issues can be in any project, so a project-scoped session
    // drops the ones outside its project.
    const inScope = projectSlug
      ? related.data.filter(({ issue }) => issue.project.slug === projectSlug)
      : related.data;
    const relatedIssues = inScope.map(({ issue, relations }) => ({
      ...toIssueSummary(
        issue,
        apiService.getIssueUrl(parsed.organizationSlug, issue.shortId),
      ),
      relations: relations.map((relation) => ({
        type: relation.type,
        score: relation.score ?? null,
      })),
    }));
    getActiveSpan()?.setAttribute(
      "gen_ai.tool.call.result.count",
      relatedIssues.length,
    );

    const notes = related.meta.types
      .filter((meta) => meta.status === "unavailable")
      .map(formatUnavailableNote);
    if (inScope.length < related.data.length) {
      notes.push(
        `Related issues outside the ${projectSlug} project are left out.`,
      );
    }

    const first = relatedIssues.at(0);
    const inspectFirst = first
      ? buildSuggestedToolAction({
          toolName: "get_sentry_resource",
          arguments: {
            organizationSlug: parsed.organizationSlug,
            resourceType: "issue",
            resourceId: first.shortId,
          },
          reason: "Inspect the most closely related issue.",
          experimentalMode: context.experimentalMode ?? false,
          availableToolNames: context.availableToolNames,
          directToolNames: context.directToolNames,
        })
      : null;

    return structuredResult({
      organizationSlug: parsed.organizationSlug,
      issueId: parsed.issueId,
      relatedIssues,
      relationTypes: related.meta.types.map((meta) => ({
        type: meta.type,
        status: meta.status,
        detail: meta.detail ?? null,
        traceId: meta.traceId ?? null,
      })),
      notes,
      suggestedActions: inspectFirst ? [inspectFirst] : [],
    });
  },
});
