/**
 * Reopen modern User Feedback through the Issues API after checking its category.
 */

import type { SentryContext } from "../../context.js";
import { updateIssueStatus } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { formatReopenedFeedback } from "../../lib/formatters/feedback.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { disableResponseCache } from "../../lib/response-cache.js";
import { SentryFeedbackSchema } from "../../types/index.js";
import { type FeedbackTarget, feedbackPositional } from "./positional.js";

export const unresolveCommand = buildCommand({
  docs: {
    brief: "Return User Feedback to the inbox",
    fullDescription:
      "Mark a User Feedback item as unresolved. Reopen resolved Feedback or restore it from spam.\n\n" +
      "Accepts the same IDs and URLs as sentry feedback view. Other issue categories are rejected before any changes are made.\n\n" +
      "Use sentry feedback list --status resolved or --status spam to find Feedback to return to the inbox.",
    examples: [
      {
        description:
          "Reopen a Feedback item, or return it from spam to the inbox",
        command: "sentry feedback unresolve FRONTEND-2SDJ",
      },
      {
        description: "Reopen by numeric ID",
        command: "sentry feedback unresolve 5146636313",
      },
      {
        description: "`reopen` is an alias for `unresolve`",
        command: "sentry feedback reopen FRONTEND-2SDJ",
      },
      {
        description: "Specify an organization explicitly",
        command: "sentry feedback unresolve my-org/FRONTEND-2SDJ",
      },
      {
        description: "Return selected fields from the updated Feedback",
        command:
          "sentry feedback unresolve FRONTEND-2SDJ --json --fields id,shortId,status",
      },
    ],
  },
  output: {
    human: formatReopenedFeedback,
    schema: SentryFeedbackSchema,
  },
  parameters: {
    positional: feedbackPositional("unresolve"),
  },
  async *func(this: SentryContext, _flags, target: FeedbackTarget) {
    disableResponseCache();
    const { org, feedback } = await target.resolved;
    const updated = await updateIssueStatus(feedback.id, "unresolved", {
      orgSlug: org,
    });

    yield new CommandOutput(updated);
  },
});
