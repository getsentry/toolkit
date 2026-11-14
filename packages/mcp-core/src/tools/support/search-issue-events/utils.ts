import { z } from "zod";
import type { SentryApiService } from "../../../api-client";
import { UserInputError } from "../../../errors";
import {
  agentTool,
  recordAgentToolResultCount,
} from "../../../internal/agents/tools/utils";
import { resolveScopedOrganizationSlug } from "../../../internal/url-scope";
import {
  EXAMPLE_QUERIES,
  ISSUE_EVENT_TAGS,
  RECOMMENDED_FIELDS,
} from "./config";

/**
 * Create a tool for the agent to query available tags and fields for issue events
 * The tool is pre-bound with the API service and organization configured for the appropriate region
 */
export function createIssueEventFieldsTool(options: {
  apiService: SentryApiService;
  organizationSlug: string;
  projectId?: string | undefined;
}) {
  const { apiService, organizationSlug, projectId } = options;
  return agentTool({
    description:
      "Get available tags and fields for issue events to understand what filters are available",
    parameters: z.object({}), // No parameters needed
    execute: async () => {
      // Fetch available tags from the Sentry API
      // IMPORTANT: Let ALL errors bubble up to agentTool wrapper
      // UserInputError will be converted to error string for the AI agent
      // Other errors will bubble up to be captured by Sentry
      const tagsResponse = await apiService.listTags({
        organizationSlug,
        dataset: "events",
        project: projectId,
        statsPeriod: "14d",
        useCache: true,
        useFlagsBackend: true,
      });

      // Build a map of available tags
      const availableTags: Record<string, string> = {};
      for (const tag of tagsResponse) {
        if (tag.key) {
          const knownTagDescription =
            ISSUE_EVENT_TAGS[tag.key as keyof typeof ISSUE_EVENT_TAGS];
          availableTags[tag.key] = tag.name || knownTagDescription || tag.key;
        }
      }

      // Combine with common known tags
      const allTags = { ...ISSUE_EVENT_TAGS, ...availableTags };
      const tagCount = Object.keys(allTags).length;

      recordAgentToolResultCount(tagCount);

      // Format the response
      return `Available Tags and Fields (${tagCount} total):

Common Tags:
${Object.entries(ISSUE_EVENT_TAGS)
  .slice(0, 30)
  .map(([key, desc]) => `- ${key}: ${desc}`)
  .join("\n")}
${Object.keys(ISSUE_EVENT_TAGS).length > 30 ? `\n... and ${Object.keys(ISSUE_EVENT_TAGS).length - 30} more common tags` : ""}

Project-Specific Tags (from API):
${Object.entries(availableTags)
  .filter(([key]) => !ISSUE_EVENT_TAGS[key as keyof typeof ISSUE_EVENT_TAGS]) // Only show tags not in common list
  .slice(0, 20)
  .map(([key, desc]) => `- ${key}: ${desc}`)
  .join("\n")}

Recommended Fields for Results:
${RECOMMENDED_FIELDS.map((f) => `- ${f}`).join("\n")}

EXAMPLE QUERIES:
${EXAMPLE_QUERIES.map((ex) => `- "${ex.description}" →\n  ${JSON.stringify(ex.output, null, 2)}`).join("\n\n")}

IMPORTANT:
- Use these tag names exactly as shown in your query
- Tags are case-insensitive
- Use wildcards with quotes: url:"*/checkout/*"
- Your query should NOT include "issue:" prefix - the handler adds it automatically`;
    },
  });
}

/**
 * Parse issue parameters from various input formats
 * Supports both direct issueId/organizationSlug and issueUrl parsing
 */
export function parseIssueParams(params: {
  organizationSlug?: string | null;
  issueId?: string | undefined;
  issueUrl?: string | undefined;
}): { organizationSlug: string; issueId: string } {
  // If issueUrl is provided, parse it
  if (params.issueUrl) {
    // Match both formats:
    // https://sentry.io/organizations/my-org/issues/123/
    // https://my-org.sentry.io/issues/123/
    const orgMatch =
      params.issueUrl.match(/\/organizations\/([^/]+)\/issues\/([^/?]+)/) ||
      params.issueUrl.match(/https?:\/\/([^.]+)\.sentry\.io\/issues\/([^/?]+)/);

    const [, urlOrganizationSlug, issueId] = orgMatch ?? [];
    if (!urlOrganizationSlug || !issueId) {
      throw new UserInputError(
        `Invalid issue URL format. Expected format like:
- https://sentry.io/organizations/my-org/issues/123/
- https://my-org.sentry.io/issues/123/

Received: ${params.issueUrl}`,
      );
    }

    return {
      organizationSlug: resolveScopedOrganizationSlug({
        resourceLabel: "Issue",
        scopedOrganizationSlug: params.organizationSlug,
        urlOrganizationSlug,
      }),
      issueId,
    };
  }

  // Otherwise, require both issueId and organizationSlug
  if (!params.issueId) {
    throw new UserInputError(
      "Must provide either issueUrl or issueId parameter. Use issueUrl for convenience, or provide both issueId and organizationSlug.",
    );
  }

  if (!params.organizationSlug) {
    throw new UserInputError(
      "When using issueId parameter, organizationSlug is required. Alternatively, provide issueUrl which includes both organization and issue ID.",
    );
  }

  return {
    organizationSlug: params.organizationSlug,
    issueId: params.issueId,
  };
}
