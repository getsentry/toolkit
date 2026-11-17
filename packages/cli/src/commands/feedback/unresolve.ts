/**
 * Reopen modern User Feedback through the Issues API after checking its category.
 */

import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { formatReopenedFeedback } from "../../lib/formatters/feedback.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { disableResponseCache } from "../../lib/response-cache.js";
import { type FeedbackTarget, feedbackPositional } from "./positional.js";
import { updateFeedbackStatus } from "./utils.js";
import { SentryFeedbackSchema } from "../../generated/output-schemas/feedback.js";

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
        run: "feedback unresolve FRONTEND-2SDJ",
      },
      {
        description: "Reopen by numeric ID",
        run: "feedback unresolve 5146636313",
      },
      {
        description: "`reopen` is an alias for `unresolve`",
        run: "feedback reopen FRONTEND-2SDJ",
      },
      {
        description: "Specify an organization explicitly",
        run: "feedback unresolve my-org/FRONTEND-2SDJ",
      },
      {
        description: "Return selected fields from the updated Feedback",
        run: "feedback unresolve FRONTEND-2SDJ --json --fields id,shortId,status",
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
    yield new CommandOutput(
      await updateFeedbackStatus(await target.resolved, "unresolved"),
    );
  },
});
