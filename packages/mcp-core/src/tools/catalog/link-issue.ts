import { z } from "zod";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { linkExternalIssue } from "../support/issue-linking";
import {
  issueLinkInputSchema,
  issueLinkOutputSchema,
  resolveIssueLinkContext,
} from "../support/issue-linking/tool";

export default defineTool({
  name: "link_issue",
  title: "Link Issue",
  skills: ["triage"],
  requiredScopes: ["event:write", "org:read"],
  description:
    "Link an existing external ticket or GitHub pull request to a Sentry issue by URL: Jira, GitHub, GitLab, Bitbucket, Azure DevOps, or an installed Sentry App such as Linear. Adds a reference only; it does not create the ticket or change the issue status (use update_issue).",
  inputSchema: {
    ...issueLinkInputSchema,
    fields: z
      .record(z.string(), z.union([z.string(), z.number()]))
      .optional()
      .describe(
        "Extra form values by field name, for a Sentry App that requires them.",
      ),
  },
  outputSchema: issueLinkOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(params, context) {
    const { apiService, organizationSlug, issue } =
      await resolveIssueLinkContext(params, context);
    const { status, ...externalIssue } = await linkExternalIssue(apiService, {
      ...params,
      organizationSlug,
      issueId: String(issue.id),
      projectId: String(issue.project.id),
    });
    return structuredResult({
      organizationSlug,
      issueId: issue.shortId,
      issueUrl: apiService.getIssueUrl(organizationSlug, issue.shortId),
      externalIssue,
      status,
    });
  },
});
