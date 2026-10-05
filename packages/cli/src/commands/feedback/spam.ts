/**
 * Move modern User Feedback to spam through the Issues API after checking its category.
 */

import type { SentryContext } from "../../context.js";
import { updateIssueStatus } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { formatSpamFeedback } from "../../lib/formatters/feedback.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { disableResponseCache } from "../../lib/response-cache.js";
import { SentryFeedbackSchema } from "../../types/index.js";
import { feedbackIdPositional, resolveFeedback } from "./utils.js";

export const spamCommand = buildCommand({
  docs: {
    brief: "Mark User Feedback as spam",
    fullDescription:
      "Move a User Feedback item to the spam mailbox.\n\n" +
      "Accepts the same IDs and URLs as sentry feedback view. Other issue categories are rejected before any changes are made.\n\n" +
      "Sentry stores spam Feedback with status ignored. Use sentry feedback unresolve <feedback> to return it to the unresolved inbox.\n\n" +
      "Examples:\n" +
      "  sentry feedback spam FRONTEND-2SDJ\n" +
      "  sentry feedback spam my-org/FRONTEND-2SDJ\n" +
      "  sentry feedback list --status spam\n" +
      "  sentry feedback unresolve FRONTEND-2SDJ",
  },
  output: {
    human: formatSpamFeedback,
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
      "spam"
    );
    const updated = await updateIssueStatus(feedback.id, "ignored", {
      orgSlug: org,
    });

    yield new CommandOutput(updated);
  },
});
