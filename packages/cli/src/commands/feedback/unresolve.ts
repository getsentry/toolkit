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
import { feedbackIdPositional, resolveFeedback } from "./utils.js";

export const unresolveCommand = buildCommand({
  docs: {
    brief: "Return User Feedback to the inbox",
    fullDescription:
      "Mark a User Feedback item as unresolved. Reopen resolved Feedback or restore it from spam.\n\n" +
      "Accepts the same IDs and URLs as sentry feedback view. Other issue categories are rejected before any changes are made.\n\n" +
      "Use sentry feedback list --status resolved or --status spam to find Feedback to return to the inbox.\n\n" +
      "Examples:\n" +
      "  sentry feedback unresolve FRONTEND-2SDJ\n" +
      "  sentry feedback reopen FRONTEND-2SDJ\n" +
      "  sentry feedback unresolve my-org/FRONTEND-2SDJ",
  },
  output: {
    human: formatReopenedFeedback,
    schema: SentryFeedbackSchema,
  },
  parameters: {
    positional: feedbackIdPositional,
  },
  async *func(this: SentryContext, _flags, feedbackArg: string) {
    disableResponseCache();
    const { org, feedback } = await resolveFeedback(
      feedbackArg,
      this.cwd,
      "unresolve",
    );
    const updated = await updateIssueStatus(feedback.id, "unresolved", {
      orgSlug: org,
    });

    yield new CommandOutput(updated);
  },
});
