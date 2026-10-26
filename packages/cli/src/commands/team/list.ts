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
  namesOf: (team) => [team.slug, team.name],
  searchesNames: true,
  displayTable: (teams: TeamWithOrg[]) => formatTable(teams, TEAM_COLUMNS),
  listForProject: (org, project) => listProjectTeams(org, project),
  schema: SentryTeamSchema,
};

const docs: OrgListCommandDocs = {
  brief: "List teams",
  fullDescription:
    "List teams in an organization.\n\n" +
    "With a glob after the slash (`<org>/back*`), only teams whose slug or name matches are listed. When `<org>/<name>` names no project, `<name>` matches team names instead: exact or partial matches first, then close (fuzzy) matches. Name filters can't be combined with --cursor.\n\n" +
    "Alias: `sentry teams` → `sentry team list`",
  examples: [
    {
      description: "List teams (organization auto-detected)",
      command: "sentry team list",
    },
    {
      description: "List teams in an organization",
      command: "sentry team list my-org/",
    },
    {
      description: "Fetch the next page",
      command: "sentry team list my-org/ -c next",
    },
    {
      description: "Only teams whose slug or name matches a glob",
      command: "sentry team list 'my-org/back*'",
    },
    {
      description:
        "Teams named like 'backend' when no such project exists (fuzzy)",
      command: "sentry team list my-org/backnd",
    },
    { description: "Output as JSON", command: "sentry team list --json" },
  ],
};

export const listCommand = buildOrgListCommand(teamListConfig, docs, "team");
