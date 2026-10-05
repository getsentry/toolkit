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
  skills: ["triage"],
  requiredScopes: ["event:write", "org:read"],
  description: [
    "Link an existing external ticket or GitHub pull request to a Sentry issue by URL.",
    "Supports native Jira, GitHub/GitHub Enterprise, GitLab, Bitbucket, and Azure DevOps integrations, and installed Sentry Apps whose issue-link forms use single-value select or text fields.",
    "Creates a reference: it does not create a ticket, resolve the Sentry issue, or associate a commit. Use update_issue separately to change status or assignment.",
    "A repeated link returns already_linked. A different App association must be unlinked first.",
    "For Apps, copy the canonical issue URL from the provider. Supply fields only when the installed App requires additional form values.",
    "<examples>",
    "link_issue(organizationSlug='my-org', issueId='PROJECT-123', externalIssueUrl='https://github.com/example/repo/pull/42')",
    "link_issue(issueUrl='https://my-org.sentry.io/issues/123/', externalIssueUrl='https://linear.app/example/issue/ENG-42/fix-crash')",
    "</examples>",
  ].join("\n"),
  inputSchema: {
    ...issueLinkInputSchema,
    fields: z
      .record(z.string(), z.union([z.string(), z.number()]))
      .optional()
      .describe(
        "Additional App form values by field name; required fields are reported when missing.",
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
