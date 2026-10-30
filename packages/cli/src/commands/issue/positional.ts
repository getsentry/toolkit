/**
 * Positionals that name issues: one, or several.
 *
 * The arguments are parsed (`parseIssueArgument`, `parseIssueArguments`)
 * before the command runs, so a malformed one fails like any other
 * argument. For one issue, `target.resolved` finds it with `resolveIssue`,
 * inside `func` after the auth guard; that is also where the server of a
 * pasted issue URL is applied. See `positional-parse.ts`.
 */

import { ContextError } from "../../lib/errors.js";
import {
  type IssueArgument,
  parseIssueArgument,
  parseIssueArguments,
} from "../../lib/issue-arguments.js";
import {
  type BoundArguments,
  type BoundPositional,
  boundArguments,
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
    "issue",
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

/**
 * Several issues, parsed. `issues.resolved` gives them back unresolved:
 * each command resolves them itself (`resolveIssue`, which also applies the
 * server of a pasted issue URL), because each handles an issue it cannot
 * find its own way (a warning in `issue view`, an error in `issue merge`).
 */
export type IssuesArguments = BoundArguments<
  readonly IssueArgument[],
  readonly IssueArgument[]
>;

/**
 * A positional that takes several issues (`<issue>...`), each in any form
 * {@link issuePositional} takes, except search text: every
 * whitespace-separated word is an issue (see `parseIssueArguments`).
 *
 * @param options.brief - The positional's help text
 * @param options.usageHint - Usage shown when no issue is given
 * @param options.distinct - Whether to drop repeated issues, keeping the
 *   first of each
 * @param options.optional - Whether the command may get none, to report
 *   the count itself
 */
export function issuesPositional(options: {
  readonly brief: string;
  readonly usageHint: string;
  readonly distinct?: boolean;
  readonly optional?: boolean;
}) {
  const { brief, usageHint, distinct = false, optional = false } = options;
  return boundArguments({
    placeholder: "issue",
    brief,
    kind: "issue",
    parse: (raw): readonly IssueArgument[] => {
      const issues = parseIssueArguments(raw, { usageHint, optional });
      if (!distinct) {
        return issues;
      }
      const seen = new Set<string>();
      return issues.filter(({ text }) => {
        if (seen.has(text)) {
          return false;
        }
        seen.add(text);
        return true;
      });
    },
    resolve: (issues: readonly IssueArgument[]) => Promise.resolve(issues),
  });
}
