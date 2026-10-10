/**
 * sentry team list
 *
 * List teams in an organization, with flexible targeting and cursor pagination.
 *
 * Supports:
 * - Auto-detection from DSN/config
 * - Org-scoped listing with cursor pagination (e.g., sentry/)
 * - Project-scoped listing (e.g., sentry/cli) - lists teams for that project's org
 * - Cross-org project search (e.g., sentry)
 */

import {
  listProjectTeams,
  listTeams,
  listTeamsPaginated,
} from "../../lib/api-client.js";
import { escapeMarkdownCell } from "../../lib/formatters/markdown.js";
import { type Column, formatTable } from "../../lib/formatters/table.js";
import {
  buildOrgListCommand,
  type OrgListCommandDocs,
} from "../../lib/list-command.js";
import type { OrgListConfig } from "../../lib/org-list.js";
import { type SentryTeam, SentryTeamSchema } from "../../types/index.js";

/** Command key for pagination cursor storage */
export const PAGINATION_KEY = "team-list";

/** Team with its organization context for display */
type TeamWithOrg = SentryTeam & { orgSlug?: string };

/** Column definitions for the team table. */
const TEAM_COLUMNS: Column<TeamWithOrg>[] = [
  { header: "ORG", value: (t) => t.orgSlug || "" },
  { header: "SLUG", value: (t) => t.slug },
  { header: "NAME", value: (t) => escapeMarkdownCell(t.name) },
  {
    header: "MEMBERS",
    value: (t) => String(t.memberCount ?? ""),
    align: "right",
  },
];

/** Shared config that plugs into the org-list framework. */
const teamListConfig: OrgListConfig<SentryTeam, TeamWithOrg> = {
  paginationKey: PAGINATION_KEY,
  entityPlural: "teams",
  commandPrefix: "sentry team list",
  listForOrg: (org) => listTeams(org),
  listPaginated: (org, opts) => listTeamsPaginated(org, opts),
  withOrg: (team, orgSlug) => ({ ...team, orgSlug }),
  displayTable: (teams: TeamWithOrg[]) => formatTable(teams, TEAM_COLUMNS),
  listForProject: (org, project) => listProjectTeams(org, project),
  schema: SentryTeamSchema,
};

const docs: OrgListCommandDocs = {
  brief: "List teams",
  fullDescription:
    "List teams in an organization.\n\n" +
    "Target specification:\n" +
    "  sentry team list               # auto-detect from DSN or config\n" +
    "  sentry team list <org>/        # list all teams in org (paginated)\n" +
    "  sentry team list <org>/<proj>  # list teams in org (project context)\n" +
    "  sentry team list <org>         # list teams in org\n\n" +
    "Pagination:\n" +
    "  sentry team list <org>/ -c next  # fetch next page\n" +
    "  sentry team list <org>/ -c prev  # fetch previous page\n\n" +
    "Examples:\n" +
    "  sentry team list              # auto-detect or list all\n" +
    "  sentry team list my-org/      # list teams in my-org (paginated)\n" +
    "  sentry team list --limit 10\n" +
    "  sentry team list --json\n\n" +
    "Alias: `sentry teams` → `sentry team list`",
};

export const listCommand = buildOrgListCommand(teamListConfig, docs, "team");
