import { getActiveSpan } from "@sentry/core";
import {
  type RewrittenSearchQuery,
  rewriteSearchQuery,
  SearchQueryError,
} from "@sentry/toolkit-core/search-query";
import { z } from "zod";
import {
  SEARCH_ISSUES_PERIOD_VALUES,
  type SearchIssuesPeriodValue,
} from "../../constants";
import { UserInputError } from "../../errors";
import { hasAgentProvider } from "../../internal/agents/provider-factory";
import { withProviderFallback } from "../../internal/agents/provider-fallback";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { ParamOrganizationSlug, ParamRegionUrl } from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { isNumericId, validateSlugOrId } from "../../utils/slug-validation";
import { translateIssuesWithSeer } from "../support/search-events/seer";
import {
  formatUntranslatedQueryNote,
  looksLikeSentrySearchSyntax,
} from "../support/search-events/utils";
import { searchIssuesAgent } from "../support/search-issues/agent";
import {
  buildIssueResults,
  ISSUE_SORTS,
  type IssueSort,
  searchIssuesOutputSchema,
} from "../support/search-issues/results";

const ProjectSlugOrIdSchema = z.string().trim().superRefine(validateSlugOrId);

function isIssueSort(value: string): value is IssueSort {
  return (ISSUE_SORTS as readonly string[]).includes(value);
}

function isSearchIssuesPeriod(value: string): value is SearchIssuesPeriodValue {
  return (SEARCH_ISSUES_PERIOD_VALUES as readonly string[]).includes(value);
}

/**
 * Rewrite a query into syntax the issues endpoint accepts.
 *
 * The endpoint rejects AND/OR and has no grouping. Runs after the optional
 * agent repair, so it also covers sessions without an agent provider.
 */
function rewriteIssueQuery(query: string): RewrittenSearchQuery {
  try {
    return rewriteSearchQuery(query, { issueSearch: true });
  } catch (error) {
    if (error instanceof SearchQueryError) {
      throw new UserInputError(`${error.message}\n\nSentry query: ${query}`, {
        cause: error,
      });
    }
    throw error;
  }
}

function buildIssueSearchRepairPrompt(params: {
  query: string;
  sort: IssueSort;
}): string {
  return [
    "Fix this Sentry issue search request.",
    "The query may be natural language, Sentry issue search syntax, or a mix of both.",
    "Explicit Sentry search terms are authoritative. A token in field:value syntax must be preserved exactly unless Sentry would reject that specific token.",
    "Magic values in explicit syntax, such as me and latest, are valid and must be preserved.",
    "Do not remove, replace, broaden, simplify, or canonicalize valid explicit filters.",
    "Only translate natural-language words around explicit filters, add missing filters that are clearly requested, or correct syntax that would fail.",
    "Sort may be corrected when the requested sort conflicts with the user's intent, but sort must stay out of the query string.",
    "",
    `User query: ${params.query}`,
    "Current parameters:",
    JSON.stringify({ sort: params.sort }, null, 2),
  ].join("\n");
}

export default defineTool({
  name: "search_issues",
  title: "Search Issues",
  skills: ["inspect", "triage", "seer"], // Available in inspect, triage, and seer skills
  requiredScopes: ["event:read"],
  description: [
    "Search for grouped issues/problems in Sentry - returns a LIST of issues, NOT counts or aggregations.",
    "",
    "Provide `query` as natural language or Sentry issue search syntax. Seer translates natural language when the organization has AI issue search; otherwise a configured embedded agent fixes query and sort while preserving explicit Sentry search syntax.",
    "",
    "Returns grouped issues with metadata like title, status, and user count.",
    "",
    "Common Query Syntax:",
    "- is:unresolved / is:resolved / is:ignored / is:for_review / is:new / is:regressed / is:escalating",
    "- level:error / level:warning",
    "- firstSeen:-24h / lastSeen:-7d",
    "- assigned:me / assigned_or_suggested:me",
    "- release:latest",
    "- issue.category:feedback",
    "- issue.priority:high",
    "- environment:production",
    "- userCount:>100",
    "",
    "No AND/OR or parentheses: spaces mean AND. For OR on one field use field:[a,b]; for several statuses use status:[resolved,ignored] or substatus:[regressed,escalating].",
    "",
    "DO NOT USE FOR COUNTS/AGGREGATIONS → use search_errors",
    "DO NOT USE FOR individual events with timestamps → use search_errors, search_logs, or search_traces",
    "DO NOT USE FOR details about a specific issue → use get_sentry_resource",
    "",
    "<examples>",
    "search_issues(organizationSlug='my-org', query='critical bugs from last week')",
    "search_issues(organizationSlug='my-org', query='is:unresolved is:unassigned', sort='freq')",
    "search_issues(organizationSlug='my-org', query='level:error firstSeen:-24h', projectSlugOrId='my-project')",
    "</examples>",
    "",
    "<hints>",
    "- If the user passes a parameter in the form of name/otherName, it's likely in the format of <organizationSlug>/<projectSlugOrId>.",
    "- Parse org/project notation directly without calling find_organizations or find_projects.",
    "- The projectSlugOrId parameter accepts both project slugs (e.g., 'my-project') and numeric IDs (e.g., '123456').",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    query: z
      .string()
      .trim()
      .default("is:unresolved")
      .describe("Natural language or Sentry issue search query syntax."),
    sort: z
      .enum(["date", "freq", "new", "user", "recommended"])
      .default("date")
      .describe(
        "Sort order: date (last seen), freq (frequency), new (first seen), user (user count), recommended (Sentry's prioritized ranking)",
      ),
    projectSlugOrId: ProjectSlugOrIdSchema.nullable()
      .default(null)
      .describe("The project's slug or numeric ID (optional)"),
    regionUrl: ParamRegionUrl.nullable().default(null),
    limit: z
      .number()
      .min(1)
      .max(100)
      .default(10)
      .describe("Maximum number of issues to return (1-100)"),
    period: z
      .enum(SEARCH_ISSUES_PERIOD_VALUES)
      .default("30d")
      .describe(
        "Time window for issue search results. Controls which issues are returned based on when they had activity. Default 30d is a balance between coverage and query performance; use 1h or 24h for very recent issues or 90d for broader historical searches.",
      ),
    includeExplanation: z
      .boolean()
      .default(false)
      .describe(
        "Include explanation of how the query was translated or repaired",
      ),
  },
  outputSchema: searchIssuesOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });

    setTargetTagsAndAttributes(params);

    let query: string;
    let sort: IssueSort;
    let period = params.period;
    let explanation: string | undefined;
    // Set only when the query ran as-is; shown when it then matches nothing.
    let untranslatedQueryNote: string | null = null;

    let projectId: string | undefined;
    if (params.projectSlugOrId) {
      const projectSlugOrId = ProjectSlugOrIdSchema.parse(
        params.projectSlugOrId,
      );
      if (isNumericId(projectSlugOrId)) {
        projectId = projectSlugOrId;
      } else {
        const project = await apiService.getProject({
          organizationSlug: params.organizationSlug,
          projectSlugOrId,
        });
        projectId = String(project.id);
      }
    }

    // Seer only sees the natural language query, so skip it for Sentry syntax.
    const seerTranslation =
      !params.query || looksLikeSentrySearchSyntax(params.query, "issues")
        ? null
        : await translateIssuesWithSeer({
            apiService,
            organizationSlug: params.organizationSlug,
            projectId,
            query: params.query,
          });

    if (seerTranslation) {
      query = seerTranslation.query;
      sort = isIssueSort(seerTranslation.sort)
        ? seerTranslation.sort
        : params.sort;
      // Seer sets a period only when the query asks for one.
      if (isSearchIssuesPeriod(seerTranslation.statsPeriod)) {
        period = seerTranslation.statsPeriod;
      }
      explanation = seerTranslation.explanation;
    } else if (hasAgentProvider()) {
      // Agent mode: repair requests before calling Sentry. If the optional AI
      // provider is unavailable, preserve the original query and continue.
      const translatedQuery = await withProviderFallback<
        Awaited<ReturnType<typeof searchIssuesAgent>>["result"]
      >({
        operation: "search_issues.rewrite",
        fallback: () => ({
          query: params.query,
          sort: params.sort,
          explanation: "",
        }),
        run: async () =>
          (
            await searchIssuesAgent({
              query: buildIssueSearchRepairPrompt({
                query: params.query,
                sort: params.sort,
              }),
              organizationSlug: params.organizationSlug,
              apiService,
              projectId,
            })
          ).result,
      });

      query = translatedQuery.query ?? params.query;
      sort = translatedQuery.sort || params.sort;
      explanation = translatedQuery.explanation;
    } else {
      // Direct mode: use Sentry query syntax params as-is
      query = params.query;
      sort = params.sort;
      untranslatedQueryNote = formatUntranslatedQueryNote(
        params.query,
        "is:unresolved level:error",
        "issues",
      );
    }

    const rewritten = rewriteIssueQuery(query);
    query = rewritten.query;

    const issues = await apiService.listIssues({
      organizationSlug: params.organizationSlug,
      projectId,
      query,
      sortBy: sort,
      limit: params.limit,
      statsPeriod: period,
    });

    getActiveSpan()?.setAttribute(
      "gen_ai.tool.call.result.count",
      issues.length,
    );

    return buildIssueResults({
      issues,
      organizationSlug: params.organizationSlug,
      inputQuery: params.query,
      query,
      sort,
      period,
      projectSlugOrId: params.projectSlugOrId ?? undefined,
      explanation: params.includeExplanation ? explanation : undefined,
      notes: [
        ...(rewritten.notes.length > 0
          ? [`Query rewritten: ${rewritten.notes.join(" ")} Ran \`${query}\`.`]
          : []),
        ...(issues.length === 0 && untranslatedQueryNote
          ? [untranslatedQueryNote]
          : []),
      ],
      regionUrl: params.regionUrl ?? undefined,
      host: context.sentryHost,
      protocol: context.sentryProtocol,
      experimentalMode: context.experimentalMode ?? false,
      availableToolNames: context.availableToolNames,
      directToolNames: context.directToolNames,
    });
  },
});
