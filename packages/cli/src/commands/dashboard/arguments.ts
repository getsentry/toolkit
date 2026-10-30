/**
 * Dashboard positionals: `[<org/project>] <dashboard-id-or-title>` and
 * `dashboard list`'s `[<org/project>] [<name-glob>]`, parsed by
 * `lib/dashboard-arguments.ts` before `func` runs and resolved to the org
 * (and dashboard ID) on the first `.resolved` read.
 */

import type { SentryContext } from "../../context.js";
import {
  type ParsedOrgProject,
  parseOrgProjectInput,
} from "../../lib/arg-parsing.js";
import {
  parseDashboardArgs,
  parseDashboardListArgs,
} from "../../lib/dashboard-arguments.js";
import { ValidationError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import {
  type BoundArguments,
  boundArguments,
} from "../../lib/positional-parse.js";
import { applySentryUrlContext } from "../../lib/sentry-url-parser.js";
import {
  orgExists,
  resolveDashboardId,
  resolveOrgFromTarget,
} from "./resolve.js";

const log = logger.withTag("dashboard");

/** A dashboard argument's dashboard and org target, parsed. */
export type DashboardInput = {
  /** The numeric ID or title, as typed */
  readonly ref: string;
  readonly target: ParsedOrgProject;
  /** Server of a pasted Sentry URL, for `applySentryUrlContext` */
  readonly baseUrl?: string;
  readonly warnings: readonly string[];
  /**
   * When the first argument is a bare word before a title (`My
   * Dashboard`): the word, which names an org only if there is one, and the
   * whole input as a title to fall back to
   */
  readonly orgOrTitle?: { readonly org: string; readonly title: string };
};

/** A dashboard, resolved to its org and numeric ID. */
export type ResolvedDashboard = {
  readonly orgSlug: string;
  readonly dashboardId: string;
};

/** The arguments of a command that takes one dashboard. */
export type DashboardArguments = BoundArguments<
  DashboardInput,
  ResolvedDashboard
>;

/**
 * Parse dashboard arguments with {@link parseDashboardArgs}, and their
 * target, without side effects.
 *
 * @throws {ValidationError} When no dashboard is given or the target is
 *   invalid
 */
export function parseDashboardInput(
  args: readonly string[],
  usageHint: string,
): DashboardInput {
  const { dashboardRef, targetArg, baseUrl, warnings, orgOrTitle } =
    parseDashboardArgs(args, usageHint);
  const target = parseOrgProjectInput(targetArg);
  return {
    ref: dashboardRef,
    target: target.parsed,
    baseUrl: baseUrl ?? target.baseUrl,
    warnings,
    ...(orgOrTitle && { orgOrTitle }),
  };
}

/**
 * Resolve parsed dashboard arguments: apply the URL's server, warn, find
 * the org, and look a title up.
 */
export async function resolveDashboardInput(
  input: DashboardInput,
  cwd: string,
  usageHint: string,
): Promise<ResolvedDashboard> {
  applyInputContext(input);
  // `<word> <title...>`: the word names an org only if there is one. When
  // there is, its title lookup is final.
  if (input.orgOrTitle && !(await orgExists(input.orgOrTitle.org))) {
    return await resolveWholeTitle(input.ref, input.orgOrTitle, cwd, usageHint);
  }
  const orgSlug = await resolveOrgFromTarget(input.target, cwd, usageHint);
  const dashboardId = await resolveDashboardId(orgSlug, input.ref);
  return { orgSlug, dashboardId };
}

/**
 * `<word> <title...>` where `<word>` names no org: look the whole input up
 * as one title in the auto-detected org instead (`dashboard view My
 * Dashboard`).
 *
 * @throws {ValidationError} When that title is not found either, naming
 *   both readings
 */
async function resolveWholeTitle(
  ref: string,
  orgOrTitle: NonNullable<DashboardInput["orgOrTitle"]>,
  cwd: string,
  usageHint: string,
): Promise<ResolvedDashboard> {
  const { org, title } = orgOrTitle;
  log.warn(
    `No org '${org}'; treating "${title}" as the dashboard title. Use my-org/ to name an org.`,
  );
  const orgSlug = await resolveOrgFromTarget(
    { type: "auto-detect" },
    cwd,
    usageHint,
  );
  try {
    const dashboardId = await resolveDashboardId(orgSlug, title);
    return { orgSlug, dashboardId };
  } catch (error) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }
    throw new ValidationError(
      `No dashboard found: there is no org '${org}' to find '${ref}' in, ` +
        `and no dashboard '${title}' in '${orgSlug}'.\n\n` +
        `To name an org, end it with a slash: <org>/ ${ref}\n` +
        `To name a title with spaces, quote it: '${title}'`,
      "dashboard",
    );
  }
}

/**
 * The `[<org/project>] <dashboard-id-or-title>` positional of a command that
 * takes one dashboard (see `parseDashboardArgs()`).
 *
 * @param options.usageHint - Usage shown in errors and warnings
 */
export function dashboardArguments(options: {
  readonly placeholder: string;
  readonly usageHint: string;
}) {
  const { placeholder, usageHint } = options;
  return boundArguments({
    placeholder,
    brief: "[<org/project>] <dashboard-id-or-title>",
    kind: "dashboard",
    parse: (args) => parseDashboardInput(args, usageHint),
    resolve: (input: DashboardInput, context: SentryContext) =>
      resolveDashboardInput(input, context.cwd, usageHint),
  });
}

/** `dashboard list` arguments: the org target and title filter, parsed. */
export type DashboardListInput = {
  readonly target: ParsedOrgProject;
  /** Title glob to filter by */
  readonly titleFilter?: string;
  /** Server of a pasted Sentry URL, for `applySentryUrlContext` */
  readonly baseUrl?: string;
  readonly warnings: readonly string[];
};

/** The arguments of `dashboard list`; they resolve to the org slug. */
export type DashboardListArguments = BoundArguments<DashboardListInput, string>;

/**
 * Parse `dashboard list` arguments with {@link parseDashboardListArgs}, and
 * their target, without side effects.
 */
function parseDashboardListInput(args: readonly string[]): DashboardListInput {
  const { targetArg, titleFilter, baseUrl, warnings } =
    parseDashboardListArgs(args);
  const target = parseOrgProjectInput(targetArg);
  return {
    target: target.parsed,
    titleFilter,
    baseUrl: baseUrl ?? target.baseUrl,
    warnings,
  };
}

/**
 * The `[<org/project>] [<name-glob>]` positional of `dashboard list`.
 *
 * @param usageHint - Usage shown when the org cannot be found
 */
export function dashboardListArguments(usageHint: string) {
  return boundArguments({
    placeholder: "org/title-filter",
    brief: "[<org/project>] [<name-glob>]",
    kind: "org/project",
    parse: parseDashboardListInput,
    resolve: (input: DashboardListInput, context: SentryContext) => {
      applyInputContext(input);
      return resolveOrgFromTarget(input.target, context.cwd, usageHint);
    },
  });
}

/** Apply a pasted URL's server and log the parse's warnings. */
function applyInputContext(input: {
  readonly baseUrl?: string;
  readonly warnings: readonly string[];
}): void {
  if (input.baseUrl) {
    applySentryUrlContext(input.baseUrl);
  }
  for (const warning of input.warnings) {
    log.warn(warning);
  }
}
