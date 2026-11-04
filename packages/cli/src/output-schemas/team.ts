/**
 * Output schemas of the `sentry team` commands.
 */

import { vBaseTeam } from "@sentry/api/valibot";
import {
  description,
  looseObject,
  optional,
  partial,
  pick,
  pipe,
  string,
} from "valibot";
import { orgListItemSchema } from "./org-list.js";

/**
 * A team in a Sentry organization.
 *
 * Derived from the auto-generated `vBaseTeam` schema, picking only the
 * fields used in CLI output. All picked fields are widened to optional via
 * `.partial()`, then core identifiers (id, slug, name) are re-required.
 */
export const SentryTeamSchema = looseObject({
  ...partial(
    pick(vBaseTeam, [
      "id",
      "slug",
      "name",
      "dateCreated",
      "isMember",
      "teamRole",
      "memberCount",
    ]),
  ).entries,
  id: pipe(string(), description("Team ID")),
  slug: pipe(string(), description("Team slug")),
  name: pipe(string(), description("Team name")),
  dateCreated: optional(
    pipe(
      vBaseTeam.entries.dateCreated,
      description("Creation date (ISO 8601)"),
    ),
  ),
  isMember: optional(
    pipe(vBaseTeam.entries.isMember, description("Whether you are a member")),
  ),
  teamRole: optional(
    pipe(vBaseTeam.entries.teamRole, description("Your role in the team")),
  ),
  memberCount: optional(
    pipe(vBaseTeam.entries.memberCount, description("Number of members")),
  ),
});

/** JSON output of `team list`: a team and the org it came from. */
export const TeamListItemSchema = orgListItemSchema(SentryTeamSchema);
