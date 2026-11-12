/**
 * Resolve modern User Feedback through the Issues API after checking its category.
 */

import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { formatResolvedFeedback } from "../../lib/formatters/feedback.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { disableResponseCache } from "../../lib/response-cache.js";
import { type FeedbackTarget, feedbackPositional } from "./positional.js";
import { updateFeedbackStatus } from "./utils.js";
import { SentryFeedbackSchema } from "../../generated/output-schemas/feedback.js";

export const resolveCommand = buildCommand({
  docs: {
    brief: "Mark User Feedback as resolved",
    fullDescription:
      "Resolve a User Feedback item immediately.\n\n" +
      "Accepts the same IDs and URLs as sentry feedback view. Use @latest to resolve the most recently active unresolved Feedback.\n\n" +
      "The resolved issue must have issue.category:feedback. Other issue categories are rejected before any changes are made.",
    examples: [
      {
        description: "Resolve a Feedback item (organization auto-detected)",
        run: "feedback resolve FRONTEND-2SDJ",
      },
      {
        description: "Resolve a Feedback item in an explicit organization",
        run: "feedback resolve my-org/FRONTEND-2SDJ",
      },
      {
        description: "Resolve the most recently active unresolved Feedback",
        run: "feedback resolve my-org/@latest",
      },
      {
        description: "Return selected fields from the updated Feedback",
        run: "feedback resolve my-org/FRONTEND-2SDJ --json --fields id,shortId,status",
      },
    ],
  },
  output: {
    human: formatResolvedFeedback,
    schema: SentryFeedbackSchema,
  },
  parameters: {
    positional: feedbackPositional("resolve"),
  },
  async *func(this: SentryContext, _flags, target: FeedbackTarget) {
    // A cached inbox could select Feedback that has already been resolved elsewhere.
    disableResponseCache();
    yield new CommandOutput(
      await updateFeedbackStatus(await target.resolved, "resolved"),
    );
  },
});
