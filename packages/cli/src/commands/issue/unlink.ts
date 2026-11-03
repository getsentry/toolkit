/** Remove an external issue association without deleting the external issue. */

import type { SentryContext } from "../../context.js";
import { formatIssueLinkResult } from "../../lib/formatters/issue-links.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { unlinkExternalIssue } from "../../lib/issue-links.js";
import {
  buildDeleteCommand,
  confirmByTyping,
  isConfirmationBypassed,
} from "../../lib/mutate-command.js";
import {
  EXTERNAL_ISSUE_FLAGS,
  externalIssuePositionals,
} from "./link-utils.js";
import { type IssueTarget, requireIssueArgument } from "./positional.js";
import { resolveOrgAndIssueId } from "./utils.js";

type UnlinkFlags = {
  readonly integration?: string;
  readonly app?: string;
  readonly "dry-run": boolean;
  readonly yes: boolean;
  readonly force: boolean;
};

export const unlinkCommand = buildDeleteCommand({
  docs: {
    brief: "Unlink an external issue",
    fullDescription:
      "Remove an external tracker issue or GitHub pull request reference from a Sentry issue.\n" +
      "This does not delete the external issue or change the Sentry issue's status.\n\n" +
      "Requires event:write and access to the Sentry project.\n" +
      "Older Sentry versions may still require event:admin.",
    examples: [
      {
        description: "Unlink a GitHub issue (prompts for confirmation)",
        command:
          "sentry issue unlink FRONT-123 https://github.com/example/app/issues/42",
      },
      {
        description: "Unlink a GitHub pull request without prompting",
        command:
          "sentry issue unlink FRONT-123 https://github.com/example/app/pull/43 --yes",
      },
      {
        description: "Unlink a Jira issue in an explicit organization",
        command:
          "sentry issue unlink my-org/FRONT-123 https://example.atlassian.net/browse/APP-42 --yes",
      },
      {
        description: "Check whether a link exists without removing it",
        command:
          "sentry issue unlink FRONT-123 https://linear.app/example/issue/APP-42/fix-error --dry-run",
      },
    ],
  },
  output: { human: formatIssueLinkResult },
  parameters: {
    positional: externalIssuePositionals("unlink"),
    flags: EXTERNAL_ISSUE_FLAGS,
  },
  async *func(
    this: SentryContext,
    flags: UnlinkFlags,
    target: IssueTarget,
    url: string,
  ) {
    const issueArg = requireIssueArgument(target.parsed, { command: "unlink" });
    const { org, issueId } = await resolveOrgAndIssueId({
      issueArg,
      cwd: this.cwd,
      command: "unlink",
    });
    if (!(flags["dry-run"] || isConfirmationBypassed(flags))) {
      const confirmed = await confirmByTyping(
        issueArg.text,
        `Type '${issueArg.text}' to unlink ${url}:`,
      );
      if (!confirmed) {
        return { hint: "Cancelled." };
      }
    }
    const result = await unlinkExternalIssue({
      orgSlug: org,
      issueId,
      url,
      integrationId: flags.integration,
      appSlug: flags.app,
      dryRun: flags["dry-run"],
    });
    yield new CommandOutput(result);
  },
});
