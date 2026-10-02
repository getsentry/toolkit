// Catalog-only Agent Conversations search. This owns the MCP-facing projection for
// Sentry's conversation list endpoint and intentionally exposes backend default
// ordering until alternate sorting is applied by the API.
import { z } from "zod";
import type { AIConversationSummary, SentryApiService } from "../../api-client";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamPeriod,
  ParamProjectSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { isNumericId } from "../../utils/slug-validation";

const PREVIEW_LENGTH = 240;
const TRACE_ID_SAMPLE_SIZE = 3;
const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumSignificantDigits: 3,
});

const aiConversationSearchResultSchema = z.object({
  conversationId: z.string(),
  title: z.string().nullable(),
  url: z.string().url(),
  startTimestamp: z.number(),
  endTimestamp: z.number(),
  durationMs: z.number(),
  errors: z.number(),
  aiCallCount: z.number(),
  toolCallCount: z.number(),
  toolErrorCount: z.number(),
  totalTokens: z.number(),
  totalCost: z.string(),
  traceCount: z.number(),
  sampleTraceIds: z.array(z.string()),
  firstInputPreview: z.string().nullable(),
  lastOutputPreview: z.string().nullable(),
  flow: z.array(z.string()),
  toolNames: z.array(z.string()),
  user: z
    .object({
      email: z.string().nullable(),
      username: z.string().nullable(),
    })
    .nullable(),
});

export const searchAIConversationsOutputSchema = z.object({
  organizationSlug: z.string(),
  searchUrl: z.string().url(),
  count: z.number(),
  nextCursor: z.string().nullable(),
  conversations: z.array(aiConversationSearchResultSchema),
});

type SearchAIConversationsOutput = z.infer<
  typeof searchAIConversationsOutputSchema
>;

function normalizeList<T>(value: T | T[] | null | undefined): T[] | undefined {
  if (value == null) {
    return undefined;
  }
  return Array.isArray(value) ? value : [value];
}

async function resolveProjectIds({
  apiService,
  organizationSlug,
  project,
  constrainedProjectSlug,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  project?: string | string[];
  constrainedProjectSlug?: string | null;
}): Promise<string[] | undefined> {
  if (constrainedProjectSlug) {
    const constrainedProject = await apiService.getProject({
      organizationSlug,
      projectSlugOrId: constrainedProjectSlug,
    });
    return [String(constrainedProject.id)];
  }

  const projects = normalizeList(project);
  if (!projects || projects.length === 0) {
    return undefined;
  }

  return Promise.all(
    projects.map(async (projectSlugOrId) => {
      if (projectSlugOrId === "-1" || isNumericId(projectSlugOrId)) {
        return projectSlugOrId;
      }
      const resolvedProject = await apiService.getProject({
        organizationSlug,
        projectSlugOrId,
      });
      return String(resolvedProject.id);
    }),
  );
}

function previewText(value: string | null): string | null {
  if (value == null || value.length <= PREVIEW_LENGTH) {
    return value;
  }
  return `${value.slice(0, PREVIEW_LENGTH - 3)}...`;
}

function formatLLMCost(cost: number): string {
  if (cost === 0) {
    return "—";
  }
  if (cost > 0 && cost < 0.01) {
    return "<$0.01";
  }
  return usdFormatter.format(cost);
}

function projectUser(user: AIConversationSummary["user"]) {
  if (!user) {
    return null;
  }
  return {
    email: user.email,
    username: user.username,
  };
}

/**
 * Builds the stable structuredContent projection returned by the search tool.
 */
function buildArtifact(
  apiService: SentryApiService,
  organizationSlug: string,
  conversations: AIConversationSummary[],
  nextCursor: string | null,
  searchUrl: string,
): SearchAIConversationsOutput {
  return {
    organizationSlug,
    searchUrl,
    count: conversations.length,
    nextCursor,
    conversations: conversations.map((conversation) => {
      const {
        conversationId,
        title,
        flow,
        errors,
        llmCalls,
        toolCalls,
        totalTokens,
        totalCost,
        startTimestamp,
        endTimestamp,
        traceCount,
        traceIds,
        firstInput,
        lastOutput,
        user,
        toolNames,
        toolErrors,
      } = conversation;

      return {
        conversationId,
        title,
        flow,
        errors,
        aiCallCount: llmCalls,
        toolCallCount: toolCalls,
        totalTokens,
        totalCost: formatLLMCost(totalCost),
        startTimestamp,
        endTimestamp,
        traceCount,
        sampleTraceIds: traceIds.slice(0, TRACE_ID_SAMPLE_SIZE),
        firstInputPreview: previewText(firstInput),
        lastOutputPreview: previewText(lastOutput),
        user: projectUser(user),
        toolNames,
        toolErrorCount: toolErrors,
        url: apiService.getAIConversationUrl(organizationSlug, conversationId),
        durationMs: endTimestamp - startTimestamp,
      };
    }),
  };
}

export default defineTool({
  name: "search_agent_conversations",
  skills: ["inspect", "triage", "seer"],
  requiredScopes: ["event:read", "project:read"],
  description: [
    "Search Sentry Agent Conversations, formerly called AI Conversations, and return one summary row per conversation.",
    "",
    "Use this tool to find or list Agent Conversations. Results are conversation summaries, not raw span rows.",
    "Each row includes title (when available), USD cost, tokens, call counts, previews, and other list metadata.",
    "Use get_agent_conversation_details with a conversationId to fetch the transcript. Use get_sentry_resource for Sentry conversation URLs.",
    "",
    "<examples>",
    "search_agent_conversations(organizationSlug='my-org', query='failed conversations', period='7d')",
    "search_agent_conversations(organizationSlug='my-org', query='checkout', project='backend')",
    "</examples>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    query: z
      .string()
      .trim()
      .optional()
      .describe("Conversation query/filter string."),
    project: z
      .union([ParamProjectSlug, z.array(ParamProjectSlug).min(1)])
      .optional()
      .describe("Project slug or numeric project ID, or an array of projects."),
    environment: z
      .union([
        z.string().trim().min(1),
        z.array(z.string().trim().min(1)).min(1),
      ])
      .optional()
      .describe("Environment name, or an array of environments."),
    period: ParamPeriod.default("30d").describe(
      "Relative time range. Defaults to 30d.",
    ),
    start: z
      .string()
      .trim()
      .optional()
      .describe("Explicit start time for the search window."),
    end: z
      .string()
      .trim()
      .optional()
      .describe("Explicit end time for the search window."),
    cursor: z
      .string()
      .trim()
      .optional()
      .describe("Pagination cursor from a previous response."),
    limit: z.number().int().min(1).max(100).default(10),
    regionUrl: ParamRegionUrl.optional(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: searchAIConversationsOutputSchema,
  async handler(params, context: ServerContext) {
    if ((params.start && !params.end) || (!params.start && params.end)) {
      throw new UserInputError("`start` and `end` must be provided together.");
    }
    const requestedPeriod = params.period ?? "30d";

    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;

    setTargetTagsAndAttributes({ organizationSlug });

    const projectIds = await resolveProjectIds({
      apiService,
      organizationSlug,
      project: params.project,
      constrainedProjectSlug: context.constraints.projectSlug,
    });
    const statsPeriod =
      params.start || params.end ? undefined : requestedPeriod;

    const { conversations, nextCursor } =
      await apiService.searchAIConversations({
        organizationSlug,
        query: params.query,
        project: projectIds,
        environment: params.environment,
        statsPeriod,
        start: params.start,
        end: params.end,
        limit: params.limit,
        cursor: params.cursor,
      });

    const searchUrl = apiService.getAIConversationsUrl(organizationSlug, {
      query: params.query,
      project: projectIds,
      environment: params.environment,
      statsPeriod,
      start: params.start,
      end: params.end,
    });

    const artifact = buildArtifact(
      apiService,
      organizationSlug,
      conversations,
      nextCursor,
      searchUrl,
    );

    return structuredResult(artifact);
  },
});
