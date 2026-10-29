// Types of the parser generated from dashboard-arguments.pegjs. The
// generator copies this file to src/generated/dashboard-arguments-grammar.d.ts
// and rewrites relative imports to resolve from there.

/** The parts of a Sentry URL that dashboard arguments use. */
export type DashboardUrl = {
  readonly baseUrl: string;
  readonly org?: string;
  readonly dashboardId?: string;
};

/** What the caller passes the grammar. See `parseDashboardArgs()`. */
export type DashboardArgumentsGrammarOptions = {
  /** Whether these are `dashboard list` arguments: a target and a filter */
  list: boolean;
  /** The Sentry URL `value` is, or `null` for anything else */
  sentryUrl: (value: string) => DashboardUrl | null;
};

/** Which argument is the dashboard and which its target. */
export type DashboardSyntax = {
  /** The numeric ID or title; absent when none was given */
  readonly ref?: string;
  /** The org/project target, as typed, or `<org>/` */
  readonly target?: string;
  /** The URL the dashboard or org came from */
  readonly url?: DashboardUrl;
  /** Arguments after the dashboard */
  readonly extra: readonly string[];
};

/** Which argument is the target and which the title filter. */
export type DashboardListSyntax = {
  readonly target?: string;
  /** The title filter, its words joined by spaces */
  readonly filter?: string;
  /** The URL the org came from, or a dashboard URL, which lists nothing */
  readonly url?: DashboardUrl;
};

export declare class SyntaxError extends Error {
  expected: unknown;
  found: string | null;
  location: unknown;
}

/** Parse NUL-prefixed arguments into a dashboard and its target. */
export declare function parse(
  input: string,
  options: DashboardArgumentsGrammarOptions & { list: false },
): DashboardSyntax;
/** Parse NUL-prefixed arguments into a list target and title filter. */
export declare function parse(
  input: string,
  options: DashboardArgumentsGrammarOptions & { list: true },
): DashboardListSyntax;
