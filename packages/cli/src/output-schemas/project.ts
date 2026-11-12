/**
 * Output schemas of the `sentry project` commands.
 */

import { vOrganizationProjectResponseDict } from "@sentry/api/valibot";
import {
  description,
  looseObject,
  nullable,
  object,
  optional,
  pipe,
  string,
} from "valibot";
import { orgListItemSchema } from "./org-list.js";

const sdkProject = vOrganizationProjectResponseDict.item.entries;

/**
 * `--fields` / SKILL.md documentation schema for a project.
 *
 * Curates the user-facing fields of the auto-generated list-projects item,
 * like {@link SentryOrganizationSchema}; not used for runtime validation.
 */
export const SentryProjectSchema = looseObject({
  id: pipe(string(), description("Project ID")),
  slug: pipe(string(), description("Project slug")),
  name: pipe(string(), description("Project name")),
  platform: optional(sdkProject.platform),
  platforms: optional(sdkProject.platforms),
  dateCreated: optional(sdkProject.dateCreated),
  firstEvent: optional(sdkProject.firstEvent),
  status: optional(pipe(string(), description("Project status"))),
  isBookmarked: optional(sdkProject.isBookmarked),
  isMember: optional(sdkProject.isMember),
  hasAccess: optional(sdkProject.hasAccess),
  features: optional(sdkProject.features),
  team: optional(sdkProject.team),
  teams: optional(sdkProject.teams),
  environments: optional(sdkProject.environments),
  latestRelease: optional(sdkProject.latestRelease),
  organization: optional(
    pipe(
      looseObject({
        id: pipe(string(), description("Organization ID")),
        slug: pipe(string(), description("Organization slug")),
        name: optional(pipe(string(), description("Organization name"))),
      }),
      description("Organization (detail responses only)"),
    ),
  ),
});

/** JSON output of `project list`: a project and the org it came from. */
export const ProjectListItemSchema = orgListItemSchema(SentryProjectSchema);

/** The field `project view` adds to each project in its JSON output. */
export const ProjectViewOutputFields = object({
  dsn: pipe(nullable(string()), description("Primary DSN")),
});

/** JSON output of `project view`: the project with its primary DSN. */
export const ProjectViewOutputSchema = looseObject({
  ...SentryProjectSchema.entries,
  ...ProjectViewOutputFields.entries,
});
