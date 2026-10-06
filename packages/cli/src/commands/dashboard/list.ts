/**
 * sentry dashboard list
 *
 * List dashboards in a Sentry organization with cursor-based pagination
 * and optional client-side glob filtering by title.
 */

import picomatch from "picomatch";
import type { SentryContext } from "../../context.js";
import { MAX_PAGINATION_PAGES } from "../../lib/api/infrastructure.js";
import {
  API_MAX_PER_PAGE,
  listDashboardsPaginated,
} from "../../lib/api-client.js";
import { parseOrgProjectArg } from "../../lib/arg-parsing.js";
import { openInBrowser } from "../../lib/browser.js";
import {
  advancePaginationState,
  buildPaginationContextKey,
  hasPreviousPage,
  resolveCursor,
} from "../../lib/db/pagination.js";
import { filterFields } from "../../lib/formatters/json.js";
import { colorTag, escapeMarkdownCell } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { type Column, writeTable } from "../../lib/formatters/table.js";
import { fuzzyMatch } from "../../lib/fuzzy.js";
import {
  buildListCommand,
  buildListLimitFlag,
  paginationHint,
} from "../../lib/list-command.js";
import { withProgress } from "../../lib/polling.js";
import {
  buildDashboardsListUrl,
  buildDashboardUrl,
} from "../../lib/sentry-urls.js";
import type { DashboardListItem } from "../../types/dashboard.js";
import type { Writer } from "../../types/index.js";
import {
  enrichDashboardError,
  parseDashboardListArgs,
  resolveOrgFromTarget,
} from "./resolve.js";

/** Command key for pagination cursor storage */
export const PAGINATION_KEY = "dashboard-list";

type ListFlags = {
  readonly web: boolean;
  readonly fresh: boolean;
  readonly limit: number;
  readonly cursor?: string;
  readonly json: boolean;
  readonly fields?: string[];
};

type DashboardListResult = {
  dashboards: DashboardListItem[];
  orgSlug: string;
  hasMore: boolean;
  hasPrev?: boolean;
  nextCursor?: string;
  /** The title filter used (for empty-state messaging) */
  titleFilter?: string;
  /** All titles seen during fetch (for fuzzy suggestions on empty filter results) */
  allTitles?: string[];
};

// Extended cursor encoding

/**
 * Encode a cursor with an optional dashboard-ID bookmark for mid-page resume.
 *
 * When client-side filtering fills `--limit` partway through a server page,
 * we store the ID of the last processed dashboard so we can resume from that
 * exact position on the next `--cursor last` invocation.
 *
 * @param serverCursor - The server cursor used to fetch the current page (undefined for page 1)
 * @param afterId - Dashboard ID of the last processed item (omit for page-boundary cursors)
 * @returns Encoded cursor string, or undefined if no server cursor and no afterId
 */
export function encodeCursor(
  serverCursor: string | undefined,
  afterId?: string
): string | undefined {
  if (afterId) {
    return `${serverCursor ?? ""}|${afterId}`;
  }
  return serverCursor;
}

/**
 * Decode an extended cursor into a server cursor and an optional resume-after ID.
 *
 * Extended format: `serverCursor|afterId` where `afterId` is a dashboard ID.
 * Plain server cursors (no `|`) pass through unchanged.
 *
 * @param cursor - Raw cursor string from storage
 * @returns Server cursor for the API and optional dashboard ID to skip past
 */
export function decodeCursor(cursor: string): {
  serverCursor: string | undefined;
  afterId: string | undefined;
} {
  const pipeIdx = cursor.lastIndexOf("|");
  if (pipeIdx === -1) {
    return { serverCursor: cursor || undefined, afterId: undefined };
  }
  const afterId = cursor.slice(pipeIdx + 1);
  const serverPart = cursor.slice(0, pipeIdx);
  return {
    serverCursor: serverPart || undefined,
    afterId: afterId || undefined,
  };
}

// Human output

/**
 * Format dashboard list for human-readable terminal output.
 *
 * Renders a table with ID, title (clickable link), and widget count columns.
 * Returns "No dashboards found." for empty results.
 */
function formatDashboardListHuman(result: DashboardListResult): string {
  if (result.dashboards.length === 0) {
    if (result.titleFilter && result.allTitles && result.allTitles.length > 0) {
      // Strip glob metacharacters before fuzzy matching so '*', '?', '['
      // don't inflate Levenshtein distances (e.g. "Error*" → "Error").
      const stripped = result.titleFilter.replace(/[*?[\]]/g, "");
      const similar = fuzzyMatch(
        stripped || result.titleFilter,
        result.allTitles,
        {
          maxResults: 5,
        }
      );
      if (similar.length > 0) {
        return `No dashboards matching '${result.titleFilter}'. Did you mean:\n${similar.map((t) => `  • ${t}`).join("\n")}`;
      }
      return `No dashboards matching '${result.titleFilter}'.`;
    }
    return "No dashboards found.";
  }

  type DashboardRow = {
    id: string;
    title: string;
    widgets: string;
  };

  const rows: DashboardRow[] = result.dashboards.map((d) => {
    const url = buildDashboardUrl(result.orgSlug, d.id);
    return {
      id: d.id,
      title: `${escapeMarkdownCell(d.title ?? "(untitled)")}\n${colorTag("muted", url)}`,
      widgets: String(d.widgetDisplay?.length ?? 0),
    };
  });

  const columns: Column<DashboardRow>[] = [
    { header: "ID", value: (r) => r.id },
    { header: "TITLE", value: (r) => r.title },
    { header: "WIDGETS", value: (r) => r.widgets },
  ];

  const parts: string[] = [];
  const buffer: Writer = { write: (s: string) => parts.push(s) };
  writeTable(buffer, rows, columns);

  return parts.join("").trimEnd();
}

// JSON transform

/**
 * Transform dashboard list result for JSON output.
 *
 * Produces the standard `{ data, hasMore, nextCursor? }` envelope.
 * Field filtering is applied per-element inside `data`.
 */
function jsonTransformDashboardList(
  result: DashboardListResult,
  fields?: string[]
): unknown {
  const items =
    fields && fields.length > 0
      ? result.dashboards.map((d) => filterFields(d, fields))
      : result.dashboards;

  const envelope: Record<string, unknown> = {
    data: items,
    hasMore: result.hasMore,
    hasPrev: !!result.hasPrev,
  };
  if (result.nextCursor) {
    envelope.nextCursor = result.nextCursor;
  }
  return envelope;
}

// Fetch with pagination + optional client-side glob filter

/** Result of the paginated fetch loop */
type FetchResult = {
  dashboards: DashboardListItem[];
  cursorToStore: string | undefined;
  /** All dashboard titles seen during fetch (for fuzzy suggestions when filter matches nothing) */
  allTitles: string[];
};

/** Result of processing a single page of dashboards */
type PageResult = {
  /** Whether the limit was reached on this page */
  filled: boolean;
  /** Cursor bookmark for mid-page resume, if applicable */
  bookmark: string | undefined;
};

/**
 * Process a single page of dashboard data, applying skip logic and
 * optional glob filtering. Pushes matching items into `results`.
 *
 * @param data - Raw page items from the API
 * @param results - Accumulator for matching dashboards
 * @param opts - Processing options
 * @returns Whether the limit was reached and the bookmark cursor if so
 */
function processPage(
  data: DashboardListItem[],
  results: DashboardListItem[],
  opts: {
    limit: number;
    serverCursor: string | undefined;
    afterId: string | undefined;
    glob: ((input: string) => boolean) | undefined;
  }
): PageResult {
  // When resuming mid-page, find the afterId and skip everything up to and
  // including it. If the afterId was deleted between requests, fall through
  // and process the entire page from the start (no results lost).
  let startIdx = 0;
  if (opts.afterId) {
    const afterPos = data.findIndex((d) => d.id === opts.afterId);
    if (afterPos !== -1) {
      startIdx = afterPos + 1;
    }
  }

  for (let i = startIdx; i < data.length; i++) {
    const item = data[i] as DashboardListItem;
    if (!opts.glob || opts.glob((item.title ?? "").toLowerCase())) {
      results.push(item);
      if (results.length >= opts.limit) {
        return {
          filled: true,
          bookmark: encodeCursor(opts.serverCursor, item.id),
        };
      }
    }
  }

  return { filled: false, bookmark: undefined };
}

/**
 * Fetch dashboards with cursor-based pagination, optionally filtering by
 * a glob pattern on the title. Accumulates results up to `limit`, fetching
 * multiple server pages as needed.
 *
 * When a glob filter fills `--limit` mid-page, the returned cursor encodes
 * the dashboard ID of the last processed item so the next invocation can
 * resume from that exact position.
 *
 * @param orgSlug - Organization slug
 * @param opts - Fetch options
 * @returns Fetched dashboards and the cursor to store for the next page
 */
async function fetchDashboards(
  orgSlug: string,
  opts: {
    limit: number;
    perPage: number;
    serverCursor: string | undefined;
    afterId: string | undefined;
    glob: ((input: string) => boolean) | undefined;
  }
): Promise<FetchResult> {
  let { serverCursor, afterId } = opts;
  const results: DashboardListItem[] = [];
  const allTitles: string[] = [];
  let cursorToStore: string | undefined;

  for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
    const { data, nextCursor } = await listDashboardsPaginated(orgSlug, {
      perPage: opts.perPage,
      cursor: serverCursor,
    });

    // Collect all titles for fuzzy suggestions when filtering matches nothing
    if (opts.glob) {
      for (const item of data) {
        allTitles.push(item.title ?? "(untitled)");
      }
    }

    const pageResult = processPage(data, results, {
      limit: opts.limit,
      serverCursor,
      afterId,
      glob: opts.glob,
    });
    afterId = undefined; // only applies to first iteration

    if (pageResult.filled) {
      cursorToStore = pageResult.bookmark;
      // If the bookmark points to the last item on the page, the real
      // resume point is the next server page (no mid-page bookmark needed)
      if (cursorToStore === encodeCursor(serverCursor, data.at(-1)?.id)) {
        cursorToStore = nextCursor;
      }
      break;
    }

    if (!nextCursor) {
      cursorToStore = undefined;
      break;
    }
    serverCursor = nextCursor;
  }

  return { dashboards: results, cursorToStore, allTitles };
}

/**
 * Build the footer hint for the dashboard list command.
 *
 * Shows pagination navigation hints (`-c next` / `-c prev`) when applicable,
 * plus a link to the dashboards page in Sentry.
 */
function buildHint(
  result: DashboardListResult,
  orgSlug: string
): string | undefined {
  const filterArg = result.titleFilter ? ` '${result.titleFilter}'` : "";
  const navRaw = paginationHint({
    hasPrev: !!result.hasPrev,
    hasMore: !!result.hasMore,
    prevHint: `sentry dashboard list ${orgSlug}/${filterArg} -c prev`,
    nextHint: `sentry dashboard list ${orgSlug}/${filterArg} -c next`,
  });
  const nav = navRaw ? ` ${navRaw}` : "";
  const url = buildDashboardsListUrl(orgSlug);

  if (result.dashboards.length === 0) {
    // Empty results — show nav hint if prev/next exist, otherwise nothing
    return nav ? `No dashboards found.${nav}` : undefined;
  }

  return `Showing ${result.dashboards.length} dashboard(s).${nav}\nDashboards: ${url}`;
}

// Command

export const listCommand = buildListCommand("dashboard", {
  docs: {
    brief: "List dashboards",
    fullDescription:
      "List dashboards in a Sentry organization.\n\n" +
      "The optional name argument supports glob patterns for filtering by title.\n" +
      "Glob matching is case-insensitive. Quote patterns to prevent shell expansion.\n\n" +
      "Examples:\n" +
      "  sentry dashboard list                     # auto-detect org\n" +
      "  sentry dashboard list my-org/             # explicit org\n" +
      "  sentry dashboard list my-org/my-project   # org from explicit project\n" +
      "  sentry dashboard list 'Error*'            # filter by title glob\n" +
      "  sentry dashboard list my-org '*API*'      # bare org + filter\n" +
      "  sentry dashboard list my-org/ '*API*'     # org/ + filter\n" +
      "  sentry dashboard list -c next             # next page\n" +
      "  sentry dashboard list -c prev             # previous page\n" +
      "  sentry dashboard list --json              # JSON with pagination envelope\n" +
      "  sentry dashboard list --web",
  },
  output: {
    human: formatDashboardListHuman,
    jsonTransform: jsonTransformDashboardList,
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        placeholder: "org/title-filter",
        brief: "[<org/project>] [<name-glob>]",
        parse: String,
      },
    },
    flags: {
      web: {
        kind: "boolean",
        brief: "Open in browser",
        default: false,
      },
      limit: buildListLimitFlag("dashboards"),
    },
    aliases: { w: "web", n: "limit" },
  },
  async *func(this: SentryContext, flags: ListFlags, ...args: string[]) {
    const { cwd } = this;

    const { targetArg, titleFilter } = parseDashboardListArgs(args);
    const parsed = parseOrgProjectArg(targetArg);
    const orgSlug = await resolveOrgFromTarget(
      parsed,
      cwd,
      "sentry dashboard list <org>/"
    );

    if (flags.web) {
      await openInBrowser(buildDashboardsListUrl(orgSlug), "dashboards");
      return;
    }

    // Resolve pagination cursor (handles "next"/"prev"/"first" keywords)
    // Lowercase the filter in the context key to match the case-insensitive
    // glob matching — 'Error*' and 'error*' produce identical results.
    const contextKey = buildPaginationContextKey("dashboard", orgSlug, {
      ...(titleFilter && { q: titleFilter.toLowerCase() }),
    });
    const { cursor: rawCursor, direction } = resolveCursor(
      flags.cursor,
      PAGINATION_KEY,
      contextKey
    );
    const { serverCursor, afterId } = decodeCursor(rawCursor ?? "");

    const glob = titleFilter
      ? picomatch(titleFilter.toLowerCase(), { dot: true })
      : undefined;

    // When filtering, fetch max-size pages to minimize round trips.
    // When not filtering, cap at the smaller of limit and API max.
    const perPage = glob
      ? API_MAX_PER_PAGE
      : Math.min(flags.limit, API_MAX_PER_PAGE);

    const {
      dashboards: results,
      cursorToStore,
      allTitles,
    } = await withProgress(
      {
        message: `Fetching dashboards${titleFilter ? ` matching '${titleFilter}'` : ""} (up to ${flags.limit})...`,
        json: flags.json,
      },
      () =>
        fetchDashboards(orgSlug, {
          limit: flags.limit,
          perPage,
          serverCursor,
          afterId,
          glob,
        })
    ).catch(async (error: unknown) =>
      enrichDashboardError(error, { orgSlug, operation: "list" })
    );

    // Advance the pagination cursor stack
    advancePaginationState(
      PAGINATION_KEY,
      contextKey,
      direction,
      cursorToStore
    );

    const hasMore = !!cursorToStore;
    const hasPrev = hasPreviousPage(PAGINATION_KEY, contextKey);

    const outputData: DashboardListResult = {
      dashboards: results,
      orgSlug,
      hasMore,
      hasPrev: hasPrev || undefined,
      nextCursor: cursorToStore,
      titleFilter,
      allTitles,
    };
    yield new CommandOutput(outputData);

    return { hint: buildHint(outputData, orgSlug) };
  },
});
