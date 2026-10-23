/**
 * sentry attribute list
 *
 * List the attribute keys available on a trace item dataset (spans, logs,
 * or metrics)
 */

import type { SentryContext } from "../../context.js";
import { paginate } from "../../lib/api/infrastructure.js";
import type {
  ListTraceItemAttributesOptions,
  TraceItemAttributeDataset,
  TraceItemAttributeDefinition,
  TraceItemAttributeValueType,
} from "../../lib/api/traces.js";
import { listTraceItemAttributes } from "../../lib/api-client.js";
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
  LIST_TARGET_POSITIONAL,
  PERIOD_ALIASES,
  paginationHint,
} from "../../lib/list-command.js";
import {
  jsonTransformListResult,
  type ListResult,
} from "../../lib/org-list.js";
import { withProgress } from "../../lib/polling.js";
import { resolveOrgOptionalFromArg } from "../../lib/resolve-target.js";
import {
  appendPeriodHint,
  serializeTimeRange,
  type TimeRange,
  timeRangeToApiParams,
} from "../../lib/time-range.js";
import { shellQuote } from "../../lib/utils.js";

const COMMAND_NAME = "attribute list";

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
  readonly search?: string;
  readonly with?: readonly string[];
  readonly period: TimeRange;
  readonly context: boolean;
  readonly limit: number;
  readonly json: boolean;
  readonly fresh: boolean;
  readonly cursor?: string;
  readonly fields?: string[];
};

/** Characters that cannot appear in an attribute key passed to `--with`. */
const INVALID_WITH_KEY = /[\s"'()]/;

/**
 * Normalize repeated and/or comma-separated `--with` values into a
 * deduplicated list of attribute keys.
 * @internal Exported for testing
 */
export function parseWithKeys(
  values: readonly string[] | undefined,
): string[] | undefined {
  if (!values?.length) {
    return;
  }
  const keys = new Set<string>();
  for (const key of values.flatMap(parseFieldsList)) {
    if (INVALID_WITH_KEY.test(key)) {
      throw new ValidationError(
        `Invalid attribute key "${key}" for --with. Pass keys as listed by this command, e.g. gen_ai.request.model.`,
        "with",
      );
    }
    keys.add(key);
  }
  return keys.size > 0 ? [...keys] : undefined;
}

/**
 * Build the API `query` for `--with`. The attributes endpoint only uses the
 * key names in its query (values are ignored) and returns keys that co-occur
 * with all of them, so `has:` filters state exactly what it does.
 * @internal Exported for testing
 */
export function buildWithQuery(keys: readonly string[]): string {
  return keys.map((key) => `has:${key}`).join(" ");
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

/** One attribute type's rows for a page, and the cursors around it. */
type TypePage = {
  type: TraceItemAttributeValueType;
  data: TraceItemAttributeDefinition[];
  startCursor?: string;
  nextCursor?: string;
};

/**
 * Fetch up to `limit` keys of one attribute type.
 *
 * The endpoint pages each type separately, so one request per type gives each
 * its own cursor and lets {@link paginate} handle it like any list endpoint.
 */
async function fetchTypePage(
  org: string,
  type: TraceItemAttributeValueType,
  options: Omit<
    ListTraceItemAttributesOptions,
    "attributeTypes" | "perPage" | "cursor"
  >,
  limit: number,
  startCursor: string | undefined,
): Promise<TypePage> {
  const { data, nextCursor } = await paginate(
    { limit, cursor: startCursor },
    async (perPage, cursor) => {
      const page = await listTraceItemAttributes(org, {
        ...options,
        attributeTypes: [type],
        perPage,
        cursor,
      });
      // Sentry returns its look-ahead row (perPage + 1) instead of trimming it
      return { ...page, data: page.data.slice(0, perPage) };
    },
  );
  return { type, data, startCursor, nextCursor };
}

/**
 * Pick up to `limit` rows across types, sorted by name for display.
 * Taken in sorted order by name, then type.
 *
 * @internal Exported for testing
 */
export function selectAcrossTypes(
  pages: readonly TypePage[],
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
  withKeys: readonly string[] | undefined,
): string {
  const parts = [`sentry attribute list ${scope} -c ${direction}`];
  if (flags.dataset !== DEFAULT_DATASET) {
    parts.push(`--dataset ${datasetDisplayName(flags.dataset)}`);
  }
  if (types) {
    parts.push(`--type ${types.join(",")}`);
  }
  if (flags.search) {
    parts.push(`--search ${shellQuote(flags.search)}`);
  }
  for (const key of withKeys ?? []) {
    parts.push(`--with ${shellQuote(key)}`);
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
      "Columns:\n" +
      "  KEY          Name identifier; can be used for other commands in -q/--fields\n" +
      "               e.g. span list -q 'has:tags[cart.total,number]'\n" +
      "  TYPE         Value type of: string, number, boolean, array\n" +
      "  SOURCE       One of: sentry (built-in) or user (set by your SDK)\n" +
      "  ALIASES      Other names the attribute can be queried by\n" +
      "  DESCRIPTION  What the attribute means; deprecated keys name replacements (pass --context)\n" +
      "  EXAMPLES     Sample values seen for the attribute (pass --context)\n\n" +
      "Target specification:\n" +
      "  sentry attribute list                      # auto-detect org from DSN or config\n" +
      "  sentry attribute list <org>/               # all projects in the organization\n" +
      "  sentry attribute list <org>/<project>      # one project\n" +
      "  sentry attribute list <project>            # find project across all orgs\n\n" +
      "Examples:\n" +
      "  sentry attribute list --dataset logs                       # Attributes on logs instead of spans\n" +
      "  sentry attribute list --with gen_ai.request.model          # Attributes seen on spans with gen_ai.request.model\n" +
      "  sentry attribute list --type string --search gen_ai        # Attributes containing gen_ai and are type string\n" +
      "  sentry attribute list --period 24h                         # Get attributes that appeared in the last 24 hours\n" +
      "  sentry attribute list --context                            # Display description and examples for each attribute\n" +
      "  sentry attribute list my-org/ -c next                      # Next page of the previous listing\n" +
      "  sentry attribute list --json --fields key,type             # Output in JSON format with specified fields\n\n" +
      "Alias: `sentry attributes` → `sentry attribute list`",
  },
  output: {
    human: formatAttributeList,
    jsonTransform: (result: ListResult<AttributeListItem>, fields?: string[]) =>
      jsonTransformListResult(result, fields),
  },
  parameters: {
    positional: LIST_TARGET_POSITIONAL,
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
      search: {
        kind: "parsed",
        parse: String,
        brief: "Find attribute keys containing this text (case-sensitive)",
        optional: true,
      },
      with: {
        kind: "parsed",
        parse: String,
        brief:
          "Find attributes that appear on the same items as all of these keys (repeatable, comma-separated)",
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
      s: "search",
    },
  },
  async *func(this: SentryContext, flags: AttributeListFlags, target?: string) {
    const types = parseAttributeTypes(flags.type);
    const withKeys = parseWithKeys(flags.with);
    const { org, project } = await resolveOrgOptionalFromArg(
      target,
      this.cwd,
      COMMAND_NAME,
    );
    const scope = project ? `${org}/${project}` : `${org}/`;

    // Sorted so each type keeps its position in the compound cursor
    const requestTypes = [...(types ?? VALID_TYPES)].sort();
    const contextKey = buildPaginationContextKey("attribute", scope, {
      dataset: flags.dataset,
      type: requestTypes.join(","),
      search: flags.search,
      with: withKeys?.join(","),
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
      substringMatch: flags.search,
      query: withKeys ? buildWithQuery(withKeys) : undefined,
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
              fetchTypePage(
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
            withKeys &&
            error instanceof ApiError &&
            isSearchQueryParseError(error)
          ) {
            throw new ValidationError(
              `Sentry rejected --with ${withKeys.join(",")}${error.detail ? `: ${error.detail}` : ""}`,
              "with",
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
      if (shownOfType >= page.data.length) {
        return page.nextCursor ?? null;
      }
      // Rows cut by --limit come back next page: resume at the start offset
      // (`value:offset:isPrev`) plus the rows shown, not the API's cursor.
      const start = Number(page.startCursor?.split(":")[1] ?? 0);
      return `0:${start + shownOfType}:0`;
    });
    const nextCursor = cursors.some((c) => c !== null)
      ? encodeCompoundCursor(cursors)
      : undefined;
    advancePaginationState(PAGINATION_KEY, contextKey, direction, nextCursor);
    const hasPrev = hasPreviousPage(PAGINATION_KEY, contextKey);
    const hasMore = !!nextCursor;

    const items = shown.map(toAttributeListItem);
    const datasetLabel = datasetDisplayName(flags.dataset);
    const plural = (n: number) => `attribute${n === 1 ? "" : "s"}`;
    const countText =
      items.length > 0
        ? `Showing ${items.length} ${datasetLabel} ${plural(items.length)} in ${scope}${hasMore ? "; more are available" : ""}.`
        : undefined;
    const nav = paginationHint({
      hasPrev,
      hasMore,
      prevHint: pageHint("prev", scope, flags, types, withKeys),
      nextHint: pageHint("next", scope, flags, types, withKeys),
    });

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
