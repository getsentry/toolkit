/**
 * Attribute-specific formatters
 *
 * Provides formatting utilities for displaying Sentry attributes in the CLI.
 */

import type {
  TraceItemAttributeContext,
  TraceItemAttributeDefinition,
} from "../api/traces.js";
import type { ListResult } from "../org-list.js";
import { escapeMarkdownCell } from "./markdown.js";
import { type Column, formatTable } from "./table.js";

/**
 * One attribute key, flattened from the API's attribute definition so that
 * `--fields` can select `key`, `type`, or `source` directly.
 */
export type AttributeListItem = {
  /**
   * Exact key to use in `--query` and `--fields`. Custom non-string
   * attributes use Sentry's typed form, e.g. "tags[cart.total,number]".
   */
  key: string;
  /** Display name without the `tags[...]` wrapper, e.g. "cart.total" */
  name: string;
  /** Value type: "string", "number", "boolean", or "array" */
  type: TraceItemAttributeDefinition["attributeType"];
  /** "sentry" for SDK/convention attributes, "user" for custom attributes */
  source: TraceItemAttributeDefinition["attributeSource"]["source_type"];
  /** Other names that resolve to this attribute, when the API reports any */
  aliases?: string[];
  /**
   * Description, examples, and deprecation info. Present only when requested
   * with `--context` (may be `{}` when the API has no metadata for the key).
   */
  context?: TraceItemAttributeContext;
};

/** Flatten an API attribute definition into an {@link AttributeListItem}. */
export function toAttributeListItem(
  attribute: TraceItemAttributeDefinition,
): AttributeListItem {
  const item: AttributeListItem = {
    key: attribute.key,
    name: attribute.name,
    type: attribute.attributeType,
    source: attribute.attributeSource.source_type,
  };
  if (attribute.secondaryAliases?.length) {
    item.aliases = attribute.secondaryAliases;
  }
  if (attribute.context) {
    item.context = attribute.context;
  }
  return item;
}

/** Max example values shown per row in human output. */
const MAX_EXAMPLES = 3;

/**
 * One-line description for human output: a deprecation note (with the
 * replacement key, when known) followed by the brief.
 * @internal Exported for testing
 */
export function describeAttribute(context: TraceItemAttributeContext): string {
  const parts: string[] = [];
  if (context.isDeprecated) {
    parts.push(
      context.replacementAttribute
        ? `Deprecated, use ${context.replacementAttribute}.`
        : "Deprecated.",
    );
  }
  if (context.brief) {
    parts.push(context.brief);
  }
  return parts.join(" ");
}

const KEY_COLUMNS: Column<AttributeListItem>[] = [
  {
    // The exact key, not the display name: custom non-string attributes only
    // work in --query/--fields in their typed form, e.g. tags[cart.total,number].
    header: "KEY",
    value: (item) => escapeMarkdownCell(item.key),
    minWidth: 24,
  },
  { header: "TYPE", value: (item) => item.type, minWidth: 7 },
  { header: "SOURCE", value: (item) => item.source, minWidth: 6 },
];

const ALIASES_COLUMN: Column<AttributeListItem> = {
  header: "ALIASES",
  value: (item) => escapeMarkdownCell(item.aliases?.join(", ") ?? ""),
};

const COLUMNS: Column<AttributeListItem>[] = [...KEY_COLUMNS, ALIASES_COLUMN];

/** Columns used with `--context`: aliases move after the metadata. */
const CONTEXT_COLUMNS: Column<AttributeListItem>[] = [
  ...KEY_COLUMNS,
  {
    header: "DESCRIPTION",
    value: (item) =>
      escapeMarkdownCell(item.context ? describeAttribute(item.context) : ""),
    minWidth: 20,
  },
  {
    header: "EXAMPLES",
    value: (item) =>
      escapeMarkdownCell(
        (item.context?.examples ?? [])
          .slice(0, MAX_EXAMPLES)
          .map(String)
          .join(", "),
      ),
    truncate: true,
  },
  ALIASES_COLUMN,
];

/** Render a page of attribute keys as a table. */
export function formatAttributeList(
  result: ListResult<AttributeListItem>,
): string {
  if (result.items.length === 0) {
    return "No attributes found.";
  }
  const withContext = result.items.some((item) => item.context !== undefined);
  const table = formatTable(
    result.items,
    withContext ? CONTEXT_COLUMNS : COLUMNS,
  );
  return result.header ? `${result.header}\n\n${table}` : table;
}
