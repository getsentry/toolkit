/**
 * sentry attribute list
 *
 * List the attribute keys available on a trace item dataset (spans, logs,
 * or metrics)
 */

import type { SentryContext } from "../../context.js";
import type {
  TraceItemAttributeDataset,
  TraceItemAttributeDefinition,
  TraceItemAttributeValueType,
} from "../../lib/api/traces.js";
import { listTraceItemAttributes } from "../../lib/api-client.js";
import { validateLimit } from "../../lib/arg-parsing.js";
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
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  buildListCommand,
  buildListLimitFlag,
  LIST_MAX_LIMIT,
  LIST_MIN_LIMIT,
  LIST_TARGET_POSITIONAL,
  PERIOD_ALIASES,
} from "../../lib/list-command.js";
import {
  jsonTransformListResult,
  type ListResult,
} from "../../lib/org-list.js";
import { withProgress } from "../../lib/polling.js";
import { resolveOrgOptionalFromArg } from "../../lib/resolve-target.js";
import {
  PERIOD_BRIEF,
  parsePeriod,
  type TimeRange,
  timeRangeToApiParams,
} from "../../lib/time-range.js";

const COMMAND_NAME = "attribute list";

/** Default dataset when `--dataset` is omitted */
const DEFAULT_DATASET = "spans";

/** Default window — matches the MCP server's attribute discovery. */
const DEFAULT_PERIOD = "14d";

/** User-facing dataset names (and aliases) that map to API dataset names. */
const DATASET_ALIASES: Record<string, TraceItemAttributeDataset> = {
  spans: "spans",
  span: "spans",
  logs: "logs",
  log: "logs",
  metrics: "tracemetrics",
  metric: "tracemetrics",
  tracemetrics: "tracemetrics",
};

/** Dataset names shown in help text and validation errors. */
const VALID_DATASETS = ["spans", "logs", "metrics"] as const;

/** API dataset name → canonical user-facing name, for hints. */
const API_TO_USER_DATASET: Record<string, string> = {
  spans: "spans",
  logs: "logs",
  tracemetrics: "metrics",
};

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
  readonly fields?: string[];
};

/**
 * Parse and validate `--dataset`. Accepts canonical names and singular aliases.
 * @internal Exported for testing
 */
export function parseDataset(value: string): TraceItemAttributeDataset {
  const resolved = DATASET_ALIASES[value.trim().toLowerCase()];
  if (!resolved) {
    throw new ValidationError(
      `Invalid dataset "${value}". Must be one of: ${VALID_DATASETS.join(", ")}`,
      "dataset",
    );
  }
  return resolved;
}

/** Characters that cannot appear in an attribute key passed to `--with`. */
const INVALID_WITH_KEY = /[\s"'()]/;

/**
 * Split a comma-separated key list, keeping commas inside brackets so typed
 * keys like `tags[cart.total,number]` stay whole.
 */
function splitKeyList(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "[") {
      depth += 1;
    } else if (char === "]" && depth > 0) {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

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
  for (const raw of values.flatMap(splitKeyList)) {
    const key = raw.trim();
    if (!key) {
      continue;
    }
    if (INVALID_WITH_KEY.test(key)) {
      throw new ValidationError(
        `Invalid attribute key "${key}" for --with. Pass keys as listed by this command, e.g. http.method or tags[cart.total,number].`,
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
  for (const raw of values.flatMap((v) => v.split(","))) {
    const value = raw.trim().toLowerCase();
    if (!value) {
      continue;
    }
    if (!VALID_TYPES.includes(value as TraceItemAttributeValueType)) {
      throw new ValidationError(
        `Invalid attribute type "${raw.trim()}". Must be one of: ${VALID_TYPES.join(", ")}`,
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

/** Shell-quote a key for a copyable command (zsh globs `tags[...]`). */
function shellKey(key: string): string {
  return /^[\w.:-]+$/.test(key) ? key : `'${key}'`;
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
    return `Tip: Group or filter metrics with 'sentry explore ${org}/ --dataset metrics' (-F to group, -q to filter)`;
  }
  const command = dataset === "logs" ? "log list" : "span list";
  const target = project ? `${org}/${project}` : `${org}/<project>`;
  return `Tip: Filter or add to columns with: sentry ${command} ${target} -q "has:${key}" --fields ${shellKey(key)}`;
}

/**
 * Keep at most `limit` rows per attribute type, in the server's order.
 *
 * Sentry's paginator fetches `limit + 1` rows per type to detect another page
 * and returns them all. The extra row only signals that more exist, so drop
 * it; otherwise a full single-type page looks trimmed and the counts are off.
 * @internal Exported for testing
 */
export function dropLookAheadRows(
  data: readonly TraceItemAttributeDefinition[],
  limit: number,
): TraceItemAttributeDefinition[] {
  const seenPerType = new Map<string, number>();
  return data.filter((attribute) => {
    const seen = seenPerType.get(attribute.attributeType) ?? 0;
    seenPerType.set(attribute.attributeType, seen + 1);
    return seen < limit;
  });
}

export const listCommand = buildListCommand(
  "attribute",
  {
    docs: {
      brief: "List attribute keys for spans, logs, or metrics",
      fullDescription:
        "List the attribute keys available on a trace item dataset\n" +
        "Target specification:\n" +
        "  sentry attribute list                      # auto-detect org from DSN or config\n" +
        "  sentry attribute list <org>/               # all projects in the organization\n" +
        "  sentry attribute list <org>/<project>      # one project\n" +
        "  sentry attribute list <project>            # find project across all orgs\n\n" +
        "Examples:\n" +
        "  sentry attribute list --dataset logs --with http.method    # Attributes seen on logs with http.method\n" +
        "  sentry attribute list --type string --search http          # Attributes containing http and are type string\n" +
        "  sentry attribute list --period 24h                         # Get attributes that appeared in the last 24 hours\n" +
        "  sentry attribute list --context                            # Display attribute metadata information\n" +
        "  sentry attribute list --json --fields key,type             # Output in JSON format with specified fields\n\n" +
        "Alias: `sentry attributes` → `sentry attribute list`",
    },
    output: {
      human: formatAttributeList,
      jsonTransform: (
        result: ListResult<AttributeListItem>,
        fields?: string[],
      ) => jsonTransformListResult(result, fields),
    },
    parameters: {
      positional: LIST_TARGET_POSITIONAL,
      flags: {
        dataset: {
          kind: "parsed",
          parse: parseDataset,
          brief: `Dataset to list attributes for (${VALID_DATASETS.join(", ")})`,
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
        period: {
          kind: "parsed",
          parse: parsePeriod,
          brief: PERIOD_BRIEF,
          default: DEFAULT_PERIOD,
        },
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
    async *func(
      this: SentryContext,
      flags: AttributeListFlags,
      target?: string,
    ) {
      const types = parseAttributeTypes(flags.type);
      const withKeys = parseWithKeys(flags.with);
      const { org, project } = await resolveOrgOptionalFromArg(
        target,
        this.cwd,
        COMMAND_NAME,
      );
      const scope = project ? `${org}/${project}` : `${org}/`;

      const { data, nextCursor } = await withProgress(
        { message: "Fetching attributes...", json: flags.json },
        () =>
          listTraceItemAttributes(org, {
            dataset: flags.dataset,
            project: project ? [project] : undefined,
            attributeTypes: types,
            substringMatch: flags.search,
            query: withKeys ? buildWithQuery(withKeys) : undefined,
            context: flags.context,
            perPage: flags.limit,
            ...timeRangeToApiParams(flags.period),
          }).catch((error: unknown): never => {
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

      // The API returns up to --limit + 1 rows *per type* (the extra row only
      // signals more). Drop those look-ahead rows, then show the first --limit
      // by name: without --type, a response holds one page per type and can
      // exceed --limit.
      const sorted = dropLookAheadRows(data, flags.limit).sort(
        compareAttributes,
      );
      const trimmed = sorted.length > flags.limit;
      const items = sorted.slice(0, flags.limit).map(toAttributeListItem);
      const hasMore = trimmed || !!nextCursor;

      const datasetLabel = API_TO_USER_DATASET[flags.dataset] ?? flags.dataset;
      const plural = (n: number) => `attribute${n === 1 ? "" : "s"}`;
      const higherLimit = Math.min(flags.limit * 2, LIST_MAX_LIMIT);
      const more =
        higherLimit > flags.limit
          ? `Use -n ${higherLimit} for more, or narrow with --type or --search.`
          : "Narrow with --type or --search to see the rest.";
      let countText: string | undefined;
      if (trimmed) {
        const total = `${sorted.length}${nextCursor ? "+" : ""}`;
        countText = `Showing ${items.length} of ${total} ${datasetLabel} ${plural(sorted.length)} in ${scope}. ${more}`;
      } else if (nextCursor) {
        countText = `Showing ${items.length} ${datasetLabel} ${plural(items.length)} in ${scope}; more are available. ${more}`;
      } else if (items.length > 0) {
        countText = `Showing ${items.length} ${datasetLabel} ${plural(items.length)} in ${scope}.`;
      }

      const result: ListResult<AttributeListItem> = {
        items,
        hasMore,
        hint:
          [countText, buildUsageTip(flags.dataset, org, project, items)]
            .filter(Boolean)
            .join("\n") || undefined,
      };
      yield new CommandOutput(result);
      return { hint: result.hint };
    },
  },
  // No --cursor / -c: pagination for now. Instead this command makes a single request
  // (up to --limit, max 1000) and users narrow using --type/--search/--with.
  // The per_page parameter is per attribute type, so a single request can return more
  // than --limit rows. The API can also append extra internal attributes, which can
  // cause the results to exceed --limit as well
  { noCursorFlag: true },
);
