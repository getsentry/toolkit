/**
 * Dashboard positionals, parsed by `grammar/dashboard-arguments.pegjs`.
 *
 * Dashboards are org-scoped and named by a numeric ID or a title, which may
 * hold spaces and slashes. That is a different syntax from the hex IDs of
 * `id-arguments.ts`, so dashboards have their own grammar, but follow the
 * same conventions: the result is a `targetArg` for `parseOrgProjectInput`,
 * and parsing has no side effects. A pasted URL's server comes back as
 * `baseUrl` and anything to tell the user as `warnings`, for the caller to
 * apply.
 */

import {
  type DashboardUrl,
  parse,
} from "../generated/dashboard-arguments-grammar.js";
import { ValidationError } from "./errors.js";
import { parseSentryUrl } from "./sentry-url-parser.js";

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
};

/**
 * Parse the arguments of a command that takes one dashboard:
 * `[<org/project>] <id-or-title>`, `<org>/[<project>/]<id>`, or a Sentry
 * URL (see the grammar).
 *
 * @param usageHint - Usage shown when arguments are ignored
 * @throws {ValidationError} When no dashboard is given
 */
export function parseDashboardArgs(
  args: readonly string[],
  usageHint: string,
): DashboardArgs {
  const syntax = parse(grammarInput(args), { list: false, sentryUrl });
  const { ref, url } = syntax;
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
  const warnings: string[] = [];
  if (url) {
    warnings.push(urlWarning(url));
  }
  if (syntax.extra.length > 0) {
    warnings.push(
      `Extra arguments ignored: ${syntax.extra.join(" ")}. Expected: ${usageHint}`,
    );
  }
  return {
    dashboardRef: ref,
    targetArg: syntax.target,
    baseUrl: url?.baseUrl,
    warnings,
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

/**
 * Parse `dashboard list` arguments: an optional target and title filter.
 * One argument without a slash is a filter (dashboards are org-scoped, so a
 * project search would only pick an org), and a filter may span several
 * arguments (see the grammar).
 *
 * @throws {ValidationError} For a dashboard URL, suggesting `dashboard view`
 */
export function parseDashboardListArgs(
  args: readonly (string | undefined)[],
): DashboardListArgs {
  const syntax = parse(
    grammarInput(args.filter((arg): arg is string => !!arg)),
    { list: true, sentryUrl },
  );
  const { url } = syntax;
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
  return {
    targetArg: syntax.target,
    titleFilter: syntax.filter,
    baseUrl: url?.baseUrl,
    warnings: url ? [urlWarning(url)] : [],
  };
}

/**
 * The grammar's input: a NUL before each argument.
 *
 * @throws {ValidationError} When an argument holds a NUL
 */
function grammarInput(args: readonly string[]): string {
  if (args.some((arg) => arg.includes("\0"))) {
    throw new ValidationError(
      "Arguments cannot contain NUL characters.",
      "positional",
    );
  }
  return args.map((arg) => `\0${arg}`).join("");
}

function sentryUrl(value: string): DashboardUrl | null {
  const url = parseSentryUrl(value);
  return (
    url && {
      baseUrl: url.baseUrl,
      ...(url.org && { org: url.org }),
      ...(url.dashboardId && { dashboardId: url.dashboardId }),
    }
  );
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
