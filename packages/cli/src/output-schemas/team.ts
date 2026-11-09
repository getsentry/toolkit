/**
 * Output schemas of the `sentry team` commands.
 */

import { vBaseTeam } from "@sentry/api/valibot";
import { description, looseObject, partial, pick, pipe, string } from "valibot";
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
});

/** JSON output of `team list`: a team and the org it came from. */
export const TeamListItemSchema = orgListItemSchema(SentryTeamSchema);
