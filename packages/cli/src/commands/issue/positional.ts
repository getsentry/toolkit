/**
 * Positionals that name one issue.
 *
 * The argument is parsed (`parseIssueArgument`) before the command runs, so
 * a malformed one fails like any other argument. `target.resolved` finds the
 * issue with `resolveIssue`, inside `func` after the auth guard; that is
 * also where the server of a pasted issue URL is applied. See
 * `positional-parse.ts`.
 */

import { ISSUE_TARGET } from "../../lib/completion-target.js";
import { ContextError } from "../../lib/errors.js";
import {
  type IssueArgument,
  parseIssueArgument,
} from "../../lib/issue-arguments.js";
import {
  type BoundPositional,
  boundPositional,
} from "../../lib/positional-parse.js";
import { type ResolvedIssueResult, resolveIssue } from "./utils.js";

/**
 * A parsed issue argument that resolves to the issue. `parsed` is
 * `undefined` only when the argument was left out, such as by a plural
 * alias the command intercepted.
 */
export type IssueTarget = BoundPositional<
  IssueArgument | undefined,
  ResolvedIssueResult
>;

/** How the command is named in recovery hints. */
type IssueCommand = {
  /** The subcommand, e.g. `"view"` */
  readonly command: string;
  /** The command before it (default: `"sentry issue"`) */
  readonly commandBase?: string;
};

/** What the issue resolver needs from the command context. */
type IssueTargetContext = { readonly cwd: string };

/** Brief of an issue positional, listing the forms it takes. */
const ISSUE_POSITIONAL_BRIEF =
  "Issue: @latest, @most_frequent, <org>/ID, <org>/<project>#ID, <project>-suffix, ID, or suffix";

function parseIssueTargetInput(raw: string | undefined) {
  return raw === undefined ? undefined : parseIssueArgument(raw);
}

/**
 * An issue target's parsed argument (`target.parsed`), for a command that
 * resolves the issue itself, with recovery hints `target.resolved` cannot
 * know (such as its other arguments).
 *
 * @throws {ContextError} When the argument was left out
 */
export function requireIssueArgument(
  issue: IssueArgument | undefined,
  issueCommand: IssueCommand,
): IssueArgument {
  if (issue) {
    return issue;
  }
  const { command, commandBase = "sentry issue" } = issueCommand;
  throw new ContextError("Issue ID", `${commandBase} ${command} <issue>`);
}

/**
 * Positional parser for one issue, bound to {@link resolveIssue}.
 *
 * @param issueCommand - The command, for recovery hints
 */
function issueTarget(
  issueCommand: IssueCommand,
): (this: IssueTargetContext, input?: string) => IssueTarget {
  const { command, commandBase = "sentry issue" } = issueCommand;
  return boundPositional(
    ISSUE_TARGET,
    parseIssueTargetInput,
    async (issue, context: IssueTargetContext) =>
      await resolveIssue({
        issueArg: requireIssueArgument(issue, issueCommand),
        cwd: context.cwd,
        command,
        commandBase,
      }),
  );
}

/** The `<issue>` parameter of a tuple positional, for {@link issueTarget}. */
export function issueParameter(issueCommand: IssueCommand) {
  return {
    placeholder: "issue",
    brief: ISSUE_POSITIONAL_BRIEF,
    parse: issueTarget(issueCommand),
  } as const;
}

/** A positional that takes one issue. */
export function issuePositional(issueCommand: IssueCommand) {
  return {
    kind: "tuple",
    parameters: [issueParameter(issueCommand)],
  } as const;
}
