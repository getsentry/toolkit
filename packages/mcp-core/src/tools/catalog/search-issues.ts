import { getActiveSpan } from "@sentry/core";
import { z } from "zod";
import { SEARCH_ISSUES_PERIOD_VALUES } from "../../constants";
import { hasAgentProvider } from "../../internal/agents/provider-factory";
import { withProviderFallback } from "../../internal/agents/provider-fallback";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { ParamOrganizationSlug, ParamRegionUrl } from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { isNumericId, validateSlugOrId } from "../../utils/slug-validation";
import { searchIssuesAgent } from "../support/search-issues/agent";
import {
  formatExplanation,
  formatIssueResults,
} from "../support/search-issues/formatters";

const ProjectSlugOrIdSchema = z.string().trim().superRefine(validateSlugOrId);

function buildIssueSearchRepairPrompt(params: {
  query: string;
  sort: "date" | "freq" | "new" | "user" | "recommended";
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
  skills: ["inspect", "triage", "seer"], // Available in inspect, triage, and seer skills
  requiredScopes: ["event:read"],
  description: [
    "Search for grouped issues/problems in Sentry - returns a LIST of issues, NOT counts or aggregations.",
    "",
    "Provide `query` as natural language or Sentry issue search syntax. When an embedded agent is configured, it fixes query and sort before running while preserving explicit Sentry search syntax.",
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
        "Time window for issue search results. Controls which issues are returned based on when they had activity. Default 30d is a balance between coverage and query performance; use 24h for very recent issues or 90d for broader historical searches.",
      ),
    includeExplanation: z
      .boolean()
      .default(false)
      .describe(
        "Include explanation of how the query was translated or repaired",
      ),
  },
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
    let sort: "date" | "freq" | "new" | "user" | "recommended";
    let explanation: string | undefined;

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

    if (hasAgentProvider()) {
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
    }

    const issues = await apiService.listIssues({
      organizationSlug: params.organizationSlug,
      projectId,
      query,
      sortBy: sort,
      limit: params.limit,
      statsPeriod: params.period,
    });

    getActiveSpan()?.setAttribute(
      "gen_ai.tool.call.result.count",
      issues.length,
    );

    // Build output with explanation first (if requested and NL was used), then results
    let output = "";

    if (params.includeExplanation && explanation) {
      output += `# Search Results for "${params.query}"\n\n`;
      output += `**Suggested presentation:** Cards work well for these issues, with status, assignee, and issue ID links visible.\n\n`;

      output += `## Query Translation\n`;
      output += `Input query: "${params.query}"\n`;
      output += `Sentry query: \`${query}\``;
      output += `\nSort: ${sort}`;
      output += `\n\n`;

      if (explanation) {
        output += formatExplanation(explanation);
        output += `\n\n`;
      }

      output += formatIssueResults({
        issues,
        organizationSlug: params.organizationSlug,
        projectSlugOrId: params.projectSlugOrId ?? undefined,
        query,
        regionUrl: params.regionUrl ?? undefined,
        host: context.sentryHost,
        protocol: context.sentryProtocol,
        inputQuery: params.query,
        skipHeader: true,
        experimentalMode: context.experimentalMode ?? false,
        availableToolNames: context.availableToolNames,
        directToolNames: context.directToolNames,
      });
    } else {
      output = formatIssueResults({
        issues,
        organizationSlug: params.organizationSlug,
        projectSlugOrId: params.projectSlugOrId ?? undefined,
        query,
        regionUrl: params.regionUrl ?? undefined,
        host: context.sentryHost,
        protocol: context.sentryProtocol,
        inputQuery: params.query,
        skipHeader: false,
        experimentalMode: context.experimentalMode ?? false,
        availableToolNames: context.availableToolNames,
        directToolNames: context.directToolNames,
      });
    }

    return output;
  },
});
