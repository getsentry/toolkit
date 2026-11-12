/**
 * Field-expression parsing for Sentry Events (`/events/`) queries.
 *
 * Ported from the Sentry frontend's Discover field helpers so the CLI and MCP
 * classify fields the same way the product does:
 * https://github.com/getsentry/sentry/blob/master/static/app/utils/discover/fields.tsx
 *
 * Keep this in sync with `parseFunction`, `parseArguments`, `isEquation`,
 * `isAggregateEquation`, `isAggregateField`, and `getColumnsAndAggregates`
 * there. The frontend matches calls with `/^(\w+)\((.*)\)$/` and
 * `/(\w+)\((.*)\)/g`; those backtrack polynomially on adversarial input, so
 * this port does the same matching with linear scans.
 */

/** A parsed aggregate call such as `p95(span.duration)`. */
export type ParsedFunction = {
  name: string;
  arguments: string[];
  /** Unwrapped search filter of an `_if` aggregate's backtick argument. */
  filter?: string;
};

const IF_SUFFIX = "_if";
const TRACEMETRICS_ARGUMENT_COUNT = 4;

/** Prefix that marks an equation field. `|` is not a legal field character. */
export const EQUATION_PREFIX = "equation|";

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /\w/.test(char);
}

function isLineTerminator(char: string | undefined): boolean {
  return (
    char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029"
  );
}

/**
 * Split `name(args)` like `/^(\w+)\((.*)\)$/`: a non-empty word name, then
 * everything between the first `(` and the trailing `)`, on a single line.
 */
function matchFunctionCall(
  field: string,
): { name: string; args: string } | null {
  const open = field.indexOf("(");
  if (open < 1 || !field.endsWith(")")) {
    return null;
  }
  for (let i = 0; i < open; i += 1) {
    if (!isWordChar(field[i])) {
      return null;
    }
  }
  const args = field.slice(open + 1, -1);
  for (const char of args) {
    if (isLineTerminator(char)) {
      return null;
    }
  }
  return { name: field.slice(0, open), args };
}

/**
 * Whether the text contains a call like `/(\w+)\((.*)\)/`: a word character
 * directly before a `(` that has a `)` after it on the same line.
 */
function containsFunctionCall(text: string): boolean {
  let lineHasClose = false;
  // Walk backwards so each `(` knows whether its line closes later.
  for (let i = text.length - 1; i > 0; i -= 1) {
    const char = text[i];
    if (isLineTerminator(char)) {
      lineHasClose = false;
    } else if (char === ")") {
      lineHasClose = true;
    } else if (char === "(" && lineHasClose && isWordChar(text[i - 1])) {
      return true;
    }
  }
  return false;
}

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
  const call = matchFunctionCall(field);
  if (!call) {
    return null;
  }
  const { name } = call;
  const args = parseArguments(call.args);
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
  return isEquation(field) && containsFunctionCall(field);
}

/** Whether a field makes a query aggregate: an aggregate or aggregate equation. */
export function isAggregateFieldOrEquation(field: string): boolean {
  return isAggregateField(field) || isAggregateEquation(field);
}

/** Split selected fields into group-by columns and aggregates. */
export function getColumnsAndAggregates(fields: readonly string[]): {
  columns: string[];
  aggregates: string[];
} {
  const columns: string[] = [];
  const aggregates: string[] = [];
  for (const field of fields) {
    (isAggregateFieldOrEquation(field) ? aggregates : columns).push(field);
  }
  return { columns, aggregates };
}

/**
 * Whether an aggregate uses the trace metrics argument format
 * `aggregation(value,metric_name,metric_type,unit)`, optionally preceded by
 * the search filter of an `_if` aggregate.
 */
export function isTracemetricsAggregate(field: string): boolean {
  const parsed = parseFunction(field);
  if (!parsed) {
    return false;
  }
  const offset = parsed.filter === undefined ? 0 : 1;
  return (
    parsed.arguments.length === TRACEMETRICS_ARGUMENT_COUNT + offset &&
    parsed.arguments[offset] === "value"
  );
}
