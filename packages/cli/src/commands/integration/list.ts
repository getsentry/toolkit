/**
 * sentry integration list
 *
 * List integrations installed on an organization, with flexible targeting
 * and cursor pagination.
 */

import {
  listIntegrations,
  listIntegrationsPaginated,
} from "../../lib/api-client.js";
import { escapeMarkdownCell } from "../../lib/formatters/markdown.js";
import { type Column, formatTable } from "../../lib/formatters/table.js";
import {
  buildOrgListCommand,
  type OrgListCommandDocs,
} from "../../lib/list-command.js";
import type { OrgListConfig } from "../../lib/org-list.js";
import {
  type SentryIntegration,
  SentryIntegrationSchema,
} from "../../types/index.js";

/** Command key for pagination cursor storage */
export const PAGINATION_KEY = "integration-list";

/** Integration with its organization context for display */
type IntegrationWithOrg = SentryIntegration & { orgSlug?: string };

/** Column definitions for the integration table. */
const INTEGRATION_COLUMNS: Column<IntegrationWithOrg>[] = [
  { header: "ORG", value: (i) => i.orgSlug || "" },
  { header: "ID", value: (i) => i.id },
  { header: "PROVIDER", value: (i) => escapeMarkdownCell(i.provider.name) },
  { header: "NAME", value: (i) => escapeMarkdownCell(i.name) },
  { header: "STATUS", value: (i) => i.organizationIntegrationStatus },
  { header: "DOMAIN", value: (i) => escapeMarkdownCell(i.domainName || "") },
];

/** Shared config that plugs into the org-list framework. */
const integrationListConfig: OrgListConfig<
  SentryIntegration,
  IntegrationWithOrg
> = {
  paginationKey: PAGINATION_KEY,
  entityPlural: "integrations",
  commandPrefix: "sentry integration list",
  listForOrg: (org) => listIntegrations(org),
  listPaginated: (org, opts) => listIntegrationsPaginated(org, opts),
  withOrg: (integration, orgSlug) => ({ ...integration, orgSlug }),
  namesOf: (integration) => [integration.name],
  displayTable: (integrations: IntegrationWithOrg[]) =>
    formatTable(integrations, INTEGRATION_COLUMNS),
  schema: SentryIntegrationSchema,
};

const docs: OrgListCommandDocs = {
  brief: "List installed integrations",
  fullDescription:
    "List integrations installed on an organization (GitHub, GitLab, Slack, Jira, ...).\n\n" +
    "Includes integrations that are disabled or pending deletion.\n\n" +
    "Target specification:\n" +
    "  sentry integration list               # auto-detect from DSN or config\n" +
    "  sentry integration list <org>/        # list all integrations in org (paginated)\n" +
    "  sentry integration list <org>/<proj>  # list integrations in org (project context)\n" +
    "  sentry integration list <org>         # list integrations in org\n\n" +
    "Name filter (searches every page, so it can't be paginated):\n" +
    "  sentry integration list <org>/ github  # fuzzy match on the name\n" +
    "  sentry integration list <org>/ 'git*'  # glob on the name\n" +
    "  sentry integration list 'git*'         # a lone glob filters the auto-detected org(s)\n\n" +
    "Pagination:\n" +
    "  sentry integration list <org>/ -c next  # fetch next page\n" +
    "  sentry integration list <org>/ -c prev  # fetch previous page\n\n" +
    "Alias: `sentry integrations` → `sentry integration list`",
  examples: [
    {
      description: "List installed integrations (auto-detect org)",
      command: "sentry integration list",
    },
    {
      description: "List integrations in a specific org",
      command: "sentry integration list my-org/",
    },
    {
      description: "Fetch the next page",
      command: "sentry integration list my-org/ -c next",
    },
    {
      description: "Only integrations whose name matches a glob",
      command: "sentry integration list my-org/ 'git*'",
    },
    {
      description: "Output as JSON",
      command: "sentry integration list --json",
    },
  ],
};

export const listCommand = buildOrgListCommand(
  integrationListConfig,
  docs,
  "integration",
);
