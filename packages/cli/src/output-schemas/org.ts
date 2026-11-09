/**
 * Output schemas of the `sentry org` commands.
 */

import { vOrganizationSummary } from "@sentry/api/valibot";
import {
  description,
  looseObject,
  object,
  optional,
  pipe,
  string,
} from "valibot";

const sdkOrg = vOrganizationSummary.entries;

/**
 * `--fields` / SKILL.md documentation schema for an organization.
 *
 * Like {@link SentryTeamSchema}, it is not used for runtime validation: it
 * curates the user-facing fields of the auto-generated `vOrganizationSummary`
 * (the list-organizations item). Only core identifiers are required.
 */
export const SentryOrganizationSchema = looseObject({
  id: pipe(string(), description("Organization ID")),
  slug: pipe(string(), description("Organization slug")),
  name: pipe(string(), description("Organization name")),
  dateCreated: optional(sdkOrg.dateCreated),
  status: optional(sdkOrg.status),
  isEarlyAdopter: optional(sdkOrg.isEarlyAdopter),
  require2FA: optional(sdkOrg.require2FA),
  features: optional(sdkOrg.features),
  avatar: optional(sdkOrg.avatar),
  links: optional(sdkOrg.links),
  hasAuthProvider: optional(sdkOrg.hasAuthProvider),
  allowMemberInvite: optional(sdkOrg.allowMemberInvite),
  allowMemberProjectCreation: optional(sdkOrg.allowMemberProjectCreation),
  orgRole: optional(
    pipe(string(), description("Your role in the organization")),
  ),
});

/**
 * The account an organization was listed under (no secrets): a stored
 * account, or the env token's virtual account.
 */
export const OrgListAccountSchema = object({
  /**
   * What `--account` accepts: `<who>:<server>`, e.g.
   * `jane@acme.com:sentry.io` (just `<who>` when no server is recorded), as
   * `sentry auth login` does too; `env:SENTRY_AUTH_TOKEN` for the env token.
   */
  name: pipe(string(), description("What --account accepts")),
  id: pipe(string(), description("Account ID")),
  email: optional(pipe(string(), description("Account email"))),
  username: optional(pipe(string(), description("Account username"))),
  /**
   * The server part of `name`: `host[:port]`, or the full origin such as
   * `http://localhost:8000` for a non-HTTPS server.
   */
  server: optional(pipe(string(), description("Account server"))),
  /** The server's full origin, e.g. `https://sentry.io`. */
  host: optional(pipe(string(), description("Server origin"))),
  /** Human label, e.g. `Jane <jane@acme.com> on sentry.io`. */
  label: pipe(string(), description("Human-readable account label")),
  /** The variable providing the token, for the env token's account. */
  envVar: optional(
    pipe(string(), description("Variable providing the env token")),
  ),
});

/**
 * Fields the list adds to each organization: a region display name and the
 * stored account it was listed under.
 *
 * The `region` field is only present when the user's orgs span multiple
 * regions (e.g. both US and EU). `account` is only present when orgs from
 * several stored accounts are listed. Both are included in JSON output as
 * well, providing context to machine consumers.
 */
export const OrgListEntryFields = object({
  region: optional(
    pipe(string(), description("Region, when orgs span several (e.g. US, EU)")),
  ),
  account: optional(
    pipe(
      OrgListAccountSchema,
      description("Account the org was listed under, across accounts"),
    ),
  ),
});

/** JSON output of `org list`: each organization with {@link OrgListEntryFields}. */
export const OrgListEntrySchema = looseObject({
  ...SentryOrganizationSchema.entries,
  ...OrgListEntryFields.entries,
});
