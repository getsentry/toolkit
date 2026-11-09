import { inlineCode } from "@sentry/toolkit-core/markdown";
import { z } from "zod";
import {
  ApiClientError,
  ApiNotFoundError,
  type IssueTagKeyList,
  type SentryApiService,
} from "../../api-client";
import { ConfigurationError, UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { enhanceNotFoundError } from "../../internal/tool-helpers/enhance-error";
import {
  ensureIssueWithinProjectConstraint,
  parseIssueParams,
} from "../../internal/tool-helpers/issue";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamIssueShortId,
  ParamIssueUrl,
  ParamOrganizationSlug,
  ParamRegionUrl,
} from "../../schema";
import { logIssue } from "../../telem/logging";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";

export const getIssueTagValuesOutputSchema = z.object({
  tag: z.object({
    key: z.string(),
    name: z.string(),
    totalValues: z.number(),
    topValues: z.array(
      z.object({
        value: z.string().nullable(),
        count: z.number(),
        firstSeen: z.string().nullable(),
        lastSeen: z.string().nullable(),
      }),
    ),
  }),
});

export default defineTool({
  name: "get_issue_tag_values",
  title: "Get Issue Tag Values",
  skills: ["inspect"], // Available in inspect skill for understanding issue distribution
  requiredScopes: ["event:read"],
  description: [
    "Get tag value distribution for a specific Sentry issue.",
    "",
    "Use this tool when you need to:",
    "- Understand how an issue is distributed across different tag values",
    "- Get aggregate counts of unique tag values (e.g., 'how many unique URLs are affected')",
    "- Analyze which browsers, environments, or URLs are most impacted by an issue",
    "- View the tag distributions page data programmatically",
    "",
    "Tag keys depend on the issue's platform, SDK, and custom tags, so keys such as `browser` or `url` are missing from many issues. The `### Tags` section of `get_issue_details` shows the tags on one of the issue's events, which is a good place to pick a key from. If the key is not on the issue, the error lists the keys it has.",
    "",
    "<examples>",
    "### Get environment distribution for an issue",
    "```",
    "get_issue_tag_values(organizationSlug='my-organization', issueId='PROJECT-123', tagKey='environment')",
    "```",
    "",
    "### Get release distribution using issue URL",
    "```",
    "get_issue_tag_values(issueUrl='https://sentry.io/issues/PROJECT-123/', tagKey='release')",
    "```",
    "</examples>",
    "",
    "<hints>",
    "- If user provides a Sentry URL, pass the ENTIRE URL to issueUrl parameter unchanged",
    "- Tag keys are case-sensitive",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    issueId: ParamIssueShortId.optional(),
    issueUrl: ParamIssueUrl.optional(),
    tagKey: z
      .string()
      .trim()
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
        "Tag key must contain only alphanumeric characters, dots, hyphens, and underscores, and must start with an alphanumeric character",
      )
      .describe(
        "The tag key to get values for, as listed in the issue's tags (e.g., 'environment', 'release').",
      ),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: getIssueTagValuesOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });

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

    await ensureIssueWithinProjectConstraint({
      apiService,
      organizationSlug: orgSlug,
      issueId: parsedIssueId!,
      projectSlug: context.constraints.projectSlug,
    });

    // Fetch the tag values for the issue
    let tagValues: Awaited<ReturnType<typeof apiService.getIssueTagValues>>;
    try {
      tagValues = await apiService.getIssueTagValues({
        organizationSlug: orgSlug,
        issueId: parsedIssueId!,
        tagKey: params.tagKey,
      });
    } catch (error) {
      if (error instanceof ApiNotFoundError) {
        throw await explainTagValuesNotFound({
          apiService,
          organizationSlug: orgSlug,
          issueId: parsedIssueId!,
          tagKey: params.tagKey,
          error,
        });
      }
      throw error;
    }

    return structuredResult({
      tag: {
        key: tagValues.key,
        name: tagValues.name,
        totalValues: tagValues.totalValues,
        topValues: tagValues.topValues.map((tagValue) => ({
          value: tagValue.value,
          count: tagValue.count,
          firstSeen: tagValue.firstSeen ?? null,
          lastSeen: tagValue.lastSeen ?? null,
        })),
      },
    });
  },
});

/** Keys to list when a tag key is not on the issue; issues can have hundreds. */
const MAX_LISTED_TAG_KEYS = 30;

/**
 * Sentry answers the tag values endpoint with the same 404 whether the issue
 * or the tag key is missing. List the issue's tag keys to tell them apart, and
 * name the keys the issue has when the requested one is not among them.
 */
async function explainTagValuesNotFound({
  apiService,
  organizationSlug,
  issueId,
  tagKey,
  error,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  issueId: string;
  tagKey: string;
  error: ApiNotFoundError;
}): Promise<Error> {
  const originalError = () =>
    enhanceNotFoundError(error, { organizationSlug, issueId, tagKey });

  let tags: IssueTagKeyList;
  try {
    tags = await apiService.listIssueTags({ organizationSlug, issueId });
  } catch (listError) {
    if (listError instanceof ApiNotFoundError) {
      return enhanceNotFoundError(listError, { organizationSlug, issueId });
    }
    // The list only refines the 404, so a failed list (rate limit, server
    // error, unexpected body) must not replace it with a worse error.
    if (
      !(listError instanceof ApiClientError) &&
      !(listError instanceof ConfigurationError)
    ) {
      logIssue(listError, {
        loggerScope: ["tools", "get-issue-tag-values", "list-tags"],
        contexts: { request: { organizationSlug, issueId } },
      });
    }
    return originalError();
  }

  // Sentry also 404s for a listed key whose values are all empty.
  if (tags.some((tag) => tag.key === tagKey)) {
    return originalError();
  }

  const notFound = `Tag ${inlineCode(tagKey)} not found on this issue.`;
  if (tags.length === 0) {
    return new UserInputError(`${notFound} The issue has no tags.`);
  }
  const keys = [...tags]
    .sort(
      (a, b) =>
        (b.totalValues ?? 0) - (a.totalValues ?? 0) ||
        a.key.localeCompare(b.key),
    )
    .slice(0, MAX_LISTED_TAG_KEYS)
    .map((tag) => inlineCode(tag.key));
  const more =
    tags.length > keys.length ? ` (and ${tags.length - keys.length} more)` : "";
  return new UserInputError(
    `${notFound} Available keys: ${keys.join(", ")}${more}.`,
  );
}
