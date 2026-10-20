/**
 * Resolve modern User Feedback through the Issues API after checking its category.
 */

import type { SentryContext } from "../../context.js";
import { updateIssueStatus } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { formatResolvedFeedback } from "../../lib/formatters/feedback.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { disableResponseCache } from "../../lib/response-cache.js";
import { SentryFeedbackSchema } from "../../types/index.js";
import { feedbackIdPositional, resolveFeedback } from "./utils.js";

export const resolveCommand = buildCommand({
  docs: {
    brief: "Mark User Feedback as resolved",
    fullDescription:
      "Resolve a User Feedback item immediately.\n\n" +
      "Accepts the same IDs and URLs as sentry feedback view. Use @latest to resolve the most recently active unresolved Feedback.\n\n" +
      "The resolved issue must have issue.category:feedback. Other issue categories are rejected before any changes are made.\n\n" +
      "Examples:\n" +
      "  sentry feedback resolve FRONTEND-2SDJ\n" +
      "  sentry feedback resolve my-org/FRONTEND-2SDJ\n" +
      "  sentry feedback resolve my-org/@latest",
  },
  output: {
    human: formatResolvedFeedback,
    schema: SentryFeedbackSchema,
  },
  parameters: {
    positional: feedbackIdPositional,
  },
  async *func(this: SentryContext, _flags, feedbackArg: string) {
    // A cached inbox could select Feedback that has already been resolved elsewhere.
    disableResponseCache();
    const { org, feedback } = await resolveFeedback(
      feedbackArg,
      this.cwd,
      "resolve",
    );
    const updated = await updateIssueStatus(feedback.id, "resolved", {
      orgSlug: org,
    });

    yield new CommandOutput(updated);
  },
});
