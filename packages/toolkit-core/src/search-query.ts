/**
 * Sentry search query sanitization.
 *
 * Repairs common query mistakes before they reach the Sentry API. Shared by
 * the CLI (`--query`) and the MCP server (`search_issues`). Endpoints that
 * support boolean syntax opt in to preserving it; other endpoints use these
 * rewrites:
 *
 * - **AND**: Sentry search implicitly ANDs space-separated terms, so
 *   explicit `AND` is redundant. Stripped with a warning.
 * - **OR**: Attempted rewrite to in-list syntax (`key:[val1,val2]`)
 *   when all OR operands share the same qualifier key. Throws a
 *   {@link SearchQueryError} when the rewrite is not possible.
 * - **`project:<digits>`**: `project` is the slug. Numeric ids belong on
 *   `project_id`. Agents often paste `project:4511…` (CLI-FA). Rewritten
 *   with a warning. Slugs, `project_id:…`, and namespaced keys
 *   (`bolt.project_id`) are left alone.
 *
 * Issue search (`issueSearch: true`) also handles `is:` and parentheses:
 *
 * - **`is:A OR is:B`**: `is:` rejects in-lists, but the statuses and
 *   substatuses it maps to don't. Rewritten to `status:[A,B]` or
 *   `substatus:[A,B]` when every value maps to the same field.
 * - **Parentheses**: the issues endpoint has no grouping. A group that
 *   reduces to plain terms is unwrapped.
 *
 * Hosts own reporting: {@link rewriteSearchQuery} returns the rewrite notes,
 * and the caller decides whether to log them or show them to a model.
 *
 * Boolean rewriting uses the Sentry frontend's search grammar through
 * `@sentry/search-syntax`. Its token tree is flattened into
 * the {@link SearchNode} list below, which classifies every term
 * structurally — comparison operators, in-list values, paren groups,
 * etc. — so the rewriting logic doesn't need regex-based reject-lists.
 *
 * @see {@link https://github.com/getsentry/sentry/blob/master/static/app/components/searchSyntax/grammar.pegjs | Canonical Sentry PEG grammar}
 */

import {
  type FilterToken,
  type ParseResultToken,
  parseSearch,
} from "@sentry/search-syntax/parser";
import { FilterType, TermOperator, Token } from "@sentry/search-syntax/tokens";

/** A query that can't be rewritten into syntax the endpoint accepts. */
export class SearchQueryError extends Error {
  override name = "SearchQueryError";
}

/**
 * Keys that do not support in-list syntax in Sentry search.
 *
 * - `is`: Explicitly documented as unsupported by Sentry docs
 * - `has`: Uses `search_value` not `text_in_list` in the PEG grammar
 */
const INVALID_INLIST_KEYS = new Set(["is", "has"]);

/**
 * `is:` values that the issues endpoint translates to a `status` filter.
 * From `STATUS_QUERY_CHOICES` in getsentry/sentry `src/sentry/models/group.py`
 * (the deprecated `muted` alias is left out).
 */
const IS_STATUS_VALUES: ReadonlySet<string> = new Set([
  "resolved",
  "unresolved",
  "ignored",
  "archived",
  "reprocessing",
]);

/**
 * `is:` values that the issues endpoint translates to a `substatus` filter,
 * mapped to their parent status. From `SUBSTATUS_UPDATE_CHOICES` in
 * getsentry/sentry `src/sentry/types/group.py`.
 *
 * The endpoint adds a status filter for the *first* substatus only, so a
 * `substatus:[…]` list is only correct when every value has the same parent.
 */
const IS_SUBSTATUS_PARENT: ReadonlyMap<string, string> = new Map([
  ["new", "unresolved"],
  ["ongoing", "unresolved"],
  ["regressed", "unresolved"],
  ["escalating", "unresolved"],
  ["archived_until_escalating", "ignored"],
  ["archived_until_condition_met", "ignored"],
  ["archived_forever", "ignored"],
]);

/**
 * Filter keys whose values scope *which* issues match but which the Sentry
 * issues-list endpoint does NOT apply to its per-group seen-stats
 * (`count`, `userCount`, `firstSeen`, `lastSeen`).
 *
 * A query filtering on one of these returns the groups matching the filter,
 * but the displayed counts remain period-wide totals across every value of the
 * key — e.g. `release:"X"` restricts the result set yet the counts still cover
 * all releases. `issue list` requests the endpoint's query-scoped `filtered`
 * counts instead when one of these keys is present. See getsentry/toolkit#1583.
 */
const COUNT_UNSCOPED_FILTER_KEYS = new Set(["release"]);

// ---------------------------------------------------------------------------
// Search nodes
// ---------------------------------------------------------------------------

/** A text filter: key:value */
type TextFilter = {
  type: "text_filter";
  negated: boolean;
  key: string;
  value: string;
};

/** An in-list filter: key:[val1,val2] */
type TextInFilter = {
  type: "text_in_filter";
  negated: boolean;
  key: string;
  values: string[];
};

/** A regex filter: key://pattern// */
type RegexFilter = {
  type: "regex_filter";
  negated: boolean;
  key: string;
  value: string;
};

/** A comparison filter: key:>value, key:<=value */
type ComparisonFilter = {
  type: "comparison_filter";
  negated: boolean;
  key: string;
  op: string;
  value: string;
};

/** An issue-search `is:value` filter */
type IsFilter = {
  type: "is_filter";
  negated: boolean;
  value: string;
};

/** Free text (no key: prefix) */
type FreeText = {
  type: "free_text";
  value: string;
  quoted: boolean;
};

/** A boolean operator (AND / OR) */
type BooleanOp = {
  type: "boolean_op";
  op: "AND" | "OR";
};

/** A parenthesized group */
type ParenGroup = {
  type: "paren_group";
  inner: SearchNode[];
  raw: string;
};

/**
 * A filter the rewriter must pass through untouched, such as an empty value
 * or a list with an empty item.
 */
type OpaqueTerm = {
  type: "opaque";
  raw: string;
};

/** One term of a search query. */
export type SearchNode =
  | TextFilter
  | TextInFilter
  | RegexFilter
  | ComparisonFilter
  | IsFilter
  | FreeText
  | BooleanOp
  | ParenGroup
  | OpaqueTerm;

const COMPARISON_PREFIX_RE = /^(>=|<=|!=|>|<|=)/;

/**
 * Filter types whose key shape also has an in-list rule in Sentry's grammar
 * (`text_in_filter` / `numeric_in_filter`). Aggregate (`count():10`),
 * array-includes (`foo[*]:a`), `has:`/`is:`, boolean, date, duration and
 * size filters have no in-list form, so merging them would build a query
 * the API rejects.
 */
const LISTABLE_FILTER_TYPES: ReadonlySet<FilterType> = new Set([
  FilterType.TEXT,
  FilterType.NUMERIC,
]);
const FREE_TEXT_SEPARATOR_RE = /[ \t]+/;

type Located = {
  location: { start: { offset: number }; end: { offset: number } };
};

/** The exact query text a token was parsed from. */
function sourceOf(query: string, token: Located): string {
  return query.slice(token.location.start.offset, token.location.end.offset);
}

/** Flatten one filter token into a {@link SearchNode}. */
function filterToNode(query: string, token: FilterToken): SearchNode {
  const key = sourceOf(query, token.key);
  // Everything after the `:` that follows the key, operator included.
  const value = query.slice(
    token.key.location.end.offset + 1,
    token.location.end.offset,
  );
  const { negated } = token;

  if (token.operator === TermOperator.MATCHES) {
    return { type: "regex_filter", negated, key, value };
  }

  if (token.filter === FilterType.IS && value) {
    return { type: "is_filter", negated, value };
  }

  if (
    token.value.type === Token.VALUE_TEXT_LIST ||
    token.value.type === Token.VALUE_NUMBER_LIST
  ) {
    const values: string[] = [];
    for (const item of token.value.items) {
      if (!item.value || token.operator !== TermOperator.DEFAULT) {
        return { type: "opaque", raw: sourceOf(query, token) };
      }
      values.push(sourceOf(query, item.value));
    }
    return { type: "text_in_filter", negated, key, values };
  }

  const comparison = COMPARISON_PREFIX_RE.exec(value)?.[1];
  if (comparison) {
    return {
      type: "comparison_filter",
      negated,
      key,
      op: comparison,
      value: value.slice(comparison.length),
    };
  }

  if (!value || !LISTABLE_FILTER_TYPES.has(token.filter)) {
    return { type: "opaque", raw: sourceOf(query, token) };
  }

  return { type: "text_filter", negated, key, value };
}

/**
 * Flatten the shared parser's token tree into {@link SearchNode}s. Returns
 * `null` for unbalanced parentheses, which the rewriter can't reason about.
 */
function toSearchNodes(
  query: string,
  tokens: ParseResultToken[],
): SearchNode[] | null {
  const nodes: SearchNode[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case Token.SPACES:
        break;
      case Token.LOGIC_BOOLEAN:
        nodes.push({ type: "boolean_op", op: token.value });
        break;
      case Token.LOGIC_GROUP: {
        const inner = toSearchNodes(query, token.inner);
        if (!inner) {
          return null;
        }
        nodes.push({ type: "paren_group", inner, raw: sourceOf(query, token) });
        break;
      }
      case Token.FREE_TEXT: {
        const text = sourceOf(query, token).trim();
        if (token.quoted) {
          nodes.push({ type: "free_text", value: text, quoted: true });
          break;
        }
        // The grammar folds consecutive words into one free-text token; the
        // rewriter treats each word as its own term.
        for (const word of text.split(FREE_TEXT_SEPARATOR_RE)) {
          if (word) {
            nodes.push({ type: "free_text", value: word, quoted: false });
          }
        }
        break;
      }
      case Token.FILTER:
        nodes.push(filterToNode(query, token));
        break;
      default:
        return null;
    }
  }
  return nodes;
}

/** Parse a query into {@link SearchNode}s, or `null` if it can't be. */
function parseSearchNodes(query: string): SearchNode[] | null {
  // Regex filters are parsed as such on every dataset so the rewriter never
  // merges a `key://pattern//` value into an in-list.
  const tokens = parseSearch(query, { config: { allowRegex: true } });
  return tokens ? toSearchNodes(query, tokens) : null;
}

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
    case "regex_filter": {
      const prefix = node.negated ? "!" : "";
      return `${prefix}${node.key}:${node.value}`;
    }
    case "comparison_filter": {
      const prefix = node.negated ? "!" : "";
      return `${prefix}${node.key}:${node.op}${node.value}`;
    }
    case "is_filter": {
      const prefix = node.negated ? "!" : "";
      return `${prefix}is:${node.value}`;
    }
    case "opaque": {
      return node.raw;
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
function tryMergeGroup(
  group: SearchNode[],
  issueSearch: boolean,
): SearchNode | null {
  // Status operands must pass the parent-status check; never fall back to
  // the generic same-key merge for them.
  if (issueSearch && group.some(isStatusOperand)) {
    return tryMergeIsGroup(group);
  }

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

/** Fields the issues endpoint fills from `is:` values. */
const STATUS_FIELDS: ReadonlySet<string> = new Set(["status", "substatus"]);

/**
 * Whether a node filters on issue status: `is:`, `status:`, or `substatus:`.
 * Keys compare case-insensitively, like the generic OR merge.
 */
function isStatusOperand(node: SearchNode): boolean {
  return (
    node.type === "is_filter" ||
    ((node.type === "text_filter" || node.type === "text_in_filter") &&
      STATUS_FIELDS.has(node.key.toLowerCase()))
  );
}

/**
 * Merge an OR group of `is:` filters into a `status` or `substatus` in-list.
 *
 * `is:` rejects in-lists, but the issues endpoint translates each `is:`
 * value to a `status` or `substatus` filter, and those accept lists. Returns
 * `null` unless every operand is a non-negated `is:` whose value maps to the
 * same field (and, for substatuses, the same parent status). Operands may
 * also be `status:`/`substatus:` filters or in-lists, such as one already
 * merged from a parenthesized group, as long as the result keeps their field.
 */
function tryMergeIsGroup(group: SearchNode[]): SearchNode | null {
  const values: string[] = [];
  const listFields = new Set<string>();
  for (const node of group) {
    if (node.type === "is_filter" && !node.negated) {
      values.push(node.value);
    } else if (
      (node.type === "text_filter" || node.type === "text_in_filter") &&
      !node.negated &&
      STATUS_FIELDS.has(node.key.toLowerCase())
    ) {
      listFields.add(node.key.toLowerCase());
      values.push(...valuesFromNode(node));
    } else {
      return null;
    }
  }

  const uniqueValues = [...new Set(values)];
  const field = isListField(uniqueValues);
  if (!field || [...listFields].some((listField) => listField !== field)) {
    return null;
  }
  return {
    type: "text_in_filter",
    negated: false,
    key: field,
    values: uniqueValues,
  };
}

/**
 * The in-list field that can hold every value: `status` when all are
 * statuses, `substatus` when all are substatuses of one status, else `null`.
 */
function isListField(values: string[]): "status" | "substatus" | null {
  if (values.every((value) => IS_STATUS_VALUES.has(value))) {
    return "status";
  }
  const parents = new Set(
    values.map((value) => IS_SUBSTATUS_PARENT.get(value)),
  );
  if (parents.size === 1 && !parents.has(undefined)) {
    return "substatus";
  }
  return null;
}

/**
 * Merge an OR group into a single node. Single-element groups pass through.
 * Returns `null` if the group cannot be merged.
 */
function mergeOrGroup(
  group: SearchNode[],
  issueSearch: boolean,
): SearchNode | null {
  if (group.length === 1) {
    return group[0] ?? null;
  }
  return tryMergeGroup(group, issueSearch);
}

/**
 * Walk the AST node list and attempt to rewrite all OR groups to
 * in-list syntax. Returns the rewritten node list, or `null` if
 * any OR group cannot be merged.
 */
function tryRewriteOr(
  nodes: SearchNode[],
  issueSearch: boolean,
): SearchNode[] | null {
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
      const merged = mergeOrGroup(group, issueSearch);
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
// Paren group unwrapping (issue search)
// ---------------------------------------------------------------------------

/**
 * Unwrap paren groups that reduce to plain terms.
 *
 * The issues endpoint has no grouping, so `is:unresolved (is:regressed OR
 * is:escalating)` must become `is:unresolved substatus:[regressed,escalating]`.
 * A group is unwrapped when its contents, after stripping AND and rewriting
 * OR, are plain terms. Its terms are spliced into the surrounding implicit
 * AND, unless an OR touches the group, in which case it is only unwrapped
 * when it reduced to a single term. Any other group is left as written.
 */
function unwrapParenGroups(nodes: SearchNode[]): {
  nodes: SearchNode[];
  changed: boolean;
} {
  const result: SearchNode[] = [];
  let changed = false;

  nodes.forEach((node, i) => {
    if (node.type !== "paren_group") {
      result.push(node);
      return;
    }

    const inner = unwrapParenGroups(stripAndNodes(node.inner)).nodes;
    const terms = hasOrInNodes(inner) ? tryRewriteOr(inner, true) : inner;
    const touchesOr = isOrNode(nodes, i - 1) || isOrNode(nodes, i + 1);
    if (
      !terms ||
      terms.length === 0 ||
      terms.some((term) => term.type === "paren_group") ||
      (touchesOr && terms.length > 1)
    ) {
      result.push(node);
      return;
    }

    result.push(...terms);
    changed = true;
  });

  return { nodes: changed ? result : nodes, changed };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Options for {@link rewriteSearchQuery}. */
export type SearchQueryOptions = {
  /** Events queries support boolean operators; issue search still needs rewrites. */
  allowBoolean?: boolean;
  /**
   * The query targets the issues endpoint: rewrite `is:` OR groups to
   * `status`/`substatus` in-lists and unwrap parentheses.
   */
  issueSearch?: boolean;
};

/** A rewritten query and the reasons it changed. */
export type RewrittenSearchQuery = {
  /** The query to send to the API. */
  query: string;
  /** One note per rewrite. Empty when the query is unchanged. */
  notes: string[];
};

/**
 * Rewrite a search query into syntax the target endpoint accepts.
 *
 * Repairs common syntax mistakes, preserving boolean operators when the
 * endpoint supports them. Otherwise parses a PEG grammar and rewrites operators:
 *
 * - **AND**: Stripped (implicit in Sentry search).
 * - **OR**: Attempted rewrite to in-list syntax (`key:[val1,val2]`).
 *   Succeeds when all OR operands share the same valid qualifier key.
 *   Throws {@link SearchQueryError} when the rewrite is not possible.
 *
 * Paren groups, quoted values, and comparison operators are handled
 * correctly by the grammar — no regex-based reject-lists needed.
 *
 * @param query - Raw search query
 * @param options - Endpoint capabilities; see {@link SearchQueryOptions}
 * @returns The query to send, plus one note per rewrite
 * @throws {SearchQueryError} When OR cannot be rewritten to in-list syntax
 */
export function rewriteSearchQuery(
  query: string,
  options: SearchQueryOptions = {},
): RewrittenSearchQuery {
  // --- Layer 1: Pre-parse text normalization ---
  // Run cheap text transforms on every query BEFORE PEG parsing.
  // These fix common patterns that agents/users produce, regardless of
  // whether the PEG parser would accept them.
  const normalized = normalizeQuery(query);
  const withNumericProject = rewriteNumericProjectFilters(normalized);
  const notes = preParseRewriteNotes(query, normalized, withNumericProject);

  if (options.allowBoolean) {
    return { query: withNumericProject, notes };
  }

  let nodes = parseSearchNodes(withNumericProject);
  if (!nodes) {
    // PEG parse still failed after normalization — pass through to the
    // API which returns a proper 400 with actionable details. The text
    // rewrites already ran, so say so: the 400 will quote them.
    return { query: withNumericProject, notes };
  }

  const issueSearch = options.issueSearch === true;
  let unwrapped = false;
  if (issueSearch) {
    ({ nodes, changed: unwrapped } = unwrapParenGroups(nodes));
    if (unwrapped) {
      notes.push(
        "Issue search does not support parentheses — removed the grouping.",
      );
    }
  }

  // Check for OR inside paren groups first — these are opaque and can't
  // be rewritten. Must throw even if top-level OR would be rewritable,
  // because the paren group's raw text would pass the OR through to the API.
  if (hasOrInParenGroups(nodes)) {
    throw new SearchQueryError(
      "Could not rewrite OR inside parenthesized group.\n\n" +
        "Sentry search does not support boolean operators. " +
        "Remove the parentheses and use in-list syntax instead:\n" +
        "  (level:error OR level:warning)  →  level:[error,warning]\n\n" +
        "Search syntax: https://docs.sentry.io/concepts/search/",
    );
  }

  const { hasOr, hasAnd } = scanBooleanOpsFlat(nodes);

  if (hasOr) {
    // Strip AND nodes before OR rewrite
    const withoutAnd = hasAnd ? stripAndNodes(nodes) : nodes;
    return { query: handleOr(withoutAnd, hasAnd, notes, issueSearch), notes };
  }

  if (hasAnd) {
    notes.push(
      "Sentry search implicitly ANDs terms — removed explicit AND operator.",
    );
    return { query: serializeNodes(stripAndNodes(nodes)), notes };
  }

  if (unwrapped) {
    return { query: serializeNodes(nodes), notes };
  }

  return { query: withNumericProject, notes };
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
 * Handle the OR rewrite path — extracted to keep `rewriteSearchQuery` under
 * the cognitive complexity limit.
 */
function handleOr(
  nodes: SearchNode[],
  hasAnd: boolean,
  notes: string[],
  issueSearch: boolean,
): string {
  const rewritten = tryRewriteOr(nodes, issueSearch);
  if (rewritten) {
    notes.push("Rewrote OR using in-list syntax: key:[val1,val2].");
    if (hasAnd) {
      notes.push("Also removed explicit AND (implicit in Sentry search).");
    }
    return serializeNodes(rewritten);
  }

  const isRewrites = issueSearch
    ? "  is:resolved OR is:ignored  →  status:[resolved,ignored]\n" +
      "  is:regressed OR is:escalating  →  substatus:[regressed,escalating]\n"
    : "";
  const isLimits = issueSearch
    ? "  - is: values that mix statuses and substatuses, substatuses of different statuses, or flags like is:assigned\n"
    : "  - is: or has: qualifiers (not supported with in-list)\n";

  throw new SearchQueryError(
    "Could not rewrite OR into Sentry search syntax.\n\n" +
      "OR can be auto-rewritten when all terms share the same qualifier key:\n" +
      "  level:error OR level:warning  →  level:[error,warning]\n" +
      isRewrites +
      "\nPatterns that cannot be rewritten:\n" +
      "  - Free-text terms without a key (error OR timeout)\n" +
      "  - Different keys (level:error OR assigned:me)\n" +
      isLimits +
      "  - Negated qualifiers (!key:val1 OR !key:val2)\n" +
      "  - Comparison values (age:>24h OR age:>7d)\n" +
      "  - Regex filters (use alternation instead: key://(a|b)//)\n" +
      "  - Parenthesized groups\n\n" +
      "Alternatives:\n" +
      "  - Write in-list syntax directly: key:[val1,val2]\n" +
      "  - Run separate queries for each term\n\n" +
      "Search syntax: https://docs.sentry.io/concepts/search/",
  );
}

/**
 * Collect the count-unscoped filter keys (see {@link COUNT_UNSCOPED_FILTER_KEYS})
 * present in a query, recursing into parenthesized groups.
 */
function collectUnscopedCountKeys(
  nodes: SearchNode[],
  found: Set<string>,
): void {
  for (const node of nodes) {
    if (node.type === "paren_group") {
      collectUnscopedCountKeys(node.inner, found);
      continue;
    }
    if (
      node.type === "text_filter" ||
      node.type === "text_in_filter" ||
      node.type === "comparison_filter" ||
      node.type === "regex_filter"
    ) {
      const key = node.key.toLowerCase();
      if (COUNT_UNSCOPED_FILTER_KEYS.has(key)) {
        found.add(key);
      }
    }
  }
}

/**
 * Return the filter keys in `query` whose values restrict which issues match
 * but are NOT reflected in the issues-list endpoint's seen-stats
 * (`count`, `userCount`, `firstSeen`, `lastSeen`). See getsentry/cli#1518.
 *
 * Used by `issue list` to decide when to request query-scoped counts.
 * Returns an empty array when the query is absent, unparseable, or contains
 * no such keys.
 *
 * @param query - Raw search query, or `undefined`
 * @returns Lower-cased matching keys (e.g. `["release"]`), deduplicated
 */
export function unscopedCountFilterKeys(query: string | undefined): string[] {
  if (!query) {
    return [];
  }
  const nodes = parseSearchNodes(normalizeQuery(query));
  if (!nodes) {
    // Unparseable query has no keys we can detect; the API will reject it with
    // a proper 400. Nothing actionable here — just skip the count-scope check.
    return [];
  }
  const found = new Set<string>();
  collectUnscopedCountKeys(nodes, found);
  return [...found];
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
    or: "NOT supported — use key:[val1,val2] in-list syntax instead; for is: values use status:[val1,val2] or substatus:[val1,val2]",
    not: "!key:value (prefix with !)",
    comparison: [">=", "<=", ">", "<", "=", "!="],
    wildcard: "* in values (e.g., message:*timeout*)",
    inList: "key:[val1,val2] — matches any value in the list",
    regex:
      "key://pattern// (logs only, string attributes) — RE2, unanchored, case-sensitive ((?i) to ignore case), max 64 chars, never quoted; ends at the first // followed by whitespace, ) or end of query; negate with !key://pattern//",
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
    "is (is:unresolved, is:resolved, is:ignored — no in-list form)",
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
 * Pattern that splits a query into alternating unquoted / preserved segments.
 *
 * Matches double-quoted strings (including escaped quotes inside them) and
 * `key://pattern//` regex values, which end at the first `//` followed by
 * whitespace, `)`, or end of query. Between matches is unquoted text that
 * can be safely normalized.
 */
const REGEX_FILTER_KEY_SOURCE = String.raw`(?:(?:tags|flags)\[[\w.:-]+(?:\[\*\])?(?: *, *(?:string|number|boolean|array))?\]|"[\w.:-]+"|[\w.[\]-]+)(?:\[\*\])?`;
const PRESERVED_SEGMENT_RE = new RegExp(
  String.raw`"(?:[^"\\]|\\.)*"|(?<=(?:^|[\s()"\]])!?${REGEX_FILTER_KEY_SOURCE}:)\/\/(?:(?!\/\/(?:[\t\n )]|$))[^\n])+\/\/(?=[\t\n )]|$)`,
  "g",
);

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
 * Quoted regions (`"..."`) and regex values (`key://pattern//`) are
 * preserved verbatim — only the remaining text is normalized. This prevents
 * `message:"error [500,] found"` and `message://[a-z,]+//` from being
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
 * Splits the query at double-quoted and regex-value boundaries, applies `fn`
 * to each unquoted segment, and re-assembles with the preserved segments
 * untouched.
 */
function transformUnquoted(
  query: string,
  fn: (unquoted: string) => string,
): string {
  if (!(query.includes('"') || query.includes("//"))) {
    return fn(query);
  }

  const parts: string[] = [];
  let lastIndex = 0;

  // Reset the regex state for each call (global regex)
  PRESERVED_SEGMENT_RE.lastIndex = 0;
  let match = PRESERVED_SEGMENT_RE.exec(query);

  while (match !== null) {
    if (match.index > lastIndex) {
      parts.push(fn(query.slice(lastIndex, match.index)));
    }
    parts.push(match[0]);
    lastIndex = match.index + match[0].length;
    match = PRESERVED_SEGMENT_RE.exec(query);
  }

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
  parseSearchNodes,
  isMergeableFilter,
  tryMergeGroup,
  tryRewriteOr,
  serializeNode,
  serializeNodes,
  normalizeQuery,
  transformUnquoted,
};
