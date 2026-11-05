import type { SentryContext } from "../../context.js";
import {
  listDetectorsPaginated,
  type Monitor,
} from "../../lib/api/detectors.js";
import { paginate } from "../../lib/api/infrastructure.js";
import { openInBrowser } from "../../lib/browser.js";
import { ORG_PROJECT_TARGET, parseText } from "../../lib/completion-target.js";
import {
  formatMonitorList,
  formatMetricMonitorList,
} from "../../lib/formatters/detectors.js";
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
import { DetectorMonitorListItemSchema } from "../../generated/output-schemas/monitor.js";

type MonitorWithOrg = Monitor & { orgSlug: string };
type ListFlags = {
  readonly limit: number;
  readonly cursor?: string;
  readonly query?: string;
  readonly web: boolean;
  readonly fresh: boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

/** Share targeting and pagination between the umbrella and metric-only views. */
export function buildMonitorListCommand(type?: "metric") {
  const path = type ? "monitor metric" : "monitor";
  const noun = type ? "metric monitors" : "monitors";
  const paginationKey = type ? "monitor-metric-list" : "monitor-list";
  const formatList = type ? formatMetricMonitorList : formatMonitorList;
  // Issue streams are opaque alert connections, excluded by Sentry's Monitors UI.
  const typeQuery = type ? "type:metric_issue" : "!type:issue_stream";
  return buildListCommand(path, {
    docs: {
      brief: type ? "List metric monitors" : "List monitors of every type",
      fullDescription:
        `List native ${noun} in detected organizations, one organization (<org>/), or a project (<org>/<project>). ` +
        (type
          ? "Only metric monitors are included. "
          : "Includes metric, cron, uptime, and other monitor types. Internal issue streams used for alert project connections are excluded, matching Sentry's Monitors page. ") +
        "--query is sent to Sentry's native monitor search. Use --cursor next / prev for organization pagination. Type-specific operations live under sentry monitor <type>.",
      examples: [
        { description: `List ${noun}`, command: `sentry ${path} list my-org/` },
        {
          description: "Filter a project's monitors",
          command: `sentry ${path} list my-org/my-project --query 'name:Latency'`,
        },
      ],
    },
    output: {
      schema: DetectorMonitorListItemSchema,
      human: (result: ListResult<MonitorWithOrg>) =>
        result.items.length
          ? formatList(result.items)
          : (result.hint ?? `No ${noun} found.`),
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
        limit: buildListLimitFlag(noun),
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
        const org = await resolveOrgOnlyTarget(
          parsed,
          this.cwd,
          `${path} list`,
        );
        await openInBrowser(buildMonitorsUrl(org), "monitors");
        return;
      }
      const query = flags.query ? `${typeQuery} ${flags.query}` : typeQuery;
      const listAll = async (org: string, project?: string[]) => {
        const page = await paginate({ limit: flags.limit }, (perPage, cursor) =>
          listDetectorsPaginated(org, { perPage, cursor, query, project }),
        );
        return page.data;
      };
      const config: OrgListConfig<Monitor, MonitorWithOrg> = {
        paginationKey: `${paginationKey}:${flags.query ?? ""}`,
        entityPlural: noun,
        commandPrefix: `sentry ${path} list`,
        listForOrg: (org) => listAll(org),
        listPaginated: (org, options) =>
          listDetectorsPaginated(org, { ...options, query }),
        listForProject: async (org, project) => {
          const ids = await resolveProjectIdsInOrg(org, [project]);
          return await listAll(org, ids.map(String));
        },
        withOrg: (monitor, orgSlug) => ({ ...monitor, orgSlug }),
        displayTable: formatList,
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
}

export const listCommand = buildMonitorListCommand();
