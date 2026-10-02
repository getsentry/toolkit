import { z } from "zod";
import { ApiNotFoundError } from "../../api-client";
import { UserInputError } from "../../errors";
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
    "Common tag keys:",
    "- `url`: Request URLs affected by the issue",
    "- `browser`: Browser types and versions",
    "- `browser.name`: Browser names only",
    "- `os`: Operating systems",
    "- `environment`: Deployment environments (production, staging, etc.)",
    "- `release`: Software releases",
    "- `device`: Device types",
    "- `user`: Affected users",
    "",
    "<examples>",
    "### Get URL distribution for an issue",
    "```",
    "get_issue_tag_values(organizationSlug='my-organization', issueId='PROJECT-123', tagKey='url')",
    "```",
    "",
    "### Get browser distribution using issue URL",
    "```",
    "get_issue_tag_values(issueUrl='https://sentry.io/issues/PROJECT-123/', tagKey='browser')",
    "```",
    "",
    "### Get environment distribution",
    "```",
    "get_issue_tag_values(organizationSlug='my-organization', issueId='PROJECT-123', tagKey='environment')",
    "```",
    "</examples>",
    "",
    "<hints>",
    "- If user provides a Sentry URL, pass the ENTIRE URL to issueUrl parameter unchanged",
    "- Common tag keys: url, browser, browser.name, os, environment, release, device, user",
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
        "The tag key to get values for (e.g., 'url', 'browser', 'environment', 'release').",
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

    if (!params.tagKey) {
      throw new UserInputError(
        "`tagKey` is required. Common values: url, browser, environment, release, os, device, user",
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
        throw enhanceNotFoundError(error, {
          organizationSlug: orgSlug,
          issueId: parsedIssueId,
          tagKey: params.tagKey,
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
