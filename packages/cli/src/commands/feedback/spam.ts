/**
 * Move modern User Feedback to spam through the Issues API after checking its category.
 */

import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { formatSpamFeedback } from "../../lib/formatters/feedback.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { disableResponseCache } from "../../lib/response-cache.js";
import { type FeedbackTarget, feedbackPositional } from "./positional.js";
import { updateFeedbackStatus } from "./utils.js";
import { SentryFeedbackSchema } from "../../generated/output-schemas/feedback.js";

export const spamCommand = buildCommand({
  docs: {
    brief: "Mark User Feedback as spam",
    fullDescription:
      "Move a User Feedback item to the spam mailbox.\n\n" +
      "Accepts the same IDs and URLs as sentry feedback view. Other issue categories are rejected before any changes are made.\n\n" +
      "Sentry stores spam Feedback with status ignored. Use sentry feedback unresolve <feedback> to return it to the unresolved inbox.",
    examples: [
      {
        description: "Move a Feedback item to the spam mailbox",
        run: "feedback spam FRONTEND-2SDJ",
      },
      {
        description: "Mark as spam by numeric ID",
        run: "feedback spam 5146636313",
      },
      {
        description: "Specify an organization explicitly",
        run: "feedback spam my-org/FRONTEND-2SDJ",
      },
      {
        description: "Return selected fields from the updated Feedback",
        run: "feedback spam FRONTEND-2SDJ --json --fields id,shortId,status",
      },
    ],
  },
  output: {
    human: formatSpamFeedback,
    schema: SentryFeedbackSchema,
  },
  parameters: {
    positional: feedbackPositional("spam"),
  },
  async *func(this: SentryContext, _flags, target: FeedbackTarget) {
    disableResponseCache();
    yield new CommandOutput(
      await updateFeedbackStatus(await target.resolved, "ignored"),
    );
  },
});
