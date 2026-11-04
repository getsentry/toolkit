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
  platform: optional(pipe(sdkProject.platform, description("Platform"))),
  platforms: optional(
    pipe(sdkProject.platforms, description("Platforms seen in events")),
  ),
  dateCreated: optional(
    pipe(sdkProject.dateCreated, description("Creation date (ISO 8601)")),
  ),
  firstEvent: optional(
    pipe(sdkProject.firstEvent, description("First event date (ISO 8601)")),
  ),
  status: optional(pipe(string(), description("Project status"))),
  isBookmarked: optional(
    pipe(sdkProject.isBookmarked, description("Whether you bookmarked it")),
  ),
  isMember: optional(
    pipe(sdkProject.isMember, description("Whether you are a member")),
  ),
  hasAccess: optional(
    pipe(sdkProject.hasAccess, description("Whether you have access")),
  ),
  features: optional(
    pipe(sdkProject.features, description("Enabled features")),
  ),
  team: optional(pipe(sdkProject.team, description("Owning team"))),
  teams: optional(pipe(sdkProject.teams, description("Teams with access"))),
  environments: optional(
    pipe(sdkProject.environments, description("Environments seen")),
  ),
  latestRelease: optional(
    pipe(sdkProject.latestRelease, description("Latest release")),
  ),
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
