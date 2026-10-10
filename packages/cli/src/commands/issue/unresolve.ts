/**
 * sentry issue unresolve (aliased: reopen)
 *
 * Move an issue back to the "unresolved" state. Inverse of `issue resolve`.
 */

import type { SentryContext } from "../../context.js";
import { updateIssueStatus } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { formatIssueDetails, muted } from "../../lib/formatters/index.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";
import type { SentryIssue } from "../../types/index.js";
import { issueIdPositional, resolveIssue } from "./utils.js";

const log = logger.withTag("issue.unresolve");

const COMMAND = "unresolve";

type UnresolveFlags = {
  readonly json: boolean;
  readonly fields?: string[];
};

function formatUnresolved(issue: SentryIssue): string {
  return `${muted("Reopened")}\n\n${formatIssueDetails(issue)}`;
}

export const unresolveCommand = buildCommand({
  docs: {
    brief: "Reopen a resolved issue",
    fullDescription:
      "Mark an issue as unresolved. Inverse of `sentry issue resolve`.\n\n" +
      "Examples:\n" +
      "  sentry issue unresolve CLI-12Z\n" +
      "  sentry issue reopen CLI-12Z\n" +
      "  sentry issue unresolve my-org/CLI-AB",
  },
  output: {
    human: formatUnresolved,
  },
  parameters: {
    positional: issueIdPositional,
  },
  async *func(this: SentryContext, _flags: UnresolveFlags, issueArg: string) {
    const { cwd } = this;

    const { org, issue } = await resolveIssue({
      issueArg,
      cwd,
      command: COMMAND,
    });

    const updated = await updateIssueStatus(issue.id, "unresolved", {
      orgSlug: org,
    });

    log.debug(`Reopened ${updated.shortId}`);
    yield new CommandOutput<SentryIssue>(updated);
  },
});
