/**
 * Feedback Command
 *
 * Allows users to submit feedback about the CLI.
 * All arguments after 'feedback' are joined into a single message.
 *
 * @example sentry cli feedback i love this tool
 * @example sentry cli feedback the issue view is confusing
 */

import { isatty } from "node:tty";
// biome-ignore lint/performance/noNamespaceImport: Sentry SDK recommends namespace import
import * as Sentry from "@sentry/node-core/light";
import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { ConfigError, ValidationError } from "../../lib/errors.js";
import { formatFeedbackResult } from "../../lib/formatters/human.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";

/** Structured result of the feedback submission */
export type FeedbackResult = {
  /** Whether the feedback was successfully sent */
  sent: boolean;
  /** The submitted message */
  message: string;
};

export const feedbackCommand = buildCommand({
  auth: false,
  docs: {
    brief: "Send feedback about the CLI",
    fullDescription:
      "Submit feedback about your experience with the Sentry CLI. " +
      "All text after 'feedback' is sent as your message.",
  },
  output: { human: formatFeedbackResult },
  parameters: {
    flags: {},
    positional: {
      kind: "array",
      parameter: {
        brief: "Your feedback message",
        parse: String,
        placeholder: "message",
      },
    },
  },
  async *func(
    this: SentryContext,
    // biome-ignore lint/complexity/noBannedTypes: Stricli requires empty object for commands with no flags
    _flags: {},
    ...messageParts: string[]
  ) {
    let message = messageParts.join(" ").trim();

    if (!message) {
      if (!isatty(0)) {
        throw new ValidationError("Please provide a feedback message.");
      }
      const response = await logger.prompt("Enter your feedback message:", {
        type: "text",
        placeholder: "e.g. I love this tool!",
      });
      if (typeof response !== "string" || !response.trim()) {
        throw new ValidationError("Please provide a feedback message.");
      }
      message = response.trim();
    }

    if (!Sentry.isEnabled()) {
      throw new ConfigError(
        "Feedback not sent: telemetry is disabled.",
        "Unset SENTRY_CLI_NO_TELEMETRY to enable feedback."
      );
    }

    const { getUserInfo } = await import("../../lib/db/user.js");
    const user = getUserInfo();
    Sentry.captureFeedback({
      message,
      email: user?.email,
      name: user?.name ?? user?.username,
    });

    // Flush to ensure feedback is sent before process exits
    const sent = await Sentry.flush(3000);

    yield new CommandOutput({
      sent,
      message,
    });
    return;
  },
});
