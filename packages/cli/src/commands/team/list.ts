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

import { tableCell } from "@sentry/toolkit-core/markdown";
import {
  listProjectTeams,
  listTeams,
  listTeamsPaginated,
} from "../../lib/api-client.js";
import { type Column, formatTable } from "../../lib/formatters/table.js";
import {
  buildOrgListCommand,
  type OrgListCommandDocs,
} from "../../lib/list-command.js";
import type { OrgListConfig, WithOrg } from "../../lib/org-list.js";
import type { SentryTeam } from "../../types/index.js";
import { TeamListItemSchema } from "../../generated/output-schemas/team.js";
import { sentry } from "../../lib/app-identity.js";

/** Command key for pagination cursor storage */
export const PAGINATION_KEY = "team-list";

/** Team with its organization context for display */
type TeamWithOrg = WithOrg<SentryTeam>;

/** Column definitions for the team table. */
const TEAM_COLUMNS: Column<TeamWithOrg>[] = [
  { header: "ORG", value: (t) => t.orgSlug || "" },
  { header: "SLUG", value: (t) => t.slug },
  { header: "NAME", value: (t) => tableCell(t.name) },
  {
    header: "MEMBERS",
    value: (t) => String(t.memberCount ?? ""),
    align: "right",
  },
];

/** Shared config that plugs into the org-list framework. */
const teamListConfig: OrgListConfig<
  SentryTeam,
  TeamWithOrg,
  typeof TeamListItemSchema
> = {
  paginationKey: PAGINATION_KEY,
  entityPlural: "teams",
  commandPrefix: () => sentry`team list`,
  listForOrg: (org) => listTeams(org),
  listPaginated: (org, opts) => listTeamsPaginated(org, opts),
  withOrg: (team, orgSlug) => ({ ...team, orgSlug }),
  namesOf: (team) => [team.slug, team.name],
  searchesNames: true,
  displayTable: (teams: TeamWithOrg[]) => formatTable(teams, TEAM_COLUMNS),
  listForProject: (org, project) => listProjectTeams(org, project),
  schema: TeamListItemSchema,
};

const docs: OrgListCommandDocs = {
  brief: "List teams",
  fullDescription:
    "List teams in an organization.\n\n" +
    "With a glob after the slash (`<org>/back*`), only teams whose slug or name matches are listed. When `<name>` or `<org>/<name>` names no project, `<name>` matches team names instead: exact or partial matches first, then close (fuzzy) matches. Name filters can't be combined with --cursor.\n\n" +
    "Alias: `sentry teams` → `sentry team list`",
  examples: [
    {
      description: "List teams (organization auto-detected)",
      run: "team list",
    },
    {
      description: "List teams in an organization",
      run: "team list my-org/",
    },
    {
      description: "Fetch the next page",
      run: "team list my-org/ -c next",
    },
    {
      description: "Only teams whose slug or name matches a glob",
      run: "team list 'my-org/back*'",
    },
    {
      description:
        "Teams named like 'backend' when no such project exists (fuzzy)",
      run: "team list my-org/backnd",
    },
    { description: "Output as JSON", run: "team list --json" },
  ],
};

export const listCommand = buildOrgListCommand(teamListConfig, docs, "team");
