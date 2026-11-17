/**
 * Output schemas of the `sentry release` commands.
 */

import { vDeployResponse, vOrgReleaseResponse } from "@sentry/api/valibot";
import {
  array,
  boolean,
  description,
  type InferOutput,
  looseObject,
  object,
  optional,
  pipe,
  string,
  union,
} from "valibot";
import { DryRunOutputField } from "./output.js";
import { OrgListItemOutputFields } from "./org-list.js";

const sdkRelease = vOrgReleaseResponse.entries;

/**
 * `--fields` / SKILL.md documentation schema for a release.
 *
 * Curates the user-facing fields of the auto-generated `vOrgReleaseResponse`,
 * like {@link SentryOrganizationSchema}; not used for runtime validation.
 */
export const SentryReleaseSchema = looseObject({
  id: optional(sdkRelease.id),
  version: pipe(string(), description("Release version")),
  shortVersion: optional(sdkRelease.shortVersion),
  versionInfo: optional(sdkRelease.versionInfo),
  status: optional(sdkRelease.status),
  ref: optional(sdkRelease.ref),
  url: optional(sdkRelease.url),
  dateCreated: optional(sdkRelease.dateCreated),
  dateReleased: optional(sdkRelease.dateReleased),
  firstEvent: optional(sdkRelease.firstEvent),
  lastEvent: optional(sdkRelease.lastEvent),
  newGroups: optional(sdkRelease.newGroups),
  commitCount: optional(sdkRelease.commitCount),
  deployCount: optional(sdkRelease.deployCount),
  lastCommit: optional(sdkRelease.lastCommit),
  lastDeploy: optional(sdkRelease.lastDeploy),
  authors: optional(sdkRelease.authors),
  owner: optional(sdkRelease.owner),
  projects: optional(sdkRelease.projects),
  adoptionStages: optional(sdkRelease.adoptionStages),
});

/**
 * Fields the release commands that update a release (`archive`, `restore`,
 * `finalize`) add with `--dry-run`, which prints `{ dryRun, version, org }`
 * instead of the updated release.
 */
export const ReleaseUpdateOutputFields = object({
  dryRun: DryRunOutputField,
  org: optional(pipe(string(), description("Organization slug (--dry-run)"))),
});

/** JSON output of `release archive` and `release restore`. */
export const ReleaseUpdateOutputSchema = looseObject({
  ...SentryReleaseSchema.entries,
  ...ReleaseUpdateOutputFields.entries,
});

/** `--fields` / SKILL.md documentation schema for a deploy. */
export const SentryDeploySchema = looseObject({
  id: vDeployResponse.entries.id,
  environment: vDeployResponse.entries.environment,
  name: optional(vDeployResponse.entries.name),
  url: optional(vDeployResponse.entries.url),
  dateStarted: optional(
    pipe(
      vDeployResponse.entries.dateStarted,
      description("Start date (ISO 8601)"),
    ),
  ),
  dateFinished: optional(
    pipe(
      vDeployResponse.entries.dateFinished,
      description("Finish date (ISO 8601)"),
    ),
  ),
});

/**
 * The fields `--dry-run` changes on the release it reports: the `dryRun`
 * flag, and `projects` as `{ slug }` objects instead of full projects.
 */
export const ReleaseCreateOutputFields = object({
  dryRun: DryRunOutputField,
  projects: optional(
    pipe(
      union([
        SentryReleaseSchema.entries.projects.wrapped,
        array(object({ slug: pipe(string(), description("Project slug")) })),
      ]),
      description("Projects in the release (only slug with --dry-run)"),
    ),
  ),
});

/**
 * JSON output of `release create`: the created release, or with `--dry-run` the release that
 * would be created, in the same shape.
 */
export const ReleaseCreateOutputSchema = looseObject({
  ...SentryReleaseSchema.entries,
  ...ReleaseCreateOutputFields.entries,
});

/** JSON output of `release delete`: the release that was (or, with `--dry-run`, would be) deleted. */
export const ReleaseDeleteOutputSchema = object({
  deleted: pipe(boolean(), description("Whether the release was deleted")),
  org: pipe(string(), description("Organization slug")),
  version: pipe(string(), description("Release version")),
  dryRun: DryRunOutputField,
});

/** JSON output of `release delete`. */
export type ReleaseDeleteOutput = InferOutput<typeof ReleaseDeleteOutputSchema>;

/**
 * Fields `--dry-run` changes: it prints the deploy that would be created,
 * which has no `id` yet, with its release `version`.
 */
export const ReleaseDeployOutputFields = object({
  id: optional(SentryDeploySchema.entries.id),
  dryRun: DryRunOutputField,
  version: optional(pipe(string(), description("Release version (--dry-run)"))),
});

/** JSON output of `release deploy`: the created deploy, or the `--dry-run` preview. */
export const ReleaseDeployOutputSchema = looseObject({
  ...SentryDeploySchema.entries,
  ...ReleaseDeployOutputFields.entries,
});

/** Fields `release finalize --dry-run` prints instead of the finalized release. */
export const ReleaseFinalizeOutputFields = object({
  ...ReleaseUpdateOutputFields.entries,
  released: optional(
    pipe(string(), description("Release date to set (--dry-run)")),
  ),
});

/** JSON output of `release finalize`: the finalized release, or the `--dry-run` preview. */
export const ReleaseFinalizeOutputSchema = looseObject({
  ...SentryReleaseSchema.entries,
  ...ReleaseFinalizeOutputFields.entries,
});

/** Fields `release list` adds to each release: its org and, when listing several projects, its project. */
export const ReleaseListItemOutputFields = object({
  ...OrgListItemOutputFields.entries,
  targetProject: optional(
    pipe(string(), description("Project slug, when listing several")),
  ),
});

/** JSON output of `release list`: each release with {@link ReleaseListItemOutputFields}. */
export const ReleaseListItemSchema = looseObject({
  ...SentryReleaseSchema.entries,
  ...ReleaseListItemOutputFields.entries,
});
