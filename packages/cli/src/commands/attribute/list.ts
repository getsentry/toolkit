/**
 * sentry attribute list
 *
 * List the attribute keys available on a trace item dataset (spans, logs,
 * or metrics)
 */

import {
  FilterType,
  parseSearch,
  Token,
} from "@sentry/toolkit-core/search-syntax";
import type { SentryContext } from "../../context.js";
import {
  attributeCursorAfter,
  fetchAttributeTypePage,
  type AttributeTypePage,
} from "../../lib/api/attribute-pagination.js";
import type {
  TraceItemAttributeDataset,
  TraceItemAttributeDefinition,
  TraceItemAttributeValueType,
} from "../../lib/api/traces.js";
import { validateLimit } from "../../lib/arg-parsing.js";
import { buildDatasetParser, datasetDisplayName } from "../../lib/datasets.js";
import {
  advancePaginationState,
  buildPaginationContextKey,
  decodeTargetCursors,
  encodeCompoundCursor,
  hasPreviousPage,
  resolveCursor,
} from "../../lib/db/pagination.js";
import {
  ApiError,
  isSearchQueryParseError,
  ValidationError,
} from "../../lib/errors.js";
import {
  type AttributeListItem,
  formatAttributeList,
  toAttributeListItem,
} from "../../lib/formatters/attribute.js";
import { parseFieldsList } from "../../lib/formatters/json.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  buildListCommand,
  buildListLimitFlag,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  LIST_MIN_LIMIT,
  LIST_PERIOD_FLAG,
  PERIOD_ALIASES,
  paginationHint,
} from "../../lib/list-command.js";
import {
  jsonTransformListResult,
  type ListResult,
} from "../../lib/org-list.js";
import { withProgress } from "../../lib/polling.js";
import {
  type OrgOptionalTarget,
  orgOptionalTarget,
} from "../../lib/target-positional.js";
import {
  appendPeriodHint,
  serializeTimeRange,
  type TimeRange,
  timeRangeToApiParams,
} from "../../lib/time-range.js";
import { shellQuote } from "../../lib/utils.js";

/** Cursor storage key for `-c next` / `-c prev` */
const PAGINATION_KEY = "attribute-list";

/** Default dataset when `--dataset` is omitted */
const DEFAULT_DATASET = "spans";

/** `--dataset` values: the trace item datasets that have attributes. */
const DATASETS = buildDatasetParser(["spans", "logs", "tracemetrics"]);

/** Attribute value types accepted by `--type`. */
const VALID_TYPES: readonly TraceItemAttributeValueType[] = [
  "string",
  "number",
  "boolean",
  "array",
];

type AttributeListFlags = {
  readonly dataset: TraceItemAttributeDataset;
  readonly type?: readonly string[];
  readonly period: TimeRange;
  readonly context: boolean;
  readonly limit: number;
  readonly json: boolean;
  readonly fresh: boolean;
  readonly cursor?: string;
  readonly fields?: string[];
};

/** A parsed filter argument. */
type AttributeFilter = {
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
 *
 * @internal Exported for testing
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
    query: hasTerms.size > 0 ? [...hasTerms].join(" ") : undefined,
    name,
  };
}

/**
 * Normalize repeated and/or comma-separated `--type` values into a
 * deduplicated list of attribute types.
 * @internal Exported for testing
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
    if (!VALID_TYPES.includes(value as TraceItemAttributeValueType)) {
      throw new ValidationError(
        `Invalid attribute type "${raw}". Must be one of: ${VALID_TYPES.join(", ")}`,
        "type",
      );
    }
    types.add(value as TraceItemAttributeValueType);
  }
  return types.size > 0 ? [...types] : undefined;
}

/**
 * Order a page by display name, then type. The API concatenates one result
 * set per attribute type, so without sorting a trimmed page would show only
 * the first type's keys.
 * @internal Exported for testing
 */
export function compareAttributes(
  a: TraceItemAttributeDefinition,
  b: TraceItemAttributeDefinition,
): number {
  return (
    (a.name || a.key).localeCompare(b.name || b.key) ||
    a.attributeType.localeCompare(b.attributeType)
  );
}

/**
 * Build a `Tip:` line showing how to use a attribute keys in other commands.
 * @internal Exported for testing
 */
export function buildUsageTip(
  dataset: TraceItemAttributeDataset,
  org: string,
  project: string | undefined,
  items: readonly AttributeListItem[],
): string | undefined {
  const example = items.find((item) => item.source === "user") ?? items[0];
  if (!example) {
    return;
  }
  const { key } = example;
  if (dataset === "tracemetrics") {
    const target = project ? `${org}/${project}` : `${org}/`;
    return `Tip: Group metrics with: sentry explore ${target} --dataset metrics -m <metric> -F ${shellQuote(key)}`;
  }
  const target = project ? `${org}/${project}` : `${org}/<project>`;
  const command = dataset === "logs" ? "log list" : "span list";
  return `Tip: Filter or add to columns with: sentry ${command} ${target} -q ${shellQuote(`has:${key}`)} --fields ${shellQuote(key)}`;
}

/**
 * Pick up to `limit` rows across types, sorted by name for display.
 * Taken in sorted order by name, then type.
 *
 * @internal Exported for testing
 */
export function selectAcrossTypes(
  pages: readonly Pick<AttributeTypePage, "type" | "data">[],
  limit: number,
): TraceItemAttributeDefinition[] {
  const heads = pages.map(() => 0);
  const picked: TraceItemAttributeDefinition[] = [];
  while (picked.length < limit) {
    let best: { index: number; row: TraceItemAttributeDefinition } | undefined;
    for (const [index, page] of pages.entries()) {
      const row = page.data[heads[index] ?? 0];
      if (row && (!best || compareAttributes(row, best.row) < 0)) {
        best = { index, row };
      }
    }
    if (!best) {
      break;
    }
    picked.push(best.row);
    heads[best.index] = (heads[best.index] ?? 0) + 1;
  }
  return picked.sort(compareAttributes);
}

function pageHint(
  direction: "next" | "prev",
  scope: string,
  flags: AttributeListFlags,
  types: readonly string[] | undefined,
  filter: string | undefined,
): string {
  const filterArg = filter ? ` ${shellQuote(filter)}` : "";
  const parts = [`sentry attribute list ${scope}${filterArg} -c ${direction}`];
  if (flags.dataset !== DEFAULT_DATASET) {
    parts.push(`--dataset ${datasetDisplayName(flags.dataset)}`);
  }
  if (types) {
    parts.push(`--type ${types.join(",")}`);
  }
  appendPeriodHint(parts, flags.period, LIST_PERIOD_FLAG.default);
  if (flags.limit !== LIST_DEFAULT_LIMIT) {
    parts.push(`-n ${flags.limit}`);
  }
  if (flags.context) {
    parts.push("--context");
  }
  return parts.join(" ");
}

export const listCommand = buildListCommand("attribute", {
  docs: {
    brief: "List attribute keys for spans, logs, or metrics",
    fullDescription:
      "List the attribute keys available on spans, logs, or metrics datasets.\n" +
      "Attributes are typed key-value data attached to each span, log or metric sample.\n\n" +
      "Use the exact key to filter data or select fields in other commands.\n" +
      "Built-in and virtual keys can appear even when no matching item was observed.\n" +
      "These are API discovery candidates, not an exhaustive inventory of stored data.\n\n" +
      "Filter (space-separated terms in one argument):\n" +
      "  <text>       Attribute names containing <text> (case-sensitive)\n" +
      "  has:<key>    Attributes seen on the same items as <key>\n\n" +
      "Numeric, boolean, and array custom keys include their type, for example tags[cart.total,number].\n" +
      "Search for their name (cart.total), then use the returned key in queries and fields.",
    examples: [
      {
        description: "List span attribute keys for a project",
        command: "sentry attribute list my-org/my-project",
      },
      {
        description: "List log attribute keys across the whole organization",
        command: "sentry attribute list my-org/ --dataset logs",
      },
      {
        description:
          "String attributes whose names contain gen_ai (case-sensitive)",
        command: "sentry attribute list my-org/ gen_ai --type string",
      },
      {
        description: "Discover candidates alongside an attribute",
        command: "sentry attribute list my-org/ has:gen_ai.request.model",
      },
      {
        description:
          "Discover candidates alongside several keys (one quoted argument)",
        command:
          "sentry attribute list my-org/ 'has:gen_ai.request.model has:gen_ai.usage.input_tokens'",
      },
      {
        description: "Text and has: filters together",
        command: "sentry attribute list my-org/ 'gen_ai has:http.method'",
      },
      {
        description:
          "Discover candidates using the last 24 hours (includes built-in and virtual keys)",
        command: "sentry attribute list my-org/ --period 24h",
      },
      {
        description: "Show descriptions, example values, and deprecation info",
        command: "sentry attribute list my-org/ --context",
      },
      {
        description: "Show more than the default 25",
        command: "sentry attribute list my-org/my-project -n 100",
      },
      {
        description: "Show the next page of the previous listing (same flags)",
        command: "sentry attribute list my-org/my-project -n 100 -c next",
      },
      {
        description: "Filter spans that have a discovered key",
        command:
          "sentry span list my-org/my-project -q 'has:gen_ai.request.model'",
      },
      {
        description: "Find a custom numeric attribute by name",
        command:
          "sentry attribute list my-org/my-project cart.total --type number",
      },
      {
        description: "Show a discovered typed key as a span column",
        command:
          "sentry span list my-org/my-project --fields 'tags[cart.total,number]'",
      },
      {
        description: "Group a metric by a discovered attribute",
        command:
          "sentry explore my-org/ --dataset metrics -m llm.token_usage -F gen_ai.request.model",
      },
      {
        description: "Select fields as JSON",
        command:
          "sentry attribute list my-org/ --json --fields key,type,source",
      },
    ],
  },
  output: {
    human: formatAttributeList,
    jsonTransform: (result: ListResult<AttributeListItem>, fields?: string[]) =>
      jsonTransformListResult(result, fields),
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/project",
          brief:
            "<org>/ (all projects), <org>/<project>, or <project> (search)",
          parse: orgOptionalTarget,
          optional: true,
        },
        {
          placeholder: "filter",
          brief:
            "Text in attribute names and/or has:<key> terms, e.g. 'gen_ai has:http.method'",
          parse: String,
          optional: true,
        },
      ],
    },
    flags: {
      dataset: {
        kind: "parsed",
        parse: DATASETS.parse,
        brief: `Dataset to list attributes for (${DATASETS.names.join(", ")})`,
        default: DEFAULT_DATASET,
      },
      type: {
        kind: "parsed",
        parse: String,
        brief: `Find attributes of these types (${VALID_TYPES.join(", ")}; repeatable, comma-separated)`,
        variadic: true,
        optional: true,
      },
      period: LIST_PERIOD_FLAG,
      limit: {
        ...buildListLimitFlag("attributes"),
        parse: (value: string) =>
          validateLimit(value, LIST_MIN_LIMIT, LIST_MAX_LIMIT),
      },
      context: {
        kind: "boolean",
        brief:
          "Include each attribute's description, examples, and deprecation info (experimental API)",
        default: false,
      },
    },
    aliases: {
      ...PERIOD_ALIASES,
      d: "dataset",
      n: "limit",
    },
  },
  async *func(
    this: SentryContext,
    flags: AttributeListFlags,
    target: OrgOptionalTarget,
    filter?: string,
  ) {
    const types = parseAttributeTypes(flags.type);
    const { query, name } = parseAttributeFilter(filter);
    const { org, project } = await target.resolved;
    const scope = project ? `${org}/${project}` : `${org}/`;
    // Normalized filter, for the cursor's context key and page hints
    const filterText = [name, query].filter(Boolean).join(" ") || undefined;

    // Sorted so each type keeps its position in the compound cursor
    const requestTypes = [...(types ?? VALID_TYPES)].sort();
    const contextKey = buildPaginationContextKey("attribute", scope, {
      dataset: flags.dataset,
      type: requestTypes.join(","),
      filter: filterText,
      period: serializeTimeRange(flags.period),
      limit: String(flags.limit),
    });
    const { cursor, direction } = resolveCursor(
      flags.cursor,
      PAGINATION_KEY,
      contextKey,
    );
    const { startCursors, exhausted } = decodeTargetCursors(
      cursor,
      requestTypes,
    );
    const options = {
      dataset: flags.dataset,
      project: project ? [project] : undefined,
      substringMatch: name,
      query,
      context: flags.context,
      ...timeRangeToApiParams(flags.period),
    };

    const pages = await withProgress(
      { message: "Fetching attributes...", json: flags.json },
      () =>
        Promise.all(
          requestTypes
            .filter((type) => !exhausted.has(type))
            .map((type) =>
              fetchAttributeTypePage(
                org,
                type,
                options,
                flags.limit,
                startCursors.get(type),
              ),
            ),
        ).catch((error: unknown): never => {
          // A key Sentry can't parse is a user input mistake, not a CLI bug.
          if (
            query &&
            error instanceof ApiError &&
            isSearchQueryParseError(error)
          ) {
            throw new ValidationError(
              `Sentry rejected the filter "${query}"${error.detail ? `: ${error.detail}` : ""}`,
            );
          }
          throw error;
        }),
    );

    // Each type returns up to --limit keys; show --limit of them in total.
    const shown = selectAcrossTypes(pages, flags.limit);
    const cursors = requestTypes.map((type) => {
      const page = pages.find((p) => p.type === type);
      if (!page) {
        return null; // exhausted on an earlier page
      }
      const shownOfType = shown.filter(
        (attribute) => attribute.attributeType === type,
      ).length;
      return attributeCursorAfter(page, shownOfType);
    });
    const nextCursor = cursors.some((c) => c !== null)
      ? encodeCompoundCursor(cursors)
      : undefined;
    advancePaginationState(PAGINATION_KEY, contextKey, direction, nextCursor);
    const hasPrev = hasPreviousPage(PAGINATION_KEY, contextKey);
    const hasMore = !!nextCursor;

    const datasetLabel = datasetDisplayName(flags.dataset);
    const plural = (n: number) => `attribute${n === 1 ? "" : "s"}`;
    const countText =
      shown.length > 0
        ? `Showing ${shown.length} ${datasetLabel} ${plural(shown.length)} in ${scope}${hasMore ? "; more are available" : ""}.`
        : undefined;
    const nav = paginationHint({
      hasPrev,
      hasMore,
      prevHint: pageHint("prev", scope, flags, types, filterText),
      nextHint: pageHint("next", scope, flags, types, filterText),
    });

    const items = shown.map(toAttributeListItem);
    const result: ListResult<AttributeListItem> = {
      items,
      hasMore,
      hasPrev,
      nextCursor,
      hint:
        [countText, nav, buildUsageTip(flags.dataset, org, project, items)]
          .filter(Boolean)
          .join("\n") || undefined,
    };
    yield new CommandOutput(result);
    return { hint: result.hint };
  },
});
