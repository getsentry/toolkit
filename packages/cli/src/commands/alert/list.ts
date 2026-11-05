import type { SentryContext } from "../../context.js";
import { listAlertsPaginated } from "../../lib/api/alerts.js";
import type { Alert } from "../../lib/api/alerts.js";
import { paginate } from "../../lib/api/infrastructure.js";
import { openInBrowser } from "../../lib/browser.js";
import { parseText } from "../../lib/completion-target.js";
import {
  advancePaginationState,
  hasPreviousPage,
  resolveCursor,
} from "../../lib/db/pagination.js";
import { ValidationError } from "../../lib/errors.js";
import { formatAlertTable } from "../../lib/formatters/alerts.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  buildListCommand,
  buildListLimitFlag,
  LIST_BASE_ALIASES,
  LIST_MAX_LIMIT,
  paginationHint,
} from "../../lib/list-command.js";
import {
  jsonTransformListResult,
  type ListResult,
  type WithOrg,
} from "../../lib/org-list.js";
import { buildAlertsUrl } from "../../lib/sentry-web-urls.js";
import { type OrgTarget, orgTarget } from "../../lib/target-positional.js";
import { shellQuote } from "../../lib/utils.js";
import { AlertListItemSchema } from "../../generated/output-schemas/alert.js";
import { parseMonitorIds } from "./mutation-utils.js";

export const PAGINATION_KEY = "alert-list";
type AlertListResult = ListResult<WithOrg<Alert>>;
type ListFlags = {
  readonly limit: number;
  readonly cursor?: string;
  readonly query?: string;
  readonly project?: string[];
  readonly monitor?: string[];
  readonly web: boolean;
};

export const listCommand = buildListCommand("alert", {
  docs: {
    brief: "List alerts",
    fullDescription:
      "List native alerts in an organization, including alerts with no connected monitors. " +
      "There is no automatic issue-only filtering. --query is the native workflow search query; " +
      "--project and --monitor explicitly filter by project or connected monitor. " +
      "All nested workflow fields remain available in JSON. Use --cursor next/prev or a raw cursor to page.",
    examples: [
      {
        description: "List all accessible alerts, including detached alerts",
        command: "sentry alert list my-org/",
      },
      {
        description: "Filter by a connected monitor",
        command: "sentry alert list my-org/ --monitor 123",
      },
      {
        description: "Search alerts",
        command: 'sentry alert list my-org/ --query "name:Latency"',
      },
    ],
  },
  output: {
    human: (result: AlertListResult) => formatAlertTable(result.items),
    jsonTransform: (result: AlertListResult, fields?: string[]) =>
      jsonTransformListResult(result, fields),
    schema: AlertListItemSchema,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org",
          brief: "Organization slug (auto-detected if omitted)",
          parse: orgTarget,
          optional: true as const,
        },
      ],
    },
    flags: {
      limit: buildListLimitFlag("alerts"),
      query: {
        kind: "parsed",
        parse: parseText,
        optional: true,
        brief: "Native alert search query",
      },
      project: {
        kind: "parsed",
        parse: parseText,
        optional: true,
        variadic: true,
        brief: "Project IDs or slugs (repeatable)",
      },
      monitor: {
        kind: "parsed",
        parse: parseText,
        optional: true,
        variadic: true,
        brief: "Connected monitor IDs (repeatable or comma-separated)",
      },
      web: {
        kind: "boolean",
        brief: "Open alerts in a browser",
        default: false,
      },
    },
    aliases: { ...LIST_BASE_ALIASES, q: "query", w: "web" },
  },
  async *func(this: SentryContext, flags: ListFlags, target: OrgTarget) {
    const { org } = await target.resolved;
    if (flags.web) {
      await openInBrowser(buildAlertsUrl(org), "alerts");
      return;
    }
    if (
      !Number.isInteger(flags.limit) ||
      flags.limit < 1 ||
      flags.limit > LIST_MAX_LIMIT
    ) {
      throw new ValidationError(
        `limit must be between 1 and ${LIST_MAX_LIMIT}.`,
        "limit",
      );
    }
    const monitor =
      flags.monitor === undefined
        ? undefined
        : parseMonitorIds(flags.monitor).map(String);
    const project = flags.project;
    const contextKey = JSON.stringify({
      org,
      limit: flags.limit,
      query: flags.query,
      project,
      monitor,
    });
    const { cursor, direction } = resolveCursor(
      flags.cursor,
      PAGINATION_KEY,
      contextKey,
    );
    const page = await paginate(
      { limit: flags.limit, cursor },
      (perPage, pageCursor) =>
        listAlertsPaginated(org, {
          perPage,
          cursor: pageCursor,
          query: flags.query,
          project,
          monitor,
        }),
    );
    advancePaginationState(
      PAGINATION_KEY,
      contextKey,
      direction,
      page.nextCursor,
      cursor ?? "",
    );
    const hasPrev = hasPreviousPage(PAGINATION_KEY, contextKey);
    yield new CommandOutput({
      items: page.data.map((alert) => ({ ...alert, orgSlug: org })),
      hasMore: !!page.nextCursor,
      nextCursor: page.nextCursor,
      hasPrev,
    } satisfies AlertListResult);
    const suffix = [
      `sentry alert list ${shellQuote(`${org}/`)} --limit ${flags.limit}`,
      ...(flags.query ? [`--query=${shellQuote(flags.query)}`] : []),
      ...(project ?? []).map((value) => `--project=${shellQuote(value)}`),
      ...(monitor ?? []).map((value) => `--monitor=${shellQuote(value)}`),
    ].join(" ");
    return {
      hint: paginationHint({
        hasPrev,
        hasMore: !!page.nextCursor,
        nextHint: `${suffix} --cursor next`,
        prevHint: `${suffix} --cursor prev`,
      }),
    };
  },
});
