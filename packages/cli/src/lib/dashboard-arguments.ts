/**
 * Dashboard positionals.
 *
 * A command that takes one dashboard parses it like any ID argument, with
 * `parseIdArguments()` and `ID_KINDS.dashboard` (`id-arguments.ts`): a
 * numeric ID, or a title, which is the kind's name. Titles may hold spaces
 * and slashes, and after a target, the rest of the arguments are one title
 * (`my-org My Dashboard`). This module adds what is particular to
 * dashboards: the messages for a missing dashboard and for a pasted URL.
 *
 * `dashboard list` takes a target and a title filter instead, with its own
 * reading of one argument (`<org>/<project>/<filter>`, and a bare word is a
 * filter), so {@link parseDashboardListArgs} parses it here.
 *
 * Parsing has no side effects: a pasted URL's server comes back as
 * `baseUrl` and anything to tell the user as `warnings`, for the caller to
 * apply.
 */

import { ValidationError } from "./errors.js";
import { ID_KINDS, parseIdArguments } from "./id-arguments.js";
import { type ParsedSentryUrl, parseSentryUrl } from "./sentry-url-parser.js";

/** Dashboard arguments, parsed. */
export type DashboardArgs = {
  /** The numeric ID or title, as typed */
  readonly dashboardRef: string;
  /** The org/project target; `undefined` to auto-detect */
  readonly targetArg?: string;
  /** Server of a pasted Sentry URL, for `applySentryUrlContext` */
  readonly baseUrl?: string;
  /** Warnings to log, such as for an ID taken from a URL */
  readonly warnings: readonly string[];
  /**
   * When the first argument was a bare word before a title (`My
   * Dashboard`), the word and the whole input as one title: the word names
   * an org only if there is one
   */
  readonly orgOrTitle?: { readonly org: string; readonly title: string };
};

/**
 * Parse the arguments of a command that takes one dashboard:
 * `[<org/project>] <id-or-title...>`, `<org>/[<project>/]<id>`, or a Sentry
 * URL (see `grammar/id-arguments.pegjs`). After a target, the remaining
 * arguments are one title: `my-org/ My Dashboard` names "My Dashboard";
 * after a numeric ID, they are extra.
 *
 * @param usageHint - Usage shown when arguments are ignored
 * @throws {ValidationError} When no dashboard is given
 */
export function parseDashboardArgs(
  args: readonly string[],
  usageHint: string,
): DashboardArgs {
  // Not optional, but a missing dashboard has its own messages below
  const { target, ids, name, nameWithTarget, baseUrl, warnings } =
    parseIdArguments(args, ID_KINDS.dashboard, { usageHint, optional: true });
  const url = pastedUrl(args);
  const ref = ids[0] ?? name;
  if (ref === undefined) {
    if (url?.org) {
      throw new ValidationError(
        "Dashboard ID or title is required.\n\n" +
          "The URL provided contains an org but no dashboard ID.\n" +
          `Try: sentry dashboard <command> ${url.org}/ <id-or-title>`,
        "dashboard",
      );
    }
    throw new ValidationError(
      "Dashboard ID or title is required.",
      "dashboard",
    );
  }
  return {
    dashboardRef: ref,
    // A URL with only an org is the target
    targetArg: url && !url.dashboardId ? `${url.org}/` : target,
    baseUrl: baseUrl ?? url?.baseUrl,
    warnings: url ? [urlWarning(url), ...warnings] : warnings,
    ...(nameWithTarget !== undefined &&
      target !== undefined && {
        orgOrTitle: { org: target.slice(0, -1), title: nameWithTarget },
      }),
  };
}

/** `dashboard list` arguments, parsed. */
export type DashboardListArgs = {
  /** The org/project target; `undefined` to auto-detect */
  readonly targetArg?: string;
  /** Title glob to filter by */
  readonly titleFilter?: string;
  /** Server of a pasted Sentry URL, for `applySentryUrlContext` */
  readonly baseUrl?: string;
  /** Warnings to log, such as for an org taken from a URL */
  readonly warnings: readonly string[];
};

/** `<org>/<project>/<filter>`: the filter is everything after the second slash */
const TARGET_AND_FILTER_RE = /^([^/]*\/[^/]*)\/(.+)$/s;

/**
 * Parse `dashboard list` arguments: an optional target and title filter.
 *
 * - (none): the org is auto-detected, no filter
 * - `<filter>`: one argument without a slash (dashboards are org-scoped, so
 *   a project search would only pick an org)
 * - `<org>/` or `<org>/<project>`: a target, no filter
 * - `<org>/<project>/<filter>`: a target, then the filter
 * - `<target> <filter...>`: the filter's words may be separate arguments,
 *   and a bare `<org>` means `<org>/`
 * - `<org-url> [<filter...>]`: a Sentry URL with only an org
 *
 * @throws {ValidationError} For a dashboard URL, suggesting `dashboard view`
 */
export function parseDashboardListArgs(
  args: readonly (string | undefined)[],
): DashboardListArgs {
  const given = args.filter((arg): arg is string => !!arg);
  if (given.some((arg) => arg.includes("\0"))) {
    throw new ValidationError(
      "Arguments cannot contain NUL characters.",
      "positional",
    );
  }
  const [first, ...rest] = given;
  if (first === undefined) {
    return { warnings: [] };
  }
  const url = sentryUrlParts(first);
  if (url?.dashboardId) {
    const orgPrefix = url.org ? `${url.org}/ ` : "";
    const orgSuffix = url.org ? ` ${url.org}/` : "";
    const orgNote = url.org ? ` in '${url.org}'` : "";
    throw new ValidationError(
      "This looks like a dashboard URL. To view a specific dashboard:\n\n" +
        `  sentry dashboard view ${orgPrefix}${url.dashboardId}\n\n` +
        `To list dashboards${orgNote}:\n\n` +
        `  sentry dashboard list${orgSuffix}`,
      "dashboard",
    );
  }
  if (url?.org) {
    return {
      targetArg: `${url.org}/`,
      ...titleFilter(rest),
      baseUrl: url.baseUrl,
      warnings: [urlWarning(url)],
    };
  }
  if (rest.length > 0) {
    return {
      targetArg: first.includes("/") ? first : `${first}/`,
      ...titleFilter(rest),
      warnings: [],
    };
  }
  const split = TARGET_AND_FILTER_RE.exec(first);
  if (split?.[1] !== undefined && split[2] !== undefined) {
    return { targetArg: split[1], titleFilter: split[2], warnings: [] };
  }
  return first.includes("/")
    ? { targetArg: first, warnings: [] }
    : { titleFilter: first, warnings: [] };
}

function titleFilter(words: readonly string[]): { titleFilter?: string } {
  return words.length > 0 ? { titleFilter: words.join(" ") } : {};
}

/** The parts of a Sentry URL a dashboard argument cares about. */
type DashboardUrl = {
  readonly baseUrl: string;
  readonly org?: string;
  readonly dashboardId?: string;
};

function sentryUrlParts(value: string): DashboardUrl | null {
  const url: ParsedSentryUrl | null = parseSentryUrl(value);
  return (
    url && {
      baseUrl: url.baseUrl,
      ...(url.org && { org: url.org }),
      ...(url.dashboardId && { dashboardId: url.dashboardId }),
    }
  );
}

/**
 * The Sentry URL the arguments start with, when it names a dashboard or an
 * org: what the grammar took the dashboard or the target from.
 */
function pastedUrl(args: readonly string[]): DashboardUrl | null {
  const first = args.find((arg) => arg.trim() !== "")?.trim();
  const url = first === undefined ? null : sentryUrlParts(first);
  return url?.dashboardId || url?.org ? url : null;
}

function urlWarning(url: DashboardUrl): string {
  if (url.dashboardId) {
    return (
      `Extracted dashboard ID ${url.dashboardId} from URL` +
      (url.org ? ` (org: ${url.org})` : "")
    );
  }
  return `Extracted org '${url.org}' from URL`;
}
