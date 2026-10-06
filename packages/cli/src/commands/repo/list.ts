/**
 * sentry repo list
 *
 * List repositories in an organization, with flexible targeting and cursor pagination.
 *
 * Supports:
 * - Auto-detection from DSN/config
 * - Org-scoped listing with cursor pagination (e.g., sentry/)
 * - Project-scoped listing (e.g., sentry/cli) - lists repos for that project's org
 * - Bare org slug (e.g., sentry) - lists repos for that org
 */

import {
  listRepositories,
  listRepositoriesPaginated,
} from "../../lib/api-client.js";
import { escapeMarkdownCell } from "../../lib/formatters/markdown.js";
import { type Column, formatTable } from "../../lib/formatters/table.js";
import {
  buildOrgListCommand,
  type OrgListCommandDocs,
} from "../../lib/list-command.js";
import type { OrgListConfig } from "../../lib/org-list.js";
import {
  type SentryRepository,
  SentryRepositorySchema,
} from "../../types/index.js";

/** Command key for pagination cursor storage */
export const PAGINATION_KEY = "repo-list";

/** Repository with its organization context for display */
type RepositoryWithOrg = SentryRepository & { orgSlug?: string };

/** Column definitions for the repository table. */
const REPO_COLUMNS: Column<RepositoryWithOrg>[] = [
  { header: "ORG", value: (r) => r.orgSlug || "" },
  { header: "NAME", value: (r) => escapeMarkdownCell(r.name) },
  { header: "PROVIDER", value: (r) => r.provider.name },
  { header: "STATUS", value: (r) => r.status },
  { header: "URL", value: (r) => escapeMarkdownCell(r.url || "") },
];

/** Shared config that plugs into the org-list framework. */
const repoListConfig: OrgListConfig<SentryRepository, RepositoryWithOrg> = {
  paginationKey: PAGINATION_KEY,
  entityPlural: "repositories",
  commandPrefix: "sentry repo list",
  listForOrg: (org) => listRepositories(org),
  listPaginated: (org, opts) => listRepositoriesPaginated(org, opts),
  withOrg: (repo, orgSlug) => ({ ...repo, orgSlug }),
  displayTable: (repos: RepositoryWithOrg[]) =>
    formatTable(repos, REPO_COLUMNS),
  schema: SentryRepositorySchema,
};

const docs: OrgListCommandDocs = {
  brief: "List repositories",
  fullDescription:
    "List repositories connected to an organization.\n\n" +
    "Target specification:\n" +
    "  sentry repo list               # auto-detect from DSN or config\n" +
    "  sentry repo list <org>/        # list all repos in org (paginated)\n" +
    "  sentry repo list <org>/<proj>  # list repos in org (project context)\n" +
    "  sentry repo list <org>         # list repos in org\n\n" +
    "Pagination:\n" +
    "  sentry repo list <org>/ -c next  # fetch next page\n" +
    "  sentry repo list <org>/ -c prev  # fetch previous page\n\n" +
    "Examples:\n" +
    "  sentry repo list              # auto-detect or list all\n" +
    "  sentry repo list my-org/      # list repositories in my-org (paginated)\n" +
    "  sentry repo list --limit 10\n" +
    "  sentry repo list --json\n\n" +
    "Alias: `sentry repos` → `sentry repo list`",
};

export const listCommand = buildOrgListCommand(repoListConfig, docs, "repo");
