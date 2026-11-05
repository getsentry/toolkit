import type { SentryContext } from "../../context.js";
import {
  listMetricMonitorsPaginated,
  type MetricMonitor,
} from "../../lib/api/detectors.js";
import { paginate } from "../../lib/api/infrastructure.js";
import { openInBrowser } from "../../lib/browser.js";
import { ORG_PROJECT_TARGET, parseText } from "../../lib/completion-target.js";
import { formatMetricMonitorList } from "../../lib/formatters/detectors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  buildListCommand,
  buildListLimitFlag,
  LIST_BASE_ALIASES,
} from "../../lib/list-command.js";
import {
  dispatchOrgScopedList,
  jsonTransformListResult,
  type ListResult,
  type OrgListConfig,
} from "../../lib/org-list.js";
import {
  resolveOrgOnlyTarget,
  resolveProjectIdsInOrg,
} from "../../lib/resolve-target.js";
import { buildMonitorsUrl } from "../../lib/sentry-web-urls.js";
import {
  listTarget,
  type ListCommandTarget,
} from "../../lib/target-positional.js";
import { MetricMonitorListItemSchema } from "../../generated/output-schemas/monitor.js";

export const PAGINATION_KEY = "monitor-list";
type MonitorWithOrg = MetricMonitor & { orgSlug: string };
type ListFlags = {
  readonly limit: number;
  readonly cursor?: string;
  readonly query?: string;
  readonly web: boolean;
  readonly fresh: boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

export const listCommand = buildListCommand("monitor", {
  docs: {
    brief: "List metric monitors",
    fullDescription:
      "List native metric detectors in detected organizations, one organization (<org>/), or a project (<org>/<project>). --query is sent to Sentry's monitor search alongside the metric_issue type filter. Use --cursor next / prev for organization pagination. Cron monitors live at sentry monitor cron list.",
    examples: [
      {
        description: "List metric monitors",
        command: "sentry monitor list my-org/",
      },
      {
        description: "Filter a project's monitors",
        command: "sentry monitor list my-org/my-project --query 'name:Latency'",
      },
    ],
  },
  output: {
    schema: MetricMonitorListItemSchema,
    human: (result: ListResult<MonitorWithOrg>) =>
      result.items.length
        ? formatMetricMonitorList(result.items)
        : (result.hint ?? "No metric monitors found."),
    jsonTransform: (result: ListResult<MonitorWithOrg>, fields?: string[]) =>
      jsonTransformListResult(result, fields),
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "target",
          brief: "Organization or project target",
          parse: listTarget(ORG_PROJECT_TARGET),
          optional: true,
        },
      ],
    },
    flags: {
      limit: buildListLimitFlag("metric monitors"),
      query: {
        kind: "parsed",
        parse: parseText,
        optional: true,
        brief: "Native monitor search query",
      },
      web: {
        kind: "boolean",
        default: false,
        brief: "Open monitors in the browser",
      },
    },
    aliases: { ...LIST_BASE_ALIASES, q: "query", w: "web" },
  },
  async *func(
    this: SentryContext,
    flags: ListFlags,
    target: ListCommandTarget,
  ) {
    const { parsed } = await target.resolved;
    if (flags.web) {
      const org = await resolveOrgOnlyTarget(parsed, this.cwd, "monitor list");
      await openInBrowser(buildMonitorsUrl(org), "monitors");
      return;
    }
    const listAll = async (org: string, project?: string[]) => {
      const page = await paginate({ limit: flags.limit }, (perPage, cursor) =>
        listMetricMonitorsPaginated(org, {
          perPage,
          cursor,
          query: flags.query,
          project,
        }),
      );
      return page.data;
    };
    const config: OrgListConfig<MetricMonitor, MonitorWithOrg> = {
      paginationKey: `${PAGINATION_KEY}:${flags.query ?? ""}`,
      entityPlural: "metric monitors",
      commandPrefix: "sentry monitor list",
      listForOrg: (org) => listAll(org),
      listPaginated: (org, options) =>
        listMetricMonitorsPaginated(org, { ...options, query: flags.query }),
      listForProject: async (org, project) => {
        const ids = await resolveProjectIdsInOrg(org, [project]);
        return await listAll(org, ids.map(String));
      },
      withOrg: (monitor, orgSlug) => ({ ...monitor, orgSlug }),
      displayTable: formatMetricMonitorList,
    };
    const result = await dispatchOrgScopedList({
      config,
      cwd: this.cwd,
      flags,
      parsed,
    });
    yield new CommandOutput(result);
    return { hint: result.items.length ? result.hint : undefined };
  },
});
