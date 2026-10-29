/**
 * Parsers for `sentry attribute list` input: the filter positional
 * (free text and `has:` terms, via the shared search grammar) and `--type`.
 */

import { parseSearch } from "@sentry/search-syntax/parser";
import { FilterType, Token } from "@sentry/search-syntax/tokens";
import type { TraceItemAttributeValueType } from "./api/traces.js";
import { ValidationError } from "./errors.js";
import { parseFieldsList } from "./formatters/json.js";

/** Attribute value types accepted by `--type`. */
export const ATTRIBUTE_TYPES: readonly TraceItemAttributeValueType[] = [
  "string",
  "number",
  "boolean",
  "array",
];

/** A parsed filter argument. */
export type AttributeFilter = {
  /** The `has:` terms, as Sentry's `query`: keys must co-occur with all of them */
  query?: string;
  /** The free text: Sentry matches it as a substring of attribute names */
  name?: string;
};

/**
 * Parse the filter with the shared search parser. `has:` terms go to Sentry
 * as the `query` and free text as the `substringMatch`. The attributes
 * endpoint only uses key names, so values and negation are not supported.
 * OR is not supported.
 *
 * TODO: support globbing/fuzzy search
 */
export function parseAttributeFilter(
  filter: string | undefined,
): AttributeFilter {
  if (!filter?.trim()) {
    return {};
  }
  const tokens = parseSearch(filter);
  if (!tokens) {
    throw new ValidationError(`Couldn't parse the filter "${filter}".`);
  }
  const hasTerms = new Set<string>();
  const names: string[] = [];
  for (const token of tokens) {
    if (token.type === Token.SPACES) {
      continue;
    }
    if (
      token.type === Token.FILTER &&
      token.filter === FilterType.HAS &&
      !token.negated &&
      token.value.text
    ) {
      hasTerms.add(token.text);
    } else if (token.type === Token.FREE_TEXT) {
      names.push(token.value.trim());
    } else {
      throw new ValidationError(
        `Unsupported filter "${token.text.trim()}". The filter accepts a search term and/or has:<key> terms (no values, negation, or OR).`,
      );
    }
  }
  const name = names.join(" ") || undefined;
  if (name && /\s/.test(name)) {
    throw new ValidationError(
      `The filter accepts a single search term, got "${name}".`,
    );
  }
  if (name && /[*?]/.test(name)) {
    throw new ValidationError(
      `Globs aren't supported in the filter ("${name}"). Use plain text.`,
    );
  }
  return {
    query: hasTerms.size > 0 ? Array.from(hasTerms).join(" ") : undefined,
    name,
  };
}

/** Whether `value` is one of the attribute types `--type` accepts. */
function isTraceItemAttributeValueType(
  value: string,
): value is TraceItemAttributeValueType {
  return ATTRIBUTE_TYPES.includes(value as TraceItemAttributeValueType);
}

/**
 * Normalize repeated and/or comma-separated `--type` values into a
 * deduplicated list of attribute types.
 */
export function parseAttributeTypes(
  values: readonly string[] | undefined,
): TraceItemAttributeValueType[] | undefined {
  if (!values?.length) {
    return;
  }
  const types = new Set<TraceItemAttributeValueType>();
  for (const raw of values.flatMap(parseFieldsList)) {
    const value = raw.toLowerCase();
    if (!isTraceItemAttributeValueType(value)) {
      throw new ValidationError(
        `Invalid attribute type "${raw}". Must be one of: ${ATTRIBUTE_TYPES.join(", ")}`,
        "type",
      );
    }
    types.add(value);
  }
  return types.size > 0 ? Array.from(types) : undefined;
}
