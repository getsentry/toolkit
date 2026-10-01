import { getActiveSpan } from "@sentry/core";
import { z } from "zod";
import { UserInputError } from "../../errors";
import { hasAgentProvider } from "../../internal/agents/provider-factory";
import { withProviderFallback } from "../../internal/agents/provider-fallback";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { ensureIssueWithinProjectConstraint } from "../../internal/tool-helpers/issue";
import {
  ParamOrganizationSlug,
  ParamPeriod,
  ParamProjectSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTagAndAttribute } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { formatErrorResults } from "../support/search-events/formatters";
import { searchIssueEventsAgent } from "../support/search-issue-events/agent";
import { RECOMMENDED_FIELDS } from "../support/search-issue-events/config";
import { parseIssueParams } from "../support/search-issue-events/utils";

function buildIssueEventSearchRepairPrompt(params: {
  query?: string;
  sort?: string;
  statsPeriod?: string;
}): string {
  return [
    "Fix this Sentry issue event search request.",
    "The query may be natural language or already-valid Sentry event search syntax.",
    "Preserve valid explicit parameters, but correct query syntax, fields, sort, and time range when they conflict or would fail.",
    "",
    `User query: ${params.query || "(empty)"}`,
    "Current parameters:",
    JSON.stringify(
      {
        sort: params.sort ?? null,
        statsPeriod: params.statsPeriod ?? null,
      },
      null,
      2,
    ),
  ].join("\n");
}

export default defineTool({
  name: "search_issue_events",
  skills: ["inspect", "triage"], // Available in inspect and triage skills
  requiredScopes: ["event:read"],
  description: [
    "Search and filter events within a specific issue.",
    "",
    "Provide `query` as natural language or Sentry event search syntax. When an embedded agent is configured, it fixes filters, fields, sort, and time range before running.",
    "",
    "The tool automatically constrains results to the specified issue.",
    "",
    "Common Query Filters:",
    "- environment:production - Filter by environment",
    "- release:1.0.0 - Filter by release version",
    "- user.email:alice@example.com - Filter by user",
    "- trace:TRACE_ID - Filter by trace ID",
    "",
    "For cross-issue searches use search_issues. For single issue or event details use get_sentry_resource.",
    "",
    "<examples>",
    "search_issue_events(issueId='MCP-41', organizationSlug='my-org', query='from last hour')",
    "search_issue_events(issueId='MCP-41', organizationSlug='my-org', query='environment:production')",
    "search_issue_events(issueUrl='https://sentry.io/.../issues/123/', query='release:v1.0.0', period='7d')",
    "</examples>",
  ].join("\n"),
  inputSchema: {
    // Issue identification - one method required
    organizationSlug: ParamOrganizationSlug.nullable()
      .default(null)
      .describe(
        "Organization slug. Required when using issueId. Not needed when using issueUrl.",
      ),
    issueId: z
      .string()
      .optional()
      .describe(
        "Issue ID (e.g., 'MCP-41', 'PROJECT-123'). Requires organizationSlug. Alternatively, use issueUrl.",
      ),
    issueUrl: z
      .string()
      .url()
      .optional()
      .describe(
        "Full Sentry issue URL (e.g., 'https://sentry.io/organizations/my-org/issues/123/'). Includes both organization and issue ID.",
      ),

    query: z
      .string()
      .trim()
      .optional()
      .describe(
        "Natural language or Sentry event search query syntax for filtering within the issue.",
      ),
    sort: z
      .string()
      .optional()
      .describe(
        "Sort field (prefix with - for descending). Default: -timestamp",
      ),
    period: ParamPeriod.optional(),

    // Optional context parameters
    projectSlug: ParamProjectSlug.nullable()
      .default(null)
      .describe(
        "Project slug for better tag discovery. Optional - helps find project-specific tags.",
      ),
    regionUrl: ParamRegionUrl.nullable()
      .default(null)
      .describe("Sentry region URL. Optional - defaults to main region."),

    // Output control
    limit: z
      .number()
      .min(1)
      .max(100)
      .default(50)
      .describe("Maximum number of events to return (1-100, default: 50)"),
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
    const { organizationSlug, issueId } = parseIssueParams({
      organizationSlug: params.organizationSlug,
      issueId: params.issueId,
      issueUrl: params.issueUrl,
    });

    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });

    setTagAndAttribute("organization.slug", organizationSlug);
    setTagAndAttribute("issue.id", issueId);
    if (params.projectSlug) {
      setTagAndAttribute("project.slug", params.projectSlug);
    }

    await ensureIssueWithinProjectConstraint({
      apiService,
      organizationSlug,
      issueId,
      projectSlug: context.constraints.projectSlug,
    });

    // Resolve project ID if project slug provided (for better tag discovery in NL mode)
    let projectId: string | undefined;
    if (params.projectSlug) {
      try {
        const project = await apiService.getProject({
          organizationSlug,
          projectSlugOrId: params.projectSlug,
        });
        projectId = String(project.id);
      } catch (error) {
        // Non-fatal - continue without project ID
        console.warn(`Could not resolve project ${params.projectSlug}:`, error);
      }
    }

    let query: string;
    let fields: string[];
    let sortParam: string;
    let timeParams: { statsPeriod?: string; start?: string; end?: string };
    let explanation: string | undefined;

    if (hasAgentProvider()) {
      // Agent mode: repair either natural language or already-structured params.
      // If the optional AI provider is unavailable, execute the direct request.
      const parsed = await withProviderFallback<
        Awaited<ReturnType<typeof searchIssueEventsAgent>>["result"]
      >({
        operation: "search_issue_events.rewrite",
        fallback: () => ({
          query: params.query ?? "",
          fields: RECOMMENDED_FIELDS,
          // Treat empty string like missing so fallback matches direct mode.
          sort: params.sort || "-timestamp",
          timeRange: { statsPeriod: params.period ?? "14d" },
          explanation: "",
        }),
        run: async () =>
          (
            await searchIssueEventsAgent({
              query: buildIssueEventSearchRepairPrompt({
                query: params.query,
                sort: params.sort,
                statsPeriod: params.period,
              }),
              organizationSlug,
              apiService,
              projectId,
            })
          ).result,
      });

      if (!parsed.sort) {
        throw new UserInputError(
          `Search Issue Events Agent response missing required 'sort' parameter. Received: ${JSON.stringify(parsed, null, 2)}. The agent must specify how to sort results (e.g., '-timestamp' for newest first).`,
        );
      }

      query = parsed.query || "";
      sortParam = parsed.sort;
      explanation = parsed.explanation;

      const requestedFields = parsed.fields || [];
      fields =
        requestedFields.length > 0 ? requestedFields : RECOMMENDED_FIELDS;

      timeParams = parsed.timeRange
        ? { ...parsed.timeRange }
        : { statsPeriod: "14d" };
    } else {
      // Direct mode: use provided params as-is
      query = params.query ?? "";
      fields = RECOMMENDED_FIELDS;
      // Empty string is allowed by the schema; treat it like missing.
      sortParam = params.sort || "-timestamp";
      timeParams = { statsPeriod: params.period ?? "14d" };
    }

    // Execute search using issue-specific endpoint
    const eventsResponse = await apiService.listEventsForIssue({
      organizationSlug,
      issueId,
      query,
      limit: params.limit,
      sort: sortParam,
      ...timeParams,
    });

    // Generate explorer URL (include issue: prefix for the explorer)
    const explorerQuery = query
      ? `issue:${issueId} ${query}`
      : `issue:${issueId}`;
    const explorerUrl = apiService.getEventsExplorerUrl(
      organizationSlug,
      explorerQuery,
      projectId,
      "errors",
      fields,
      sortParam,
      [],
      [],
      timeParams.statsPeriod,
      timeParams.start,
      timeParams.end,
    );

    // Validate response structure
    function isValidEventArray(
      data: unknown,
    ): data is Record<string, unknown>[] {
      return (
        Array.isArray(data) &&
        data.every((item) => typeof item === "object" && item !== null)
      );
    }

    if (!isValidEventArray(eventsResponse)) {
      throw new Error(
        "Invalid event data format from Sentry API: expected array of objects",
      );
    }

    getActiveSpan()?.setAttribute(
      "gen_ai.tool.call.result.count",
      eventsResponse.length,
    );

    const naturalLanguageContext = params.query
      ? `Events in issue ${issueId}: ${params.query}`
      : `Events in issue ${issueId}`;

    return formatErrorResults({
      eventData: eventsResponse,
      inputQuery: naturalLanguageContext,
      includeExplanation: params.includeExplanation,
      apiService,
      organizationSlug,
      explorerUrl,
      sentryQuery: explorerQuery,
      fields,
      explanation,
    });
  },
});
