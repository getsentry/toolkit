/**
 * Sentry search query sanitization.
 *
 * Handles boolean operator rewriting for `--query` flags across all
 * commands that accept Sentry search syntax. Centralised here so every
 * command benefits from the same auto-recovery logic.
 *
 * - **AND**: Sentry search implicitly ANDs space-separated terms, so
 *   explicit `AND` is redundant. Stripped with a warning.
 * - **OR**: Attempted rewrite to in-list syntax (`key:[val1,val2]`)
 *   when all OR operands share the same qualifier key. Throws a
 *   {@link ValidationError} when the rewrite is not possible.
 * - **`project:<digits>`**: `project` is the slug. Numeric ids belong on
 *   `project_id`. Agents often paste `project:4511…` (CLI-FA). Rewritten
 *   with a warning. Slugs, `project_id:…`, and namespaced keys
 *   (`bolt.project_id`) are left alone.
 *
 * Parsing uses a pre-compiled PEG parser generated from
 * `script/search-query.pegjs` (a simplified version of Sentry's
 * canonical grammar). The parser classifies every term structurally —
 * comparison operators, in-list values, paren groups, etc. — so the
 * rewriting logic doesn't need regex-based reject-lists.
 *
 * @see {@link https://github.com/getsentry/sentry/blob/master/static/app/components/searchSyntax/grammar.pegjs | Canonical Sentry PEG grammar}
 */

import type { SearchNode } from "../generated/search-parser.js";
import { parse } from "../generated/search-parser.js";
import { ValidationError } from "./errors.js";
import { logger } from "./logger.js";

const log = logger.withTag("search-query");

/**
 * Keys that do not support in-list syntax in Sentry search.
 *
 * - `is`: Explicitly documented as unsupported by Sentry docs
 * - `has`: Uses `search_value` not `text_in_list` in the PEG grammar
 */
const INVALID_INLIST_KEYS = new Set(["is", "has"]);

// ---------------------------------------------------------------------------
// AST → string serialization
// ---------------------------------------------------------------------------

/** Serialize a single AST node back to query string form. */
function serializeNode(node: SearchNode): string {
  switch (node.type) {
    case "boolean_op": {
      return node.op;
    }
    case "free_text": {
      return node.value;
    }
    case "paren_group": {
      return node.raw;
    }
    case "text_filter": {
      const prefix = node.negated ? "!" : "";
      return `${prefix}${node.key}:${node.value}`;
    }
    case "text_in_filter": {
      const prefix = node.negated ? "!" : "";
      return `${prefix}${node.key}:[${node.values.join(",")}]`;
    }
    case "comparison_filter": {
      const prefix = node.negated ? "!" : "";
      return `${prefix}${node.key}:${node.op}${node.value}`;
    }
    default: {
      return "";
    }
  }
}

/** Serialize a list of AST nodes back to a query string. */
function serializeNodes(nodes: SearchNode[]): string {
  return nodes.map(serializeNode).join(" ");
}

// ---------------------------------------------------------------------------
// OR → in-list rewriting
// ---------------------------------------------------------------------------

/**
 * Check whether an AST node can participate in an in-list merge.
 *
 * Only `text_filter` and `text_in_filter` nodes with valid keys (not
 * `is:`/`has:`), no negation, and no wildcards are eligible.
 * Comparison filters, free text, paren groups, and boolean ops cannot.
 */
function isMergeableFilter(
  node: SearchNode,
): node is
  | (SearchNode & { type: "text_filter" })
  | (SearchNode & { type: "text_in_filter" }) {
  if (node.type === "text_filter") {
    if (node.negated) {
      return false;
    }
    if (INVALID_INLIST_KEYS.has(node.key.toLowerCase())) {
      return false;
    }
    return !node.value.includes("*");
  }
  if (node.type === "text_in_filter") {
    if (node.negated) {
      return false;
    }
    if (INVALID_INLIST_KEYS.has(node.key.toLowerCase())) {
      return false;
    }
    // No wildcards in any existing in-list values
    return !node.values.some((v) => v.includes("*"));
  }
  return false;
}

/** Extract all values from a mergeable filter node. */
function valuesFromNode(
  node: SearchNode & { type: "text_filter" | "text_in_filter" },
): string[] {
  if (node.type === "text_in_filter") {
    return node.values;
  }
  return [node.value];
}

/**
 * Try to merge a group of AST nodes (OR-connected) into a single
 * in-list filter node. Returns the merged node or `null`.
 */
function tryMergeGroup(group: SearchNode[]): SearchNode | null {
  // All must be mergeable filters
  for (const node of group) {
    if (!isMergeableFilter(node)) {
      return null;
    }
  }

  const filters = group as Array<
    SearchNode & { type: "text_filter" | "text_in_filter" }
  >;
  const first = filters[0];
  if (!first) {
    return null;
  }

  // All must have the same key (case-insensitive)
  const keyLower = first.key.toLowerCase();
  for (const f of filters) {
    if (f.key.toLowerCase() !== keyLower) {
      return null;
    }
  }

  // Collect and flatten all values
  const allValues: string[] = [];
  for (const f of filters) {
    allValues.push(...valuesFromNode(f));
  }

  return {
    type: "text_in_filter",
    negated: false,
    key: first.key,
    values: allValues,
  };
}

/**
 * Walk the AST node list and attempt to rewrite all OR groups to
 * in-list syntax. Returns the rewritten node list, or `null` if
 * any OR group cannot be merged.
 */
/**
 * Merge an OR group into a single node. Single-element groups pass through.
 * Returns `null` if the group cannot be merged.
 */
function mergeOrGroup(group: SearchNode[]): SearchNode | null {
  if (group.length === 1) {
    return group[0] ?? null;
  }
  return tryMergeGroup(group);
}

function tryRewriteOr(nodes: SearchNode[]): SearchNode[] | null {
  const result: SearchNode[] = [];
  let i = 0;

  while (i < nodes.length) {
    const current = nodes[i] as SearchNode;

    // Skip stray OR tokens
    if (isOrNode(nodes, i)) {
      i += 1;
      continue;
    }

    // Check if next node is OR → collect and merge the chain
    if (isOrNode(nodes, i + 1)) {
      const [group, nextIndex] = collectOrChain(nodes, i);
      const merged = mergeOrGroup(group);
      if (!merged) {
        return null;
      }
      result.push(merged);
      i = nextIndex;
    } else {
      result.push(current);
      i += 1;
    }
  }

  // All-OR input (e.g. "OR OR OR") produces an empty result — treat as unmergeable
  if (result.length === 0) {
    return null;
  }

  return result;
}

/** Check whether the node at index `j` is an OR operator. */
function isOrNode(nodes: SearchNode[], j: number): boolean {
  const node = nodes[j];
  return node?.type === "boolean_op" && node.op === "OR";
}

/**
 * Collect an OR-chain starting at `start`. Returns the group of
 * non-OR nodes and the index past the end of the chain.
 */
function collectOrChain(
  nodes: SearchNode[],
  start: number,
): [SearchNode[], number] {
  const group = [nodes[start] as SearchNode];
  let j = start + 1;

  while (isOrNode(nodes, j)) {
    j += 1; // skip OR
    // Skip consecutive ORs
    while (isOrNode(nodes, j)) {
      j += 1;
    }
    if (j < nodes.length) {
      group.push(nodes[j] as SearchNode);
      j += 1;
    }
  }

  return [group, j];
}

// ---------------------------------------------------------------------------
// Boolean operator scanning (recursive into paren groups)
// ---------------------------------------------------------------------------

/**
 * Check whether any paren group (at any nesting depth) contains an OR
 * operator. These are opaque — their `raw` text can't be rewritten —
 * so any OR inside must be rejected even if top-level OR is rewritable.
 */
function hasOrInParenGroups(nodes: SearchNode[]): boolean {
  for (const node of nodes) {
    if (node.type === "paren_group" && hasOrInNodes(node.inner)) {
      return true;
    }
  }
  return false;
}

/** Check whether any node (recursively) contains an OR operator. */
function hasOrInNodes(nodes: SearchNode[]): boolean {
  for (const node of nodes) {
    if (node.type === "boolean_op" && node.op === "OR") {
      return true;
    }
    if (node.type === "paren_group" && hasOrInNodes(node.inner)) {
      return true;
    }
  }
  return false;
}

/**
 * Non-recursive scan — only checks top-level nodes, not paren group contents.
 * Used to distinguish "OR at top level" from "OR only inside paren groups".
 */
function scanBooleanOpsFlat(nodes: SearchNode[]): {
  hasOr: boolean;
  hasAnd: boolean;
} {
  let hasOr = false;
  let hasAnd = false;
  for (const node of nodes) {
    if (node.type === "boolean_op") {
      if (node.op === "OR") {
        hasOr = true;
      } else {
        hasAnd = true;
      }
    }
  }
  return { hasOr, hasAnd };
}

/**
 * Remove AND boolean_op nodes from a flat node list.
 * Does NOT recurse into paren groups — those are opaque.
 */
function stripAndNodes(nodes: SearchNode[]): SearchNode[] {
  return nodes.filter((n) => !(n.type === "boolean_op" && n.op === "AND"));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sanitize a `--query` value before sending to the Sentry API.
 *
 * Parses the query using a PEG grammar, then handles boolean operators:
 *
 * - **AND**: Stripped (implicit in Sentry search). Warns via stderr.
 * - **OR**: Attempted rewrite to in-list syntax (`key:[val1,val2]`).
 *   Succeeds when all OR operands share the same valid qualifier key.
 *   Throws {@link ValidationError} when the rewrite is not possible.
 *
 * Paren groups, quoted values, and comparison operators are handled
 * correctly by the grammar — no regex-based reject-lists needed.
 *
 * Accepts `undefined` for convenience — commands can pass `flags.query`
 * directly without a conditional guard.
 *
 * @param query - Raw query string from `--query` flag, or `undefined`
 * @returns The sanitized query, or `undefined` if input was `undefined`
 * @throws {ValidationError} When OR cannot be rewritten to in-list syntax
 */
export function sanitizeQuery(query: string): string;
export function sanitizeQuery(query: undefined): undefined;
export function sanitizeQuery(query: string | undefined): string | undefined;
export function sanitizeQuery(query: string | undefined): string | undefined {
  if (!query) {
    return query;
  }

  // --- Layer 1: Pre-parse text normalization ---
  // Run cheap text transforms on every query BEFORE PEG parsing.
  // These fix common patterns that agents/users produce, regardless of
  // whether the PEG parser would accept them.
  const normalized = normalizeQuery(query);
  const withNumericProject = rewriteNumericProjectFilters(normalized);
  const notes = preParseRewriteNotes(query, normalized, withNumericProject);

  let nodes: SearchNode[];
  try {
    nodes = parse(withNumericProject);
  } catch (err) {
    // PEG parse still failed after normalization — pass through to the
    // API which returns a proper 400 with actionable details. The text
    // rewrites already ran, so say so: the 400 will quote them.
    log.debug("Search query did not parse; sending as-is", err);
    warnRunningQuery(notes, withNumericProject);
    return withNumericProject;
  }

  // Check for OR inside paren groups first — these are opaque and can't
  // be rewritten. Must throw even if top-level OR would be rewritable,
  // because the paren group's raw text would pass the OR through to the API.
  if (hasOrInParenGroups(nodes)) {
    throw new ValidationError(
      "Could not rewrite OR inside parenthesized group.\n\n" +
        "Sentry search does not support boolean operators. " +
        "Remove the parentheses and use in-list syntax instead:\n" +
        "  (level:error OR level:warning)  →  level:[error,warning]\n\n" +
        "Search syntax: https://docs.sentry.io/concepts/search/",
      "query",
    );
  }

  const { hasOr, hasAnd } = scanBooleanOpsFlat(nodes);

  if (hasOr) {
    // Strip AND nodes before OR rewrite
    const withoutAnd = hasAnd ? stripAndNodes(nodes) : nodes;
    const result = handleOr(withoutAnd, hasAnd, notes);
    warnRunningQuery(notes, result);
    return result;
  }

  if (hasAnd) {
    const sanitized = serializeNodes(stripAndNodes(nodes));
    notes.push(
      "Sentry search implicitly ANDs terms — removed explicit AND operator.",
    );
    warnRunningQuery(notes, sanitized);
    return sanitized;
  }

  warnRunningQuery(notes, withNumericProject);
  return withNumericProject;
}

/** Notes from text-layer rewrites that run before PEG parse. */
function preParseRewriteNotes(
  query: string,
  normalized: string,
  withNumericProject: string,
): string[] {
  const notes: string[] = [];
  if (normalized !== query) {
    notes.push("Auto-repaired search query syntax.");
  }
  if (withNumericProject !== normalized) {
    notes.push(
      "`project` is the slug; numeric ids use project_id. Rewrote numeric project: filters.",
    );
  }
  return notes;
}

/**
 * One warning after every successful rewrite. Reasons on the first
 * line; the query that will actually be sent on the second. Skip if
 * nothing changed.
 */
function warnRunningQuery(notes: string[], result: string): void {
  if (notes.length === 0) {
    return;
  }
  log.warn(`${notes.join(" ")}\nRunning query: "${result}"`);
}

/**
 * Handle the OR rewrite path — extracted to keep `sanitizeQuery` under
 * the cognitive complexity limit.
 */
function handleOr(
  nodes: SearchNode[],
  hasAnd: boolean,
  notes: string[],
): string {
  const rewritten = tryRewriteOr(nodes);
  if (rewritten) {
    notes.push("Rewrote OR using in-list syntax: key:[val1,val2].");
    if (hasAnd) {
      notes.push("Also removed explicit AND (implicit in Sentry search).");
    }
    return serializeNodes(rewritten);
  }

  throw new ValidationError(
    "Could not rewrite OR into Sentry search syntax.\n\n" +
      "OR can be auto-rewritten when all terms share the same qualifier key:\n" +
      "  level:error OR level:warning  →  level:[error,warning]\n\n" +
      "Patterns that cannot be rewritten:\n" +
      "  - Free-text terms without a key (error OR timeout)\n" +
      "  - Different keys (level:error OR assigned:me)\n" +
      "  - is: or has: qualifiers (not supported with in-list)\n" +
      "  - Negated qualifiers (!key:val1 OR !key:val2)\n" +
      "  - Comparison values (age:>24h OR age:>7d)\n" +
      "  - Parenthesized groups\n\n" +
      "Alternatives:\n" +
      '  - Write in-list syntax directly: --query "key:[val1,val2]"\n' +
      "  - Run separate queries for each term\n\n" +
      "Search syntax: https://docs.sentry.io/concepts/search/",
    "query",
  );
}

// ---------------------------------------------------------------------------
// Search syntax reference
// ---------------------------------------------------------------------------

/**
 * Compact search syntax reference for JSON output.
 *
 * Gives agents and power users a machine-readable summary of Sentry's
 * search syntax without needing to consult external docs. Derived from the
 * PEG grammar at:
 *   https://github.com/getsentry/sentry/blob/master/static/app/components/searchSyntax/grammar.pegjs
 *
 * Injected into `--json` envelopes when the result set is empty — that's
 * when users/agents most likely need query help (bad query, wrong syntax).
 */
export const SEARCH_SYNTAX_REFERENCE = {
  _type: "sentry_search_syntax",
  docs: "https://docs.sentry.io/concepts/search/",
  grammar:
    "https://github.com/getsentry/sentry/blob/master/static/app/components/searchSyntax/grammar.pegjs",
  behavior: "Terms are space-separated and implicitly ANDed.",
  operators: {
    and: "NOT supported — implicit (space-separated terms are all required)",
    or: "NOT supported — use key:[val1,val2] in-list syntax instead",
    not: "!key:value (prefix with !)",
    comparison: [">=", "<=", ">", "<", "=", "!="],
    wildcard: "* in values (e.g., message:*timeout*)",
    inList: "key:[val1,val2] — matches any value in the list",
  },
  filterTypes: [
    "text (key:value)",
    "text_in (key:[val1,val2])",
    "numeric (key:>100, key:<=50)",
    "boolean (key:true, key:false)",
    "date (key:>2024-01-01)",
    "relative_date (key:-24h, key:+7d)",
    "duration (key:>1s, key:<500ms)",
    "has (has:key — not null check)",
    "is (is:unresolved, is:resolved, is:ignored)",
  ],
  commonFilters: [
    "is:unresolved",
    "is:resolved",
    "is:ignored",
    "assigned:me",
    "assigned:[me,none]",
    "has:user",
    "level:error",
    "level:warning",
    "!browser:Chrome",
    "firstSeen:-24h",
    "lastSeen:-1h",
    "age:-7d",
    "times_seen:>100",
  ],
};

// ---------------------------------------------------------------------------
// Query normalization pipeline
// ---------------------------------------------------------------------------

/**
 * In-list filter with wrong closing delimiter `)`.
 * Matches `key:[a,b,)` — captures the inner values. Does NOT match `[a,b,]`
 * (handled separately by {@link stripTrailingListCommas} via balanced brackets).
 */
const MALFORMED_IN_LIST_RE = /\[([^[\]]*),\s*\)(?=\s|$)/g;

/** Trailing comma at end of captured group content */
const TRAILING_COMMA_RE = /,\s*$/;

/** Balanced `[...]` block — used to skip well-formed in-list filters */
const BALANCED_BRACKET_RE = /\[[^\]]*\]/g;

/** Trailing comma before closing bracket: `,]` */
const TRAILING_LIST_COMMA_RE = /,\s*\]$/;

/**
 * `project:<digits>` as its own filter — not `bolt.project`, not `project_id`.
 * Issue search treats `project` as a slug and `project_id` as a numeric id.
 */
const PROJECT_NUMERIC_RE = /(^|\s)(!?)project:(\d+)(?=\s|$)/gi;

/** `project:[123,456]` — every list value must be digits. */
const PROJECT_NUMERIC_LIST_RE = /(^|\s)(!?)project:\[(\d+(?:\s*,\s*\d+)*)\]/gi;

/**
 * Pattern that splits a query into alternating unquoted / quoted segments.
 *
 * Matches double-quoted strings (including escaped quotes inside them).
 * Between matches is unquoted text that can be safely normalized.
 */
const QUOTED_SEGMENT_RE = /"(?:[^"\\]|\\.)*"/g;

/**
 * Rewrite `project:<digits>` / `project:[digits,…]` to `project_id`.
 *
 * `project` is the slug; a numeric value is almost always a pasted Sentry
 * project id (CLI-FA). Namespaced keys (`bolt.project:…`) and slugs are
 * untouched. Quoted regions are preserved via {@link transformUnquoted}.
 */
function rewriteNumericProjectFilters(query: string): string {
  return transformUnquoted(query, (segment) => {
    PROJECT_NUMERIC_RE.lastIndex = 0;
    PROJECT_NUMERIC_LIST_RE.lastIndex = 0;
    return segment
      .replace(PROJECT_NUMERIC_RE, "$1$2project_id:$3")
      .replace(PROJECT_NUMERIC_LIST_RE, "$1$2project_id:[$3]");
  });
}

/**
 * Normalize a search query by applying a pipeline of text repairs.
 *
 * Runs on every query BEFORE PEG parsing. Each pass is a small, focused
 * transform that fixes a common agent/user mistake. The pipeline is ordered
 * from most common to least common pattern.
 *
 * Quoted regions (`"..."`) are preserved verbatim — only unquoted text is
 * normalized. This prevents `message:"error [500,] found"` from being
 * corrupted.
 *
 * Returns the original query unchanged if no repairs were applicable.
 */
function normalizeQuery(query: string): string {
  return transformUnquoted(query, (segment) => {
    let q = segment;

    // 1. Fix mismatched closing delimiters: `[a,b,)` → `[a,b]`
    //    The `)` is a common typo/autocomplete artifact.
    q = fixMismatchedBrackets(q);

    // 2. Strip trailing commas in in-list: `[a,b,]` → `[a,b]`
    q = stripTrailingListCommas(q);

    // Future passes can be added here (e.g., date normalization)

    return q;
  });
}

/**
 * Apply a transform function only to the unquoted segments of a query.
 *
 * Splits the query at double-quoted boundaries, applies `fn` to each
 * unquoted segment, and re-assembles with the quoted segments untouched.
 */
function transformUnquoted(
  query: string,
  fn: (unquoted: string) => string,
): string {
  // Fast path: no quotes → transform the whole string
  if (!query.includes('"')) {
    return fn(query);
  }

  const parts: string[] = [];
  let lastIndex = 0;

  // Reset the regex state for each call (global regex)
  QUOTED_SEGMENT_RE.lastIndex = 0;
  let match = QUOTED_SEGMENT_RE.exec(query);

  while (match !== null) {
    // Unquoted segment before this quoted match
    if (match.index > lastIndex) {
      parts.push(fn(query.slice(lastIndex, match.index)));
    }
    // Quoted segment — preserved as-is
    parts.push(match[0]);
    lastIndex = match.index + match[0].length;
    match = QUOTED_SEGMENT_RE.exec(query);
  }

  // Trailing unquoted segment after last quote
  if (lastIndex < query.length) {
    parts.push(fn(query.slice(lastIndex)));
  }

  return parts.join("");
}

/**
 * Fix mismatched closing delimiters in in-list filters.
 *
 * `key:[a,b,)` → `key:[a,b]` — the `)` after `[` is clearly meant to be `]`.
 * Only replaces `)` that follows a `[...` opener without an intervening `]`.
 */
function fixMismatchedBrackets(query: string): string {
  return query.replace(
    MALFORMED_IN_LIST_RE,
    (_match, inner: string) => `[${inner.replace(TRAILING_COMMA_RE, "")}]`,
  );
}

/**
 * Strip trailing commas inside in-list filters.
 *
 * `key:[a,b,]` → `key:[a,b]` — valid PEG syntax but some APIs reject it.
 * Only operates on balanced `[...]` blocks to avoid cross-filter corruption.
 */
function stripTrailingListCommas(query: string): string {
  return query.replace(BALANCED_BRACKET_RE, (match) =>
    match.replace(TRAILING_LIST_COMMA_RE, "]"),
  );
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

/**
 * @internal Exported for testing only. Not part of the public API.
 */
export const __testing = {
  isMergeableFilter,
  tryMergeGroup,
  tryRewriteOr,
  serializeNode,
  serializeNodes,
  normalizeQuery,
  transformUnquoted,
};
