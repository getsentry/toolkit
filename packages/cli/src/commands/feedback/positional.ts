/**
 * The positional of Feedback commands: a selector or an issue-style
 * identifier, parsed before the command runs.
 */

import { ORG_PROJECT_TARGET } from "../../lib/completion-target.js";
import { ContextError } from "../../lib/errors.js";
import {
  type IssueArgument,
  parseIssueArgument,
} from "../../lib/issue-arguments.js";
import {
  type BoundPositional,
  boundPositional,
} from "../../lib/positional-parse.js";
import { type ResolvedFeedback, resolveFeedback } from "./utils.js";

/**
 * A parsed Feedback argument that resolves to the Feedback. `parsed` is
 * `undefined` only when the argument was left out (the SDK invoke path).
 */
export type FeedbackTarget = BoundPositional<
  IssueArgument | undefined,
  ResolvedFeedback
>;

/**
 * Positional for a Feedback selector or issue-style identifier. The argument
 * is parsed before the command runs; `target.resolved` resolves it with
 * {@link resolveFeedback}.
 *
 * @param command - The subcommand, for recovery hints
 */
export function feedbackPositional(command: string) {
  return {
    kind: "tuple",
    parameters: [
      {
        placeholder: "feedback",
        brief:
          "Feedback: @latest, numeric ID, short ID, <org>/SHORT-ID, or <org>/<project>/<suffix>",
        parse: boundPositional(
          ORG_PROJECT_TARGET,
          (raw) => (raw === undefined ? undefined : parseIssueArgument(raw)),
          async (feedback, context: { readonly cwd: string }) => {
            if (!feedback) {
              throw new ContextError(
                "Feedback ID",
                `sentry feedback ${command} <feedback>`,
              );
            }
            return await resolveFeedback(feedback, context.cwd, command);
          },
        ),
      },
    ],
  } as const;
}
