/**
 * sentry integration list
 *
 * List integrations installed on an organization, with flexible targeting
 * and cursor pagination.
 */

import { tableCell } from "@sentry/toolkit-core/markdown";
import {
  listIntegrations,
  listIntegrationsPaginated,
} from "../../lib/api-client.js";
import { type Column, formatTable } from "../../lib/formatters/table.js";
import {
  buildOrgListCommand,
  type OrgListCommandDocs,
} from "../../lib/list-command.js";
import type { OrgListConfig, WithOrg } from "../../lib/org-list.js";
import type { SentryIntegration } from "../../types/index.js";
import { IntegrationListItemSchema } from "../../generated/output-schemas/integration.js";
import { sentry } from "../../lib/app-identity.js";

/** Command key for pagination cursor storage */
export const PAGINATION_KEY = "integration-list";

/** Integration with its organization context for display */
type IntegrationWithOrg = WithOrg<SentryIntegration>;

/** Column definitions for the integration table. */
const INTEGRATION_COLUMNS: Column<IntegrationWithOrg>[] = [
  { header: "ORG", value: (i) => i.orgSlug || "" },
  { header: "ID", value: (i) => i.id },
  { header: "PROVIDER", value: (i) => tableCell(i.provider.name) },
  { header: "NAME", value: (i) => tableCell(i.name) },
  { header: "STATUS", value: (i) => i.organizationIntegrationStatus },
  { header: "DOMAIN", value: (i) => tableCell(i.domainName || "") },
];

/** Shared config that plugs into the org-list framework. */
const integrationListConfig: OrgListConfig<
  SentryIntegration,
  IntegrationWithOrg,
  typeof IntegrationListItemSchema
> = {
  paginationKey: PAGINATION_KEY,
  entityPlural: "integrations",
  commandPrefix: () => sentry`integration list`,
  listForOrg: (org) => listIntegrations(org),
  listPaginated: (org, opts) => listIntegrationsPaginated(org, opts),
  withOrg: (integration, orgSlug) => ({ ...integration, orgSlug }),
  // The install label (e.g. a GitHub org) and the product (`GitHub`), so
  // `<org>/git*` finds GitHub installs whatever their label.
  namesOf: (integration) => [integration.name, integration.provider.name],
  displayTable: (integrations: IntegrationWithOrg[]) =>
    formatTable(integrations, INTEGRATION_COLUMNS),
  schema: IntegrationListItemSchema,
};

const docs: OrgListCommandDocs = {
  brief: "List installed integrations",
  fullDescription:
    "List integrations installed on an organization (GitHub, GitLab, Slack, Jira, ...).\n\n" +
    "Includes integrations that are disabled or pending deletion.\n\n" +
    "`<org>/<name>` lists integrations whose name or provider matches `<name>`, a glob (`<org>/git*`) or text: exact or partial matches first, then close (fuzzy) matches. A bare `<name>` that is no project does the same in the detected organizations. Name filters can't be combined with --cursor.\n\n" +
    "Alias: `sentry integrations` → `sentry integration list`",
  examples: [
    {
      description: "List installed integrations (auto-detect org)",
      run: "integration list",
    },
    {
      description: "List integrations in a specific org",
      run: "integration list my-org/",
    },
    {
      description: "Fetch the next page",
      run: "integration list my-org/ -c next",
    },
    {
      description: "Only integrations whose name or provider matches a glob",
      run: "integration list 'my-org/git*'",
    },
    {
      description:
        "Integrations named like 'GitHub' (fuzzy when nothing matches exactly)",
      run: "integration list my-org/githb",
    },
    {
      description: "Output as JSON",
      run: "integration list --json",
    },
  ],
};

export const listCommand = buildOrgListCommand(
  integrationListConfig,
  docs,
  "integration",
);
