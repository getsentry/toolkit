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
  skills: ["triage"],
  requiredScopes: ["event:write", "org:read"],
  description: [
    "Remove an external ticket or GitHub pull request reference from a Sentry issue by URL.",
    "Removes only the Sentry association. It does not delete the external ticket or the Sentry issue, or change resolution status.",
    "Supports native integrations and installed Sentry Apps. Repeating the request is safe: not_linked means the association is absent, whether removed by this call or already absent.",
    "<examples>",
    "unlink_issue(organizationSlug='my-org', issueId='PROJECT-123', externalIssueUrl='https://github.com/example/repo/issues/42')",
    "</examples>",
  ].join("\n"),
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
