/**
 * Session constraints (`sentry mcp <org>/[<project>]`, hosted URL
 * constraints) applied to command calls.
 *
 * The runner passes the constrained organization and project to the SDK as
 * the default target (`SENTRY_ORG`/`SENTRY_PROJECT`), which every command
 * uses when a call names no target. This module checks the targets a call
 * does name and refuses one outside the session, or rewrites a bare project
 * into the session's organization. Opaque identifiers (numeric issue IDs,
 * short IDs) carry no organization to check here.
 */

import { UserInputError } from "../errors";
import type { CommandCatalogEntry, JsonSchema } from "../command-catalog";
import type { Constraints } from "../types";
import { commandName } from "./commands";

/** Completion kinds whose positional names a target. */
const TARGET_KINDS = new Set(["org", "org/project", "dashboard", "issue"]);

const URL_PATTERN = /^https?:\/\//i;

type Session = { org: string; project: string | null };

function outside(
  entry: CommandCatalogEntry,
  value: string,
  session: Session,
): UserInputError {
  const scope = session.project
    ? `${session.org}/${session.project}`
    : `${session.org}/`;
  return new UserInputError(
    `\`${commandName(entry)}\` was called with ${JSON.stringify(value)}, which is outside this session's scope (${scope}). Name a target in ${scope}, or leave the target out to use it.`,
  );
}

/**
 * The organization and project a Sentry web URL names, read the way the
 * CLI's URL parser reads them: the org from `/organizations/<org>/`,
 * `/settings/<org>/`, or an `<org>.sentry.io` subdomain; the project from
 * `.../projects/<project>/` or a feedback link's `feedbackSlug=<project>:<id>`.
 */
function urlTarget(value: string): { org?: string; project?: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {};
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const [subdomain, ...rest] = url.hostname.split(".");
  // `acme.sentry.io`, but not `sentry.io`, a region host (`us.sentry.io`),
  // or a self-hosted host.
  const subdomainOrg =
    rest.join(".") === "sentry.io" && subdomain && subdomain.length > 2
      ? subdomain
      : undefined;
  const pathOrg =
    (segments[0] === "organizations" ||
      (segments[0] === "settings" && segments[1] !== "projects")) &&
    segments[1]
      ? segments[1]
      : undefined;
  const projectsAt = segments.indexOf("projects");
  const project =
    (projectsAt >= 0 ? segments[projectsAt + 1] : undefined) ??
    url.searchParams.get("feedbackSlug")?.split(":")[0] ??
    undefined;
  return {
    org: pathOrg ?? subdomainOrg,
    ...(project ? { project } : {}),
  };
}

/**
 * Refuse a Sentry URL for another organization, or for another project in a
 * project session.
 *
 * @returns Whether `value` is a URL
 */
function checkUrl(
  entry: CommandCatalogEntry,
  value: string,
  session: Session,
): boolean {
  if (!URL_PATTERN.test(value)) {
    return false;
  }
  const target = urlTarget(value);
  if (
    (target.org && target.org !== session.org) ||
    (session.project && target.project && target.project !== session.project)
  ) {
    throw outside(entry, value, session);
  }
  return true;
}

/** The title of positional `index`, such as `org/project/trace-id`. */
function positionalTitle(
  positional: JsonSchema | undefined,
  index: number,
): string | undefined {
  const prefix = positional?.prefixItems ?? [];
  const item = index < prefix.length ? prefix[index] : positional?.items;
  return item ? item.title : undefined;
}

/**
 * The completion kind of positional `index`. A variadic positional has one
 * kind; only its first word names a target (`[<org/project>] <title>`),
 * except for issues and `[<org>/]<id>` lists, where every word can.
 */
function positionalKind(
  entry: CommandCatalogEntry,
  index: number,
): string | undefined {
  const kinds = entry.completions?.positional ?? [];
  if (entry.parameters.properties?.positional?.prefixItems) {
    return kinds[index] ?? undefined;
  }
  const kind = kinds[0] ?? undefined;
  return index === 0 || kind === "issue" || kind === "org" ? kind : undefined;
}

/**
 * Check one positional that names a target, and rewrite a bare project
 * (`web`, a project search across organizations) to `<org>/web`.
 *
 * @param leading - The first of several words, which the CLI reads as the
 *   organization in `<org> <id>`
 */
function pinTarget(
  entry: CommandCatalogEntry,
  value: string,
  kind: string,
  catalogTitle: string,
  leading: boolean,
  session: Session,
): string {
  if (URL_PATTERN.test(value)) {
    return value;
  }
  // `target` is `<org>/`, `<org>/<project>`, or `<project>`.
  const title = catalogTitle === "target" ? "org/project" : catalogTitle;
  const segments = value.split("/");
  const titleSegments = title.split("/");
  if (segments.length === 1) {
    const orgWord = title === "org" || (leading && titleSegments[0] === "org");
    if (kind === "org" && orgWord && value !== session.org) {
      throw outside(entry, value, session);
    }
    if (kind === "org/project" && title === "org/project") {
      if (session.project && value !== session.project) {
        throw outside(entry, value, session);
      }
      return `${session.org}/${value}`;
    }
    return value;
  }
  // `<org>/...`: a target whose first segment is the organization. A
  // one-word title (`feedback`, `replay-id-or-url`) takes `<org>/...` too;
  // a slashed title not led by `org` (`trace-id/span-id`) doesn't.
  if (
    titleSegments[0] === "org" ||
    titleSegments.length === 1 ||
    kind === "issue" ||
    kind === "dashboard"
  ) {
    if (segments[0] !== session.org) {
      throw outside(entry, value, session);
    }
    // `<org>/` (every project) becomes the session's project.
    if (
      session.project &&
      kind === "org/project" &&
      title === "org/project" &&
      value === `${session.org}/`
    ) {
      return `${session.org}/${session.project}`;
    }
    // `<org>/<project>/...`, or `<org>/<project>/<suffix>` under a
    // one-word title (`feedback`, `issue`).
    const namesProject =
      titleSegments.length === 1
        ? segments.length >= 3
        : titleSegments[1] === "project" &&
          segments.length >= titleSegments.length;
    const project = segments[1];
    if (
      session.project &&
      namesProject &&
      project &&
      project !== session.project
    ) {
      throw outside(entry, value, session);
    }
  }
  return value;
}

/**
 * The organization and project a `sentry api` endpoint names, or `undefined`
 * for an endpoint not scoped to one (`issues/1/`, `organizations/`).
 */
function apiEndpointTarget(
  endpoint: string,
): { org: string; project?: string } | undefined {
  // Resolve the path as the request will (`..`, `%2e%2e`), so a dot segment
  // cannot leave the organization it names first.
  let segments: string[];
  try {
    const base = "https://sentry.invalid/api/0/";
    const url = URL_PATTERN.test(endpoint)
      ? new URL(endpoint)
      : new URL(endpoint.replace(/^\/*(?:api\/0(?:\/|$))?/, ""), base);
    segments = url.pathname.split("/").filter(Boolean);
  } catch {
    return;
  }
  if (segments[0] === "api" && segments[1] === "0") {
    segments.splice(0, 2);
  }
  // The prefixes the CLI reads a target from (`parseOrgProjectFromApiPath`).
  const [prefix, org, ...tail] = segments;
  if (!org) {
    return;
  }
  if (prefix === "organizations") {
    return tail[0] === "projects" && tail[1]
      ? { org, project: tail[1] }
      : { org };
  }
  if (prefix === "projects") {
    return tail[0] ? { org, project: tail[0] } : { org };
  }
  if (prefix === "teams") {
    return { org };
  }
  return;
}

function pinApiEndpoint(
  entry: CommandCatalogEntry,
  endpoint: string,
  session: Session,
): void {
  const target = apiEndpointTarget(endpoint);
  if (!target) {
    throw new UserInputError(
      `\`${commandName(entry)}\` was called with ${JSON.stringify(endpoint)}, which is not scoped to an organization. In this session, use an endpoint under organizations/${session.org}/, teams/${session.org}/${session.project ? `, or projects/${session.org}/${session.project}/` : ""}.`,
    );
  }
  if (
    target.org !== session.org ||
    (session.project && target.project && target.project !== session.project)
  ) {
    throw outside(entry, endpoint, session);
  }
}

/**
 * Apply the session's constraints to a validated call. Returns the
 * positional arguments to run, rewritten where a bare project needed the
 * session's organization.
 *
 * @throws {UserInputError} When the call names a target outside the session
 */
export function pinConstraints(
  entry: CommandCatalogEntry,
  positional: string[],
  flags: Record<string, unknown>,
  constraints: Constraints,
): string[] {
  const org = constraints.organizationSlug;
  if (!org) {
    return positional;
  }
  const session: Session = { org, project: constraints.projectSlug ?? null };

  // `--project` (`release create`, `alert metrics create`): one slug, or
  // several, repeated or comma-separated.
  if (session.project) {
    for (const item of [flags.project].flat()) {
      if (typeof item !== "string") {
        continue;
      }
      for (const slug of item.split(",")) {
        if (slug.trim() && slug.trim() !== session.project) {
          throw outside(entry, item, session);
        }
      }
    }
  }
  for (const value of Object.values(flags)) {
    for (const item of [value].flat()) {
      if (typeof item === "string") {
        checkUrl(entry, item, session);
      }
    }
  }

  if (entry.permission === "method") {
    const [endpoint] = positional;
    if (endpoint !== undefined) {
      pinApiEndpoint(entry, endpoint, session);
    }
    return positional;
  }

  const schema = entry.parameters.properties?.positional;
  return positional.map((value, index) => {
    if (checkUrl(entry, value, session)) {
      return value;
    }
    const kind = positionalKind(entry, index);
    const title = positionalTitle(schema, index);
    return kind && title && TARGET_KINDS.has(kind)
      ? pinTarget(
          entry,
          value,
          kind,
          title,
          index === 0 && positional.length > 1,
          session,
        )
      : value;
  });
}
