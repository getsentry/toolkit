/**
 * Issue arguments: the issue ID, short ID, selector, URL, or search text
 * that `issue view`, `issue explain`, and every other issue command takes.
 *
 * An argument is parsed like any ID argument, by `parseIdArguments()` with
 * `ID_KINDS.issue` (`id-arguments.ts`): an issue identifier is one whole
 * token, which `issue-identifier.ts` takes apart, and anything that cannot
 * be one (text with spaces) is a name, which the command searches issues
 * for.
 */

import { firstNonBlankLine } from "./arg-parsing.js";
import { ValidationError } from "./errors.js";
import { ID_KINDS, parseIdArguments } from "./id-arguments.js";
import {
  type ParsedIssueArg,
  parseIssueIdentifier,
} from "./issue-identifier.js";
import { applySentryUrlContext } from "./sentry-url-parser.js";

export type { ParsedIssueArg } from "./issue-identifier.js";

/** An issue argument, parsed. */
export type IssueArgument = {
  /** The argument as typed, for recovery hints */
  readonly text: string;
  readonly parsed: ParsedIssueArg;
  /** Server of a pasted Sentry URL, for `applySentryUrlContext` */
  readonly baseUrl?: string;
};

/**
 * Parse an issue argument, without side effects: the server of a pasted
 * Sentry URL is returned as `baseUrl` instead of applied.
 *
 * Only the first non-blank line counts. Multi-line input (command
 * substitution that captured extra output, an identifier with a note, or
 * several newline-separated IDs) would otherwise reach `validateResourceId`
 * and fail with a cryptic "contains a newline" (CLI-1G1). An issue
 * identifier is one token, so joining the lines would make garbage.
 *
 * Text that cannot be an identifier, because it has spaces, is a search:
 * `{ type: "search", query }`.
 *
 * @throws {ValidationError} When the argument is empty or a malformed
 *   identifier, or a Sentry URL has no issue in it
 *
 * @example
 * parseIssueArgument("cli-G").parsed          // { type: "project-search", projectSlug: "cli", suffix: "G" }
 * parseIssueArgument("login timeout").parsed  // { type: "search", query: "login timeout" }
 */
export function parseIssueArgument(arg: string): IssueArgument {
  const input = firstNonBlankLine(arg);
  if (!input) {
    throw new ValidationError(
      "Issue identifier is empty after trimming whitespace.",
      "issue identifier",
    );
  }
  // One token: an identifier (validated below, for its own messages) or a
  // name
  const { ids, name } = parseIdArguments([input], ID_KINDS.issue, {
    usageHint: "sentry issue <command> <issue>",
    validate: false,
  });
  if (name !== undefined) {
    return { text: arg, parsed: { type: "search", query: name } };
  }
  const { parsed, baseUrl } = parseIssueIdentifier(ids[0] ?? input);
  return { text: arg, parsed, ...(baseUrl && { baseUrl }) };
}

/**
 * Parse an issue argument like {@link parseIssueArgument}, and apply the
 * server of a pasted Sentry URL.
 *
 * @throws {ValidationError} When the argument is malformed
 */
export function parseIssueArg(arg: string): ParsedIssueArg {
  const { parsed, baseUrl } = parseIssueArgument(arg);
  if (baseUrl) {
    applySentryUrlContext(baseUrl);
  }
  return parsed;
}
