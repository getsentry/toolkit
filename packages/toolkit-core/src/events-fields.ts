/**
 * Field-expression parsing for Sentry Events (`/events/`) queries.
 *
 * Ported from the Sentry frontend's Discover field helpers so the CLI and MCP
 * classify fields the same way the product does:
 * https://github.com/getsentry/sentry/blob/master/static/app/utils/discover/fields.tsx
 *
 * Keep this in sync with `parseFunction`, `parseArguments`, `isEquation`,
 * `isAggregateEquation`, and `isAggregateField` there.
 */

/** A parsed aggregate call such as `p95(span.duration)`. */
export type ParsedFunction = {
  name: string;
  arguments: string[];
  /** Unwrapped search filter of an `_if` aggregate's backtick argument. */
  filter?: string;
};

const AGGREGATE_PATTERN = /^(\w+)\((.*)\)$/;
/** {@link AGGREGATE_PATTERN} without anchors, to find calls inside equations. */
const AGGREGATE_BASE = /(\w+)\((.*)\)/g;
const IF_SUFFIX = "_if";

/** Prefix that marks an equation field. `|` is not a legal field character. */
export const EQUATION_PREFIX = "equation|";

function isSearchFilterArgument(value: string): boolean {
  return value.length >= 2 && value.startsWith("`") && value.endsWith("`");
}

function lookback(columnText: string, j: number, str: string): boolean {
  // Matches the frontend, which only checks once `j` is past `str`.
  if (j < str.length) {
    return false;
  }
  return columnText.substring(j - str.length, j) === str;
}

/**
 * Split an aggregate's argument list on top-level commas. Commas inside
 * quoted strings, `tags[...]`, and backtick search filters stay put.
 */
function parseArguments(columnText: string): string[] {
  const args: string[] = [];

  let quoted = false;
  let inTag = false;
  let escaped = false;
  let inFilter = false;

  let i = 0;
  let j = 0;

  while (j < columnText.length) {
    const char = columnText[j];
    if (!inFilter && !inTag && i === j && char === '"') {
      quoted = true;
    } else if (
      !inFilter &&
      !quoted &&
      char === "[" &&
      lookback(columnText, j, "tags")
    ) {
      inTag = true;
    } else if (!quoted && i === j && char === "`") {
      inFilter = true;
    } else if (i === j && char === " ") {
      i += 1;
    } else if (quoted && !escaped && char === "\\") {
      escaped = true;
    } else if (quoted && !escaped && char === '"') {
      quoted = false;
    } else if (inTag && !escaped && char === "]") {
      inTag = false;
    } else if (inFilter && char === "`") {
      inFilter = false;
    } else if (quoted && escaped) {
      escaped = false;
    } else if ((quoted || inTag) && char === ",") {
      // A comma inside a quoted string or tag is not a separator.
    } else if (!inFilter && char === ",") {
      args.push(columnText.substring(i, j).trim());
      i = j + 1;
    }
    j += 1;
  }

  if (i !== j) {
    args.push(columnText.substring(i).trim());
  }

  return args;
}

/**
 * Parse an aggregate field into its name and arguments, or `null` when the
 * field is not a function call.
 */
export function parseFunction(field: string): ParsedFunction | null {
  const results = field.match(AGGREGATE_PATTERN);
  if (results?.length !== 3) {
    return null;
  }
  const name = results[1] as string;
  const args = parseArguments(results[2] as string);
  const firstArgument = args[0] ?? "";
  if (isSearchFilterArgument(firstArgument) && name.endsWith(IF_SUFFIX)) {
    return { name, arguments: args, filter: firstArgument.slice(1, -1) };
  }
  return { name, arguments: args };
}

/** Whether a field is an aggregate function such as `count()`. */
export function isAggregateField(field: string): boolean {
  return parseFunction(field) !== null;
}

/** Whether a field is an `equation|...` expression. */
export function isEquation(field: string): boolean {
  return field.startsWith(EQUATION_PREFIX);
}

/** Whether a field is an equation over aggregates, e.g. `equation|count() / 60`. */
export function isAggregateEquation(field: string): boolean {
  return isEquation(field) && (field.match(AGGREGATE_BASE)?.length ?? 0) > 0;
}

/** Whether a field makes a query aggregate: an aggregate or aggregate equation. */
export function isAggregateFieldOrEquation(field: string): boolean {
  return isAggregateField(field) || isAggregateEquation(field);
}
