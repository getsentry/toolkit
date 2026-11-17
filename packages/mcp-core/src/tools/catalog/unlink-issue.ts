import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { unlinkExternalIssue } from "../support/issue-linking";
import {
  issueLinkInputSchema,
  issueLinkOutputSchema,
  resolveIssueLinkContext,
} from "../support/issue-linking/tool";

export default defineTool({
  name: "unlink_issue",
  title: "Unlink Issue",
  skills: ["triage"],
  requiredScopes: ["event:write", "org:read"],
  description:
    "Remove a linked external ticket or GitHub pull request from a Sentry issue by URL. Deletes only the association, not the ticket or the issue; safe to repeat.",
  inputSchema: issueLinkInputSchema,
  outputSchema: issueLinkOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(params, context) {
    const { apiService, organizationSlug, issue } =
      await resolveIssueLinkContext(params, context);
    const { status, ...externalIssue } = await unlinkExternalIssue(apiService, {
      ...params,
      organizationSlug,
      issueId: String(issue.id),
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
